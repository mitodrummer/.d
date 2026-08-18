#!/usr/bin/env bash
# Advertise the macOS VM subnet as a Tailscale subnet route FROM THE MAC, so
# other tailnet devices on the same physical network (e.g. your phone) reach
# the in-sandbox dev servers DIRECTLY over the LAN instead of through a relay.
#
# This is the FAST same-network path: phone → Mac → VM all over local Ethernet/
# Wi-Fi, no DERP relay hop. It complements the in-sandbox `tailscale serve`
# (../sandbox-tailnet-up.sh, patched into the session), which is reachable from anywhere but is
# relay-bound and slower for chatty dev traffic (HMR, large bundles).
#
# Run this ON THE MAC (the host), not in the sandbox. It lives in host/ for
# exactly that reason: the loadout names each patched file individually, and
# nothing under host/ is on that list, so a macOS-only script can never land in
# the sandbox where it could only fail confusingly. The macOS VM bridge hands
# every sandbox an address in a stable `192.168.64.0/24`, so the route never
# changes across sandbox rebuilds — that's why a single advertised /24 covers
# every sandbox and there's no per-rebuild IP discovery.
#
# Usage:
#   ~/.config/minimal/loadouts/tailnet-dashboard.d/host/setup-sandbox-tailnet.sh          # advertise the VM subnet route
#   ~/.config/minimal/loadouts/tailnet-dashboard.d/host/setup-sandbox-tailnet.sh set      # same as default
#   ~/.config/minimal/loadouts/tailnet-dashboard.d/host/setup-sandbox-tailnet.sh remove   # stop advertising it
#   ~/.config/minimal/loadouts/tailnet-dashboard.d/host/setup-sandbox-tailnet.sh status   # print advertised routes
set -euo pipefail

# macOS VM bridge subnet (stable /24 — see header). Every sandbox lands here.
VM_SUBNET="192.168.64.0/24"

# Resolve the Tailscale CLI: the GUI app ships the binary inside the bundle and
# does NOT add it to PATH, so fall back to the app bundle and the common
# Homebrew prefixes (Apple Silicon, then Intel) before giving up.
resolve_tailscale() {
  local candidate
  if candidate="$(command -v tailscale 2>/dev/null)"; then
    echo "$candidate"
    return 0
  fi
  for candidate in \
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
    "/opt/homebrew/bin/tailscale" \
    "/usr/local/bin/tailscale"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  echo "Error: tailscale CLI not found. Install the Tailscale macOS app or 'brew install tailscale'." >&2
  return 1
}

print_one_time_steps() {
  cat >&2 <<EOF

One-time approval (only after the FIRST 'set'):
  1. Admin console → Machines → this Mac → approve the advertised
     ${VM_SUBNET} subnet route (https://login.tailscale.com/admin/machines).
  2. On the phone (and any other client that should take the fast path),
     enable "Use Tailscale subnets" in the app settings.

Then open the sandbox dashboard (http://sandbox:4320) and use its
"Direct (fast)" http://<vm-ip>:<port> links from a same-network device.
EOF
}

cmd_set() {
  local ts
  ts="$(resolve_tailscale)" || exit 1
  # `tailscale set` is the modern, non-disruptive way to change advertised
  # routes; older clients only honor it via `tailscale up`. Try `set` first,
  # fall back to `up` so this works across CLI versions.
  if ! "$ts" set --advertise-routes="$VM_SUBNET"; then
    "$ts" up --advertise-routes="$VM_SUBNET"
  fi
  echo "Advertising $VM_SUBNET as a subnet route from this Mac." >&2
  print_one_time_steps
}

cmd_remove() {
  local ts
  ts="$(resolve_tailscale)" || exit 1
  # Empty --advertise-routes clears ALL advertised routes on this node. The Mac
  # subnet router exists only to reach the dev VM, so it carries no other route
  # worth preserving — clearing is the intended teardown.
  if ! "$ts" set --advertise-routes=; then
    "$ts" up --advertise-routes=
  fi
  echo "Stopped advertising subnet routes from this Mac." >&2
}

cmd_status() {
  local ts
  ts="$(resolve_tailscale)" || exit 1
  command -v jq >/dev/null 2>&1 || {
    echo "Error: jq not found — needed to read advertised routes ('brew install jq')." >&2
    return 1
  }
  # AllowedIPs carries the routes control has APPROVED for this node (plus its
  # own /32s), not everything it advertises — so right after `set`, and before
  # the admin-console approval, this correctly prints only the /32s. An empty
  # field is non-fatal; the message below still informs.
  echo "Approved routes for this Mac (only /32s until the subnet route is approved):"
  "$ts" status --json 2>/dev/null \
    | jq -r '.Self.AllowedIPs // [] | .[]' \
    || echo "(could not read routes; is tailscaled running?)"
}

case "${1:-set}" in
  set) cmd_set ;;
  remove) cmd_remove ;;
  status) cmd_status ;;
  -h|--help)
    echo "Usage: $0 [set|remove|status]" >&2
    exit 0
    ;;
  *)
    echo "Error: unknown subcommand '${1}'." >&2
    echo "Usage: $0 [set|remove|status]" >&2
    exit 2
    ;;
esac
