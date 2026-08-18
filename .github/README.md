# .d — kg's dotfiles

Configuration for a [Minimal](https://minimal.dev)-based development
environment, built around **composable session loadouts**: the personal layer
(editor, multiplexer, tailnet), the coding agent, and the sandbox dashboard
are separate loadouts that stack per activation — so swapping Claude Code for
another agent, or running without the dashboard, is a flag change, not a
config edit.

## Layout

Paths mirror `$HOME` (this is a bare-repo dotfiles setup, see below):

| Path | What |
| --- | --- |
| `.config/minimal/config.toml` | `default_loadouts` + client settings |
| `.config/minimal/loadouts/` | The loadouts — see [its README](../.config/minimal/loadouts/README.md) |
| `.config/minimal/loadouts/tailnet-dashboard.d/` | Userspace tailnet + in-sandbox discovery dashboard (scripts, server, tests) — see [its README](../.config/minimal/loadouts/tailnet-dashboard.d/README.md) |
| `.claude/skills/` | Project-agnostic Claude Code skills, patched into sessions by the `agent-claude` loadout |
| `.claude/settings.json` | Claude Code preferences (model, effort) |
| `.vimrc`, `.config/zellij/config.kdl` | Editor + multiplexer config the `dev` loadout patches in |

## The bare-repo pattern

Files are tracked **in place** at their real `$HOME` paths — no symlinks. That
matters for Minimal: loadout patch sources are resolved with
`follow_symlinks = false`, so symlinked dotfiles would silently drop out of
sessions. Setup:

```sh
git clone --bare https://github.com/mitodrummer/.d.git ~/.d
alias dot='git --git-dir=$HOME/.d --work-tree=$HOME'
dot config status.showUntrackedFiles no
dot checkout        # materializes tracked files into $HOME — review first!
```

Day-to-day: `dot status`, `dot add <file>`, `dot commit`, `dot push`.

## Adopting pieces of this

Everything here is personal config — fork and edit rather than use verbatim.
The pieces most worth stealing:

- **The loadout split** (`.config/minimal/loadouts/README.md`): agent-agnostic
  `dev` + one loadout per coding agent, selected via the `DEV_AGENT_CMD` var.
- **The tailnet-dashboard loadout**: a userspace tailnet join plus a
  discovery dashboard that `tailscale serve`s every healthy dev-server port
  it finds. Works with any web project that writes the documented pidfiles
  and serves a health endpoint — not Astro-specific. Its README covers
  integration knobs (`SANDBOX_DASHBOARD_*`).

Secrets never live here: tokens travel through the environment
(`GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`), stay in gitignored `.env.local`
files, or — for the tailnet key — sit in gitignored
`~/.config/minimal/secrets/` and are patched into the session from there.
The loadouts document that contract inline.

## Roadmap

- Rebuild the dashboard as a small static binary packaged in the
  [gominimal/pkgs](https://github.com/gominimal/pkgs) catalog, so loadouts
  declare `packages = ["sandbox-dashboard"]` with content-addressed
  provenance instead of patching TypeScript files.
- Loadout sharing on minimal.dev: browse/publish/like community loadouts.
