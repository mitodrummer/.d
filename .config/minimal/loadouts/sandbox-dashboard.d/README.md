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

Contract with a discoverable project: its dev-server launcher writes
`${TMPDIR:-/tmp}/minimal-dev-<port>.pid` (or legacy in-worktree
`.dev[-<port>].pid`) pidfiles and serves `GET /healthcheck` → 200. The webapp's
`scripts/dev.sh` conforms.

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
