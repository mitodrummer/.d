---
name: sandbox-dashboard
description: Integrate a project with the in-sandbox discovery dashboard (:4320) or triage why a dev server isn't showing on it. Use when wiring a new project's dev launcher into dashboard discovery, when a running server is missing from the dashboard, when a row shows a dead link, or when configuring SANDBOX_DASHBOARD_* vars in the sandbox-dashboard loadout.
---

The sandbox dashboard is a single HTTP server per sandbox (default `:4320`,
served by the `sandbox-dashboard` loadout from
`~/.local/lib/sandbox-dashboard/`) that lists every running dev server across
the git worktrees of the project in its working directory. It is
framework-agnostic: discovery is a contract, not an integration.

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
for the assigned-issues section; `""` disables it), `SANDBOX_DASHBOARD_START_HINT`
(empty-state copy), `SANDBOX_DASHBOARD_PORT`.

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

## Dead or missing tailnet links

Row exists but `http://sandbox:<port>` fails: the tailnet serve step maps a
fixed port list before worktree servers register theirs — re-run
`bash ~/.local/bin/sandbox-tailnet-up.sh` (idempotent) after starting new
servers, and trust the settled node name in `<repo-root>/.tailscale/node-name`
over the literal `sandbox` (MagicDNS dedupes to `sandbox-1`, … under
concurrent sessions).

## Public shares (cloudflared)

"Share" opens a public unauthenticated tunnel to that port — flagged PUBLIC in
red. A share stuck at "starting…" is usually DNS propagation (the dashboard
withholds the URL until the hostname resolves, deliberately). Orphan tunnels
(server gone, tunnel alive) are listed with a Stop button — stop them; they
are live public exposure.
