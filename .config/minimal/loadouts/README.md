# Loadouts

Composable [Minimal session loadouts](https://minimal.dev/docs/concepts/loadouts).
Loadouts stack as peers per activation; these four are designed to be
combined, and `../config.toml` applies three of them by default:

```toml
default_loadouts = ["sandbox-dashboard", "dev", "agent-claude"]
```

| Loadout | Carries |
| --- | --- |
| `sandbox-dashboard` | The `:4320` discovery dashboard ([code + docs](./sandbox-dashboard.d/README.md)): patches the runtime files into the session, starts the server on activation |
| `dev` | The agent-agnostic personal layer: vim/zellij/fzf, dotfiles, gh credential wiring, userspace tailnet (`dev.d/`), and the attach-time session hook |
| `agent-claude` | Claude Code as the session's coding agent: package, prefs + skills patches, onboarding seed |
| `agent-pi` | [Pi](https://pi.dev) as the coding agent instead |

## The agent seam: `DEV_AGENT_CMD`

`dev` owns the zellij layout but not the agent in it. Each agent loadout
contributes a `DEV_AGENT_CMD` var; `dev.d/minimal-session-hook` splits it
into argv and builds the layout's agent pane from it (no var → shell-only
layout). Because two loadouts setting one var is an activation-failing
conflict in Minimal, applying `agent-claude` and `agent-pi` together fails
fast — exactly the "one agent at a time" invariant, enforced by the composer
rather than by convention.

Swap agents without editing config (`--loadout` ignores the defaults list):

```sh
min activate --loadout sandbox-dashboard --loadout dev --loadout agent-pi
```

## Ordering

`sandbox-dashboard` must precede `dev` wherever both apply: hooks concatenate
in loadout order, and dev's tailnet hook runs `tailscale serve` over a fixed
port list that includes the dashboard's `:4320` — the listener has to exist
by then. Project hooks always run before loadout hooks, so the project's dev
servers are already up when either fires.

## Adopting these

They're personal — fork and adjust:

- Patch `source` paths point at this checkout's real locations (`~/.config/...`);
  keep files at real paths (no symlinks) or set `follow_symlinks = true`.
- Credentials travel through the environment, never through patched files:
  `GH_TOKEN` (dev), `CLAUDE_CODE_OAUTH_TOKEN` (agent-claude), provider API
  keys (agent-pi), `TS_AUTHKEY` (tailnet). Each loadout documents its own.
- The dashboard's project-facing knobs (`SANDBOX_DASHBOARD_ASSIGNEE`,
  `SANDBOX_DASHBOARD_HEALTH_PATH`, `SANDBOX_DASHBOARD_START_HINT`) are set
  from `sandbox-dashboard.toml` `[vars]` — see its README.
