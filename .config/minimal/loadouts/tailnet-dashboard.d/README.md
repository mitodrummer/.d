# tailnet-dashboard

Sandbox networking + discovery as one loadout, built from two cooperating
components:

- **Userspace tailnet** (`sandbox-tailnet-up.sh`): joins the Tailscale
  tailnet as an ephemeral node named `sandbox` (deduped to `sandbox-1`, …
  under concurrent sessions; the settled name lands in
  `<repo-root>/.tailscale/node-name`). Userspace-networking mode because the
  sandbox is unprivileged (no `/dev/net/tun`); web-serve only, no SSH.
- **Discovery dashboard** (`sandbox-dashboard.ts`, default `:4320`): one HTTP
  server per sandbox listing every running worktree dev server of the project
  in its working directory — tailnet/direct links, opt-in public cloudflared
  shares, assigned GitHub issues — and, as the component that knows which
  ports are live, the **serve reconciler** (`tailnet-serve.ts`): it issues
  `tailscale serve` for its own port and every healthy dev-server port on a
  10s loop, skipping silently until the join lands. No project code and no
  hook ordering is involved in exposure.

Each half degrades independently: without `TS_AUTHKEY` the dashboard is
local-only; without the dashboard the node is joined but nothing is served.

The dashboard was extracted from `gominimal/webapp` (formerly
`scripts/sandbox-dashboard.ts` + `src/lib/dashboard/`), and the per-port
serve call was extracted from its `scripts/dev.sh` — both are personal
tooling, not project infrastructure. The webapp original validated external
input with zod; this copy hand-rolls the same fail-closed guards because it
runs as bare files patched into a session with no node_modules. Everything at
runtime is node builtins only.

## Tailnet auth

`sandbox-tailnet-up.sh` no-ops without `TS_AUTHKEY` (env, or a
`TS_AUTHKEY=` line in the project's `.env.local`). Preferred form: a
Tailscale **OAuth client secret** (`tskey-client-…`, scope `auth_keys`, tag
`tag:sandbox`) — never expires, mints a fresh ephemeral key per join so dead
nodes self-deregister. A tagged ephemeral+reusable auth key works too but
expires within 90 days. Full details in the script header.

One-time host-side setup for the fast same-network "direct" links (Mac subnet
router advertising the VM bridge subnet): `host/setup-sandbox-tailnet.sh`.

## Wiring

`../tailnet-dashboard.toml` patches the five dashboard runtime files into the
session at `~/.local/lib/sandbox-dashboard/` and the tailnet script at
`~/.local/bin/sandbox-tailnet-up.sh`, then starts the dashboard and runs the
join from its `on_activate` hooks. Hook cwd (the project root) is the
discovery anchor — `git worktree list`, pidfile cwd matching,
`.tailscale/node-name`, and the `.env.local` key fallback all resolve
against it.

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

Rows appear (and ports get tailnet-served) only when all three hold; the
dashboard must itself be started from the project's repo root. If the dev
server enforces a hostname allow-list (Vite does), it must accept the tailnet
names (`sandbox` … `sandbox-9`). PR/issue enrichment additionally wants `gh`
authenticated in the session.

## Configuration

Environment variables, typically set from the loadout's `[vars]`:

| Var | Default | Meaning |
| --- | --- | --- |
| `SANDBOX_DASHBOARD_PORT` | `4320` | Listen port |
| `SANDBOX_DASHBOARD_HEALTH_PATH` | `/healthcheck` | Liveness path probed on each discovered port |
| `SANDBOX_DASHBOARD_ASSIGNEE` | `agent-137` | GitHub login for the assigned-issues section; empty string disables the section and its `gh` calls |
| `SANDBOX_DASHBOARD_START_HINT` | `pnpm dev:start` | Command shown in the empty state |
| `TS_AUTHKEY` | unset | Tailnet join key (see above); unset → local-only |

## Development

Tests and typecheck run on the host (this directory is never patched into a
session wholesale — only the runtime files are):

```sh
pnpm install
pnpm test    # vitest; the /proc-scan test is Linux-only and skips on darwin
pnpm check   # tsc --noEmit
```
