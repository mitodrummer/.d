---
name: tailnet-rename-serve-rebuild
description: "Renaming the sandbox's tailnet node 404s all tailscale-served ports until serve is reset AND the dashboard restarts (its served-ports memo blocks re-adding)"
metadata: 
  node_type: memory
  type: project
  originSessionId: e0acc804-1264-442f-9957-30eab741f959
  modified: 2026-08-20T17:03:36.050Z
---

Observed 2026-08-20: after Karl renamed the sandbox node in the Tailscale admin console, every `tailscale serve`d port returned Go's default "404 page not found" — the serve handlers stay keyed to the hostname at registration time, so requests for the new name fall through.

**How to apply:** after a node rename, run `tailscale serve reset`, then restart the dashboard (`bash ~/.local/lib/sandbox-dashboard/dashboard.sh restart`) — the reset alone is not enough because tailnet-serve.ts memoizes already-served ports in-process and won't re-add them. Also update `~/.tailscale/node-name` to the new name so rendered links are right. Diagnostic tell: dashboard healthy on 127.0.0.1 but tailnet name 404s with the Go default body.
