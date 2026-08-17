# sandbox-dashboard

In-sandbox discovery dashboard: one HTTP server per sandbox (default :4320)
that lists every running worktree dev server of the project in its working
directory, with tailnet/direct links, opt-in public cloudflared shares, and
the open GitHub issues assigned to `agent-137`.

Extracted from `gominimal/webapp` (`scripts/sandbox-dashboard.ts`,
`scripts/dashboard.sh`, `src/lib/dashboard/`): it is personal tooling, not
project infrastructure, so it lives with the loadouts. The webapp original
validated external input with zod; this copy hand-rolls the same fail-closed
guards because it runs as bare files patched into a session, with no
node_modules to resolve packages from. Everything at runtime is node builtins
only.

## Wiring

`../sandbox-dashboard.toml` patches the four runtime files
(`dashboard.sh`, `sandbox-dashboard.ts`, `discover.ts`, `tunnels.ts`) into the
session at `~/.local/lib/sandbox-dashboard/` and starts the server from its
`on_activate` hook. The hook's working directory (the project root) is the
discovery anchor — `git worktree list`, pidfile cwd matching, and
`.tailscale/node-name` all resolve against it.

## Integrating with any project

The dashboard is not Astro- or framework-specific — it discovers anything
that honors a three-part contract:

1. **Pidfile** — the dev-server launcher writes
   `${TMPDIR:-/tmp}/minimal-dev-<port>.pid` containing the launcher's PID
   (a `setsid` group leader survives best; legacy in-worktree
   `.dev-<port>.pid` / `.dev.pid` forms are also honored).
2. **Health endpoint** — the server answers
   `GET http://127.0.0.1:<port>/healthcheck` with a 200 (path configurable,
   see below). Bind the recorded port exactly — configure your server to fail
   on a taken port rather than silently walking to another, or the probe will
   correctly refuse to attribute it.
3. **Worktree cwd** — the server process runs with its git worktree as cwd;
   discovery attributes servers to worktrees by `/proc/<pid>/cwd`.

Rows appear only when all three hold; the dashboard must itself be started
from the project's repo root (its cwd anchors `git worktree list`). PR/issue
enrichment additionally wants `gh` authenticated in the session.

## Configuration

Environment variables, typically set from the loadout's `[vars]`:

| Var | Default | Meaning |
| --- | --- | --- |
| `SANDBOX_DASHBOARD_PORT` | `4320` | Listen port |
| `SANDBOX_DASHBOARD_HEALTH_PATH` | `/healthcheck` | Liveness path probed on each discovered port |
| `SANDBOX_DASHBOARD_ASSIGNEE` | `agent-137` | GitHub login for the assigned-issues section; empty string disables the section and its `gh` calls |
| `SANDBOX_DASHBOARD_START_HINT` | `pnpm dev:start` | Command shown in the empty state |

The `$TMPDIR/agent137-assigned-issues.json` state file this server writes is
read by the webapp's `scripts/agent137-assigned-hook.sh` (UserPromptSubmit
hook); the hook self-guards to a no-op when the file is absent.

## Development

Tests and typecheck run on the host (this directory is never patched into a
session wholesale — only the four runtime files are):

```sh
pnpm install
pnpm test    # vitest; the /proc-scan test is Linux-only and skips on darwin
pnpm check   # tsc --noEmit
```
