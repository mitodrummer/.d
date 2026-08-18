---
name: sandbox-dashboard
description: Integrate a project with the in-sandbox discovery dashboard (:4320) or triage why a dev server isn't showing on it. Use when wiring a new project's dev launcher into dashboard discovery, when a running server is missing from the dashboard, when a row shows a dead tailnet link, or when configuring SANDBOX_DASHBOARD_* / TS_AUTHKEY vars in the tailnet-dashboard loadout.
---

The sandbox dashboard is a single HTTP server per sandbox (default `:4320`,
run by the `tailnet-dashboard` loadout from
`~/.local/lib/sandbox-dashboard/`) that lists every running dev server across
the git worktrees of the project in its working directory, and reconciles
`tailscale serve` for its own port plus every healthy dev-server port on a
10s loop (the loadout also owns the tailnet join itself, via
`~/.local/bin/sandbox-tailnet-up.sh`). It is framework-agnostic: discovery is
a contract, not an integration.

## Wiring a project into discovery

A dev server appears on the dashboard when ALL of the following hold. Make the
project's dev launcher do these:

1. Write `${TMPDIR:-/tmp}/minimal-dev-<port>.pid` containing the launcher PID
   (prefer a `setsid` group leader; the dashboard recovers the cwd from any
   surviving group member if the leader dies). Remove it on stop.
2. Serve the health endpoint with HTTP 200 on the recorded port. Default path
   `/healthcheck`; if the project uses another path, set
   `SANDBOX_DASHBOARD_HEALTH_PATH` in the loadout's `[vars]`.
3. Run the server with the worktree as its cwd, and make the server FAIL on a
   taken port rather than walk to a free one (e.g. Vite/Astro
   `server.strictPort: true`) — recorded port must equal listening port.

Optional knobs (loadout `[vars]`): `SANDBOX_DASHBOARD_ASSIGNEE` (GitHub login
for the assigned-issues section; unset = off — the code carries no default
login), `SANDBOX_DASHBOARD_START_HINT` (empty-state copy),
`SANDBOX_DASHBOARD_PORT`.

## Triage: server runs but no row appears

Discovery drops a candidate at the first failing gate, in this order —
check them in the same order:

1. **Worktree gate** — is the server's cwd a current worktree?
   `readlink /proc/<pid>/cwd` must exactly match a path in
   `git worktree list`, with no ` (deleted)` suffix (a removed worktree's
   orphan server is dropped by design — kill it).
2. **PID gate** — does the pidfile PID (or its process group) pass `kill -0`?
   A stale pidfile with a dead PID produces no row.
3. **Health gate** — does `curl -i http://127.0.0.1:<port><health-path>`
   return exactly 200 within ~1.5s? A wedged server (500s), a redirect, or a
   drifted port fails here. This is the gate that catches "the process is up
   but it isn't actually serving".

Dashboard-side checks: `bash ~/.local/lib/sandbox-dashboard/dashboard.sh
status` (is it running, from the right cwd?), `.../dashboard.sh logs 50`
(per-source discovery warnings), `curl -s :4320/manifest.json` (what it
actually sees). The dashboard must have been started from the project's repo
root — a dashboard started elsewhere discovers nothing.

## Agent surface: `/manifest.json`

Everything the page shows is JSON at `GET /manifest.json` (shape:
`{ worktrees: WorktreeRow[], assignedIssues: AssignedIssue[],
newAssignedIssueNumbers: number[], directHost: string | null, tailnetHost,
cloudflaredAvailable, orphanTunnels: TunnelInfo[] }`). A `WorktreeRow` is a
discovered dev server plus, when a public share is active, `tunnelUrl`
(resolved) or `tunnelPending: true` (URL still negotiating); `orphanTunnels`
carry the same `port`/`url` shape for shares whose dev server has since
stopped. Build each server's two URLs as
`http://<tailnetHost>:<port>` (works anywhere) and, when `directHost` is
non-null, `http://<directHost>:<port>` (fast, same network). The page itself
is discovery-only — it never proxies or rewrites URLs, because dev servers'
absolute asset paths, HMR WebSockets, and view transitions all break under a
path prefix.

## Tailnet setup and reachability

The loadout's `sandbox-tailnet-up.sh` joins the sandbox as a **userspace**
Tailscale node named `sandbox` (unprivileged: no `/dev/net/tun`, so
web-serve only — **there is no SSH into the sandbox**, Tailscale SSH needs
root). Auth: the loadout patches `~/.config/minimal/secrets/ts-authkey`
(host-side) to `~/.config/sandbox-tailnet/authkey` in-session; env
`TS_AUTHKEY` and a project `.env.local` line work as fallbacks. Prefer an
OAuth client secret (`tskey-client-…`, scope `auth_keys`, tag `tag:sandbox`)
— never expires, mints a fresh ephemeral key per join so dead nodes
self-deregister. The node's statedir is `~/.tailscale` (session-scratch; it
holds the node key and never touches the project tree). Ports are served
over **HTTP**, not https (the cert feature hangs). Full mechanics in the
script header.

One-time Mac-side setup so names resolve: Tailscale app → "Use Tailscale
DNS" ON; admin console → DNS → MagicDNS on, no unreachable global
nameserver (a dead one breaks all resolution).

Two ways to reach a dev server:

1. **Tailnet, anywhere** — `http://sandbox:<port>`. Works from any tailnet
   device, but relay-bound (DERP), so slower for chatty dev traffic (HMR,
   large bundles).
2. **Direct, fast, same network** — `http://<vm-ip>:<port>` (the sandbox's
   `192.168.64.x` address; the dashboard renders it per server, and it
   churns across rebuilds so never memorize it). Requires the Mac subnet
   router, set up once on the host:

   ```sh
   ~/.config/minimal/loadouts/tailnet-dashboard.d/host/setup-sandbox-tailnet.sh          # advertise 192.168.64.0/24
   ~/.config/minimal/loadouts/tailnet-dashboard.d/host/setup-sandbox-tailnet.sh status
   ~/.config/minimal/loadouts/tailnet-dashboard.d/host/setup-sandbox-tailnet.sh remove
   ```

   Then approve the advertised `192.168.64.0/24` route in the admin console
   (Machines) and enable "Use Tailscale subnets" on each client that should
   take the fast path. The /24 is stable across sandbox rebuilds, so one
   advertisement covers every sandbox.

If the target project's dev server enforces a hostname allow-list (Vite
does), it must admit the names this loadout exposes. The loadout exports
them as `DEV_EXTRA_ALLOWED_HOSTS` (comma-separated, includes
`.trycloudflare.com` for share tunnels); the webapp splices that env var
into `vite.server.allowedHosts` in `astro.config.ts` without knowing what
the names mean.

**Auth-gated flows via an alias hostname misbehave** (webapp example:
`BETTER_AUTH_URL` defaults to `http://localhost:4321`, so the session cookie
domain and the OAuth callback won't match `http://sandbox:4321`). Keep auth
work on `http://localhost:<port>`; pointing auth at the alias needs both the
base-URL env AND the OAuth app's callback list updated.

## Dead or missing tailnet links

Row exists but `http://sandbox:<port>` fails:

- A newly started server is tailnet-served by the dashboard's reconcile loop
  within ~10s of first passing the health gate — brief lag is normal.
- Trust the settled node name in `~/.tailscale/node-name` (session HOME)
  over the literal `sandbox` (MagicDNS dedupes to `sandbox-1`, … under
  concurrent sessions).
- No name resolves at all → the join itself hasn't happened: run
  `bash ~/.local/bin/sandbox-tailnet-up.sh` (idempotent; no-ops when it finds
  no key in `~/.config/sandbox-tailnet/authkey`, `TS_AUTHKEY`, or the
  project's `.env.local`).
- The dashboard serves ports only while it is running — check
  `dashboard.sh status` before suspecting the tailnet.

## Public shares (cloudflared)

"Share" opens a public unauthenticated tunnel to that port — flagged PUBLIC in
red. A share stuck at "starting…" is usually DNS propagation (the dashboard
withholds the URL until the hostname resolves, deliberately). Orphan tunnels
(server gone, tunnel alive) are listed with a Stop button — stop them; they
are live public exposure.
