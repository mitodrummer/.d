#!/usr/bin/env bash
# Join the running Minimal sandbox to the Tailscale tailnet as a userspace
# node named `sandbox`, then expose the dev servers by name via
# `tailscale serve`. Reach them from any tailnet device at
# http://sandbox:4321 (main) / http://sandbox:4320 (dashboard).
# Concurrent sessions: control dedupes the machine name (sandbox-1, -2, …);
# the settled name is recorded in <repo>/.tailscale/node-name and used for
# the serve registration and the dashboard's rendered URLs.
#
# The Minimal sandbox is fully unprivileged (uid 1000, no sudo, no
# /dev/net/tun), so tailscaled MUST run in userspace-networking mode and
# Tailscale SSH is impossible (it needs root) — this is web-serve only.
# The statedir under the project dir is SCRATCH, not persistence: nothing in a
# session survives its destruction, so each session registers a fresh node.
# That is why TS_AUTHKEY must be an EPHEMERAL key — the node deregisters itself
# when the session ends, instead of leaving a dead `sandbox` behind every time.
#
# Auth is TS_AUTHKEY (env or .env.local), in either form:
#   - PREFERRED: an OAuth client secret (`tskey-client-...`) with the
#     `auth_keys` scope and tag:sandbox. Client secrets never expire; each
#     `up` mints a fresh tagged key on the fly, and `ephemeral` DEFAULTS TO
#     TRUE for OAuth-minted keys, so the disposable-node design holds with no
#     query params. Append `?preauthorized=true` if the tailnet uses device
#     approval. Requires --advertise-tags (passed below).
#   - a tagged auth key (`tskey-auth-...`, tag:sandbox, ephemeral, reusable).
#     Works, but expires (90-day ceiling), which resurfaces the interactive
#     OAuth dance on every fresh session once it does.
# The script no-ops (exit 0) when the key is absent so a keyless sandbox
# still boots.
#
# Usage: scripts/sandbox-tailnet-up.sh [up|status|down]   (default: up)
set -euo pipefail

# The project directory — where .env.local (TS_AUTHKEY) and the .tailscale
# state dir live.
#
# This used to be derived from the script's own location ($SCRIPT_DIR/..), which
# was right while it lived at <repo>/scripts/. The script now ships in a loadout
# and is patched into the session at ~/.local/bin/, where that expression
# resolves to ~/.local — so the auth key was never found and the tailnet came up
# as a silent no-op. The invoking hook runs with the project root as cwd, so use
# that; SANDBOX_TAILNET_REPO_ROOT overrides it for a standalone run elsewhere.
REPO_ROOT="${SANDBOX_TAILNET_REPO_ROOT:-$PWD}"

# Identity/cert dir for the CURRENT session only — it does not survive session
# destruction (see the header). Gitignored: it holds the node key and must never
# be committed, nor carried in from the host, which is how a months-old RunSSH
# pref once leaked into every session. Use a directory (--statedir), NOT a
# single --state file: the file form errors with "no var root".
STATE_DIR="$REPO_ROOT/.tailscale"
# Runtime control socket, recreated on each sandbox boot. Must match
# TS_SOCK in scripts/dev.sh so the worktree launcher targets the same daemon.
SOCK="/tmp/ts/tailscaled.sock"

# Dev-server ports exposed by name. 4320 = discovery dashboard, 4321 = main.
SERVE_PORTS=(4320 4321)

ts() { tailscale --socket="$SOCK" "$@"; }

# Load TS_AUTHKEY from .env.local when not already exported, so a standalone
# run works without the dev entry pre-exporting it. Grep only that one var (no
# blanket `source`, which would pull every secret into this shell) and NEVER
# print the value.
load_authkey_from_env_file() {
  [ -n "${TS_AUTHKEY:-}" ] && return 0
  local env_file="$REPO_ROOT/.env.local"
  [ -f "$env_file" ] || return 0
  # Strip the key= prefix, then a trailing ` # inline comment` (auth keys never
  # contain whitespace or `#`), then a single pair of surrounding quotes.
  # `|| true`: a no-match grep returns non-zero, which would abort the whole
  # script under `set -e`/`pipefail` instead of falling through to the
  # empty-key no-op in cmd_up.
  TS_AUTHKEY="$(grep -E '^TS_AUTHKEY=' "$env_file" | head -1 \
    | sed -E 's/^TS_AUTHKEY=//; s/[[:space:]]*#.*$//; s/^["'"'"']//; s/["'"'"']$//' || true)"
  export TS_AUTHKEY
}

ensure_installed() {
  command -v tailscaled >/dev/null 2>&1 && return 0
  echo "tailscaled not found on PATH; installing via 'min add tailscale'..." >&2
  min add tailscale
}

# Start tailscaled in userspace mode if it isn't already running, then poll the
# control socket until it answers. A status query exits non-zero with "Logged
# out"/"NeedsLogin" once the socket is up but before `up` runs — that still
# means the daemon is reachable, so treat those as ready too.
#
# Daemon-on-OUR-socket: a `tailscaled` bound to a different socket (orphan, or
# still initializing) doesn't help us, so the readiness test always goes
# through `ts status` (which targets $SOCK) rather than a bare process check —
# otherwise we'd skip the start and `ts up` would fail on a missing socket.
ts_socket_ready() {
  local out
  out="$(ts status 2>&1)" && return 0
  printf '%s' "$out" | grep -qiE 'logged out|needslogin|stopped'
}

ensure_daemon() {
  ts_socket_ready && return 0
  mkdir -p /tmp/ts "$STATE_DIR"
  # A socket file that exists but doesn't answer is stale (crashed daemon);
  # leaving it would make the fresh tailscaled fail to bind and the poll below
  # time out with a misleading "did not become ready" message. Clear it first.
  [ -S "$SOCK" ] && { echo "Removing stale tailscaled socket..." >&2; rm -f "$SOCK"; }
  echo "Starting tailscaled (userspace-networking)..." >&2
  nohup tailscaled \
    --tun=userspace-networking \
    --statedir="$STATE_DIR" \
    --socket="$SOCK" \
    >/tmp/ts/tailscaled.log 2>&1 &
  for _ in $(seq 1 20); do
    ts_socket_ready && return 0
    sleep 0.5
  done
  echo "Error: tailscaled socket did not become ready (see /tmp/ts/tailscaled.log)." >&2
  return 1
}

# Expose one localhost port by name over HTTP (NOT https — https needs the
# tailnet cert feature and hangs). Idempotent; guarded by a timeout so a
# transient serve hang can't block dev startup.
serve_port() {
  local port="$1"
  # Not `timeout 20 ts serve`: timeout can't exec the ts() shell function (127).
  if timeout 20 tailscale --socket="$SOCK" serve --bg --http="$port" "localhost:$port" >/dev/null 2>&1; then
    echo "Serving :$port → http://${NODE_NAME:-sandbox}:$port" >&2
  else
    echo "Note: 'tailscale serve' for :$port failed or timed out (non-fatal)." >&2
  fi
}

# Authenticate this tailscaled to the tailnet. NOT idempotent with an OAuth
# client secret: every `up` authenticates with a freshly minted key, which
# control registers as a NEW machine — bumping the deduped machine name
# (sandbox-1 → sandbox-2 → …). cmd_up only calls this when the daemon is not
# already logged in, so re-attaches and hook re-runs keep the node identity.
join_tailnet() {
  # Across sessions the statedir is gone, so each new session registers a
  # fresh node (ephemeral, so dead ones are reaped).
  # No --ssh (impossible rootless) and no --accept-routes (unneeded; avoids
  # routing interference).
  #
  # The tailscale CLI does NOT read TS_AUTHKEY from the environment — that is
  # a containerboot/Docker convention, and relying on it here is why every
  # join silently fell back to interactive OAuth. `up` only takes --auth-key;
  # a bare value would land in /proc/<pid>/cmdline where a co-tenant could
  # read it, so the key is handed over via the documented `file:` form on a
  # 0600 tmpfile (mktemp's default mode), removed as soon as `up` returns.
  #
  # `--reset` makes THIS command the authoritative description of the node's
  # prefs. Without it, `up` refuses to start whenever the statedir holds a
  # non-default pref this line doesn't restate:
  #
  #   Error: changing settings via 'tailscale up' requires mentioning all
  #   non-default flags ... tailscale up --hostname=sandbox --ssh
  #
  # That is exactly what happened when a stale host-side statedir was synced
  # into sessions carrying RunSSH from a months-old manual run. Since the
  # intended prefs are precisely "hostname=sandbox, everything else default",
  # resetting is the correct semantic here, not a workaround — it also stops a
  # hand-run `tailscale up` from wedging the next automated boot.
  # Bounded like serve_port below: `up` blocks retrying while the coordination
  # server is unreachable, and when this runs from a session's on_activate
  # lifecycle hook, outliving the hook's timeout would fail the activation
  # itself rather than just skipping the tailnet.
  #
  # --advertise-tags is MANDATORY when TS_AUTHKEY is an OAuth client secret
  # (the minted key carries whatever tags are advertised); with a legacy
  # tagged auth key it is a no-op restatement of the key's own tag.
  #
  # Spelled out rather than `timeout 30 ts up`: timeout is an external binary
  # and cannot exec the ts() shell function — that form dies with 127 before
  # tailscale ever runs.
  local keyfile
  keyfile=$(mktemp /tmp/ts/authkey.XXXXXX)
  # ${keyfile:-}: the EXIT trap fires at top level, where the function-local
  # is already gone — a bare $keyfile there trips `set -u` and fails the exit.
  trap 'rm -f "${keyfile:-}"' EXIT
  printf '%s' "$TS_AUTHKEY" >"$keyfile"
  if ! timeout 30 tailscale --socket="$SOCK" up --reset --hostname=sandbox \
      --advertise-tags=tag:sandbox --auth-key="file:$keyfile"; then
    echo "Error: 'tailscale up' failed or timed out; skipping tailnet exposure." >&2
    exit 1
  fi
  rm -f "$keyfile"
}

cmd_up() {
  load_authkey_from_env_file
  if [ -z "${TS_AUTHKEY:-}" ]; then
    echo "TS_AUTHKEY unset; skipping Tailscale sandbox join (set it in .env.local to enable)." >&2
    exit 0
  fi
  ensure_installed
  ensure_daemon
  # `status` exits non-zero until the node is logged in and running; once it
  # succeeds, re-running `up` would change the node identity (see
  # join_tailnet), so skip the join and just refresh the name file + serves.
  if ! tailscale --socket="$SOCK" status --peers=false >/dev/null 2>&1; then
    join_tailnet
  fi

  # Control dedupes the requested hostname when several sessions are on the
  # tailnet at once (sandbox, sandbox-1, …), and `serve` pins its vhost to the
  # node's self-view at registration time — serving before the deduped name
  # arrives in the netmap 404s every request addressed to the real name. Wait
  # for the name to settle, and record it for other consumers (the sandbox
  # dashboard renders its per-port tailnet URLs from the node-name file).
  NODE_NAME=""
  for _ in $(seq 1 20); do
    NODE_NAME=$(tailscale --socket="$SOCK" status --peers=false 2>/dev/null |
      awk 'NR==1 && $2 ~ /^[a-z0-9][a-z0-9-]*$/ { print $2 }')
    [ -n "$NODE_NAME" ] && break
    sleep 0.5
  done
  if [ -z "$NODE_NAME" ]; then
    NODE_NAME="sandbox"
    echo "Warning: MagicDNS name did not settle; assuming '$NODE_NAME'." >&2
  fi
  printf '%s\n' "$NODE_NAME" >"$STATE_DIR/node-name"
  echo "Tailnet node '$NODE_NAME' up (userspace, web-serve only — no SSH)." >&2

  for port in "${SERVE_PORTS[@]}"; do
    serve_port "$port"
  done
}

cmd_status() {
  ts status || true
  for port in "${SERVE_PORTS[@]}"; do
    echo "http://sandbox:$port"
  done
}

cmd_down() {
  # `ts down` disconnects the node from the tailnet but leaves tailscaled
  # running and the socket present — to kill the daemon outright,
  # `kill $(pgrep -x tailscaled)`.
  # No socket → daemon never started (keyless sandbox, or already down);
  # `ts down` would hard-fail, so treat the absent-socket case as a no-op.
  [ -S "$SOCK" ] || { echo "tailscaled not running; nothing to bring down." >&2; return 0; }
  # A stale socket (daemon crashed) passes the -S test but `ts down` can't
  # connect; fail soft so `set -e` doesn't abort on a raw tailscale error.
  ts down || { echo "Warning: 'tailscale down' failed (stale socket?). See /tmp/ts/tailscaled.log." >&2; return 0; }
}

case "${1:-up}" in
  up) cmd_up ;;
  status) cmd_status ;;
  down) cmd_down ;;
  -h|--help)
    echo "Usage: $0 [up|status|down]" >&2
    exit 2
    ;;
  *)
    echo "Error: unknown subcommand '${1}'." >&2
    echo "Usage: $0 [up|status|down]" >&2
    exit 2
    ;;
esac
