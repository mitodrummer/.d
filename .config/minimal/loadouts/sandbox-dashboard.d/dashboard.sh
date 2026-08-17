#!/usr/bin/env bash
# Sandbox dashboard manager — start/stop/status/logs/restart for the in-sandbox
# discovery service that lists every running worktree dev server on a single
# landing page (default :4320). Mirrors the webapp's scripts/dev.sh shape so
# muscle memory works the same.
#
# Personal tooling: this launcher and the server it starts are patched into
# the session by the sandbox-dashboard loadout, not shipped by any project.
# `start` MUST run with the project checkout as the working directory — the
# server anchors discovery (git worktree list, .tailscale/node-name) on its
# cwd. The loadout's on_activate hook satisfies this (hooks run from the
# project root); so does the re-attach fallback in the dev loadout's
# minimal-session-hook.
#
# Logs + pidfile live under ${TMPDIR:-/tmp} (minimal-dashboard.{log,pid}):
# nothing personal is written into the project tree, and the project dir is
# bind-mounted + overlaid in the dev sandbox, where create-then-delete churn
# leaves whiteout entries that eventually make `readdir()` return ESTALE.
# Configurable port via SANDBOX_DASHBOARD_PORT (default 4320).
#
# Usage:
#   dashboard.sh {start|stop|status|logs [N]|restart}

set -euo pipefail

PORT="${SANDBOX_DASHBOARD_PORT:-4320}"
PID_DIR="${TMPDIR:-/tmp}"
# A custom $TMPDIR may not exist yet; ensure it before the first write so
# `set -e` doesn't abort.
mkdir -p "$PID_DIR"
LOG_FILE="${PID_DIR}/minimal-dashboard.log"
PID_FILE="${PID_DIR}/minimal-dashboard.pid"
# The server sits next to this launcher (both are patched in together), so
# resolve it from this file's own directory — absolute, which also makes the
# is_dashboard_pid cmdline match unambiguous.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/sandbox-dashboard.ts"

# Verify a PID is not just alive but is actually *our* dashboard process.
# PIDs are recycled, so a bare `kill -0` can match an unrelated process that
# inherited a stale pidfile's PID — which would make `start` refuse to run or
# `stop` kill the wrong process. Confirm the command line still references the
# dashboard script before trusting the PID.
#
# Identity is read from /proc/<pid>/cmdline (the sandbox + CI run Linux, and
# `ps` is not on PATH there). A `ps` fallback covers macOS operators running
# the script directly on the host.
pid_cmdline() {
  local pid="$1"
  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' ' ' < "/proc/$pid/cmdline"
  elif command -v ps >/dev/null 2>&1; then
    ps -p "$pid" -o command= 2>/dev/null
  else
    return 1
  fi
}

is_dashboard_pid() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local cmd
  cmd="$(pid_cmdline "$pid")" || return 1
  [[ "$cmd" == *"$SCRIPT_PATH"* ]]
}

start() {
  if [ -f "$PID_FILE" ] && is_dashboard_pid "$(cat "$PID_FILE")"; then
    echo "Dashboard already running on :$PORT (PID $(cat "$PID_FILE"))"
    echo "Logs: tail -f $LOG_FILE"
    return 0
  fi
  rm -f "$PID_FILE"
  echo "Starting dashboard on :$PORT..."
  SANDBOX_DASHBOARD_PORT="$PORT" node "$SCRIPT_PATH" > "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  # The dashboard binds synchronously; if node aborts (syntax error, port
  # already bound) it'll be gone well before this sleep elapses. Verify
  # liveness so the operator sees the real failure instead of a stale
  # "started" line.
  sleep 0.3
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "Dashboard failed to start (see $LOG_FILE for details)." >&2
    return 1
  fi
  echo "Dashboard started on :$PORT (PID $pid)"
  echo "Logs: tail -f $LOG_FILE"
}

stop() {
  if [ ! -f "$PID_FILE" ]; then
    echo "No PID file found for dashboard"
    return 0
  fi
  local pid
  pid=$(cat "$PID_FILE")
  if ! is_dashboard_pid "$pid"; then
    echo "Dashboard process $pid not running"
    rm -f "$PID_FILE"
    return 0
  fi
  kill "$pid"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    is_dashboard_pid "$pid" || break
    sleep 0.1
  done
  if is_dashboard_pid "$pid"; then
    # Graceful SIGTERM didn't take within ~1s; escalate to SIGKILL.
    kill -9 "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      is_dashboard_pid "$pid" || break
      sleep 0.1
    done
  fi
  if is_dashboard_pid "$pid"; then
    # Still alive after SIGKILL — report the failure and keep the pidfile so a
    # retry (or the operator) can act on it rather than losing track of the PID.
    echo "Error: failed to stop dashboard (PID $pid still alive after SIGKILL)." >&2
    return 1
  fi
  echo "Dashboard on :$PORT stopped (PID $pid)"
  rm -f "$PID_FILE"
}

status() {
  if [ -f "$PID_FILE" ] && is_dashboard_pid "$(cat "$PID_FILE")"; then
    echo "Running on :$PORT (PID $(cat "$PID_FILE"))"
  else
    echo "Stopped (:$PORT)"
    rm -f "$PID_FILE" 2>/dev/null
  fi
}

logs() {
  if [ -f "$LOG_FILE" ]; then
    tail -n "${1:-50}" "$LOG_FILE"
  else
    echo "No log file found for dashboard"
  fi
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  status)  status ;;
  logs)    logs "${2:-50}" ;;
  restart) stop; start ;;
  *)
    echo "Usage: dashboard.sh {start|stop|status|logs [N]|restart}" >&2
    exit 1
    ;;
esac
