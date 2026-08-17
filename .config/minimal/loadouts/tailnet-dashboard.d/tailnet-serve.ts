// Tailnet serve reconciliation.
//
// The dashboard is the one component that already knows, on a short loop,
// which ports are live — so it owns exposing them by name over the tailnet.
// This replaced two older serve paths: the webapp's scripts/dev.sh
// `serve_on_tailnet()` (each launcher served its own port at start, which
// meant the project carried tailnet code) and the tailnet script's fixed
// SERVE_PORTS loop (which had to hardcode the dashboard/main ports and made
// loadout hook ordering load-bearing). Serve semantics are preserved from
// both: plain HTTP (https needs the tailnet cert feature and hangs),
// `--bg`, idempotent, bounded, non-fatal, and a silent skip while the
// userspace tailscaled socket is absent — reconciliation self-heals once the
// tailnet join lands, in whatever order the hooks ran.
//
// No un-serve on server death (parity with the old paths): a mapping to a
// dead port is harmless — the name resolves and the connection is refused —
// and it comes back to life when the port is reused.

import { constants } from "node:fs";
import { access } from "node:fs/promises";

// Runtime control socket of the loadout's userspace tailscaled — must match
// SOCK in sandbox-tailnet-up.sh (sibling file, patched in together).
export const TS_SOCK = "/tmp/ts/tailscaled.sock";

// Mirrors the 20s bound the shell paths used: a transient serve hang must
// not wedge the reconcile loop.
const SERVE_TIMEOUT_MS = 20_000;

/**
 * Run a command to completion, rejecting on non-zero exit, spawn failure, or
 * timeout. Tests inject a recorder; runtime uses {@link defaultRun}.
 */
export type RunFn = (cmd: string, args: readonly string[], timeoutMs: number) => Promise<void>;

const defaultRun: RunFn = async (cmd, args, timeoutMs) => {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err) => (err ? reject(err) : resolve()));
  });
};

async function defaultSocketExists(): Promise<boolean> {
  try {
    await access(TS_SOCK, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface TailnetServeDeps {
  run?: RunFn;
  socketExists?: () => Promise<boolean>;
}

// Ports successfully served this process lifetime. A serve mapping persists
// in the daemon, so re-issuing it every tick would be one exec per port per
// tick for nothing. The memo does mean a tailscaled restarted mid-session
// isn't re-fed until the dashboard restarts — same exposure the shell paths
// had (they served exactly once, at server start).
const served = new Set<number>();

/** Test-only: reset the served-ports memo. */
export function _resetServed(): void {
  served.clear();
}

/**
 * Ensure every port in `ports` is exposed by name over the tailnet.
 *
 * Skips silently while the tailscaled socket is absent (keyless sandbox, or
 * the join hasn't landed yet) — callers re-invoke on a loop, so exposure
 * catches up on its own. A port whose serve fails is retried on the next
 * call; only a successful serve is memoized.
 */
export async function ensureServed(
  ports: readonly number[],
  deps: TailnetServeDeps = {},
): Promise<void> {
  const run = deps.run ?? defaultRun;
  const socketExists = deps.socketExists ?? defaultSocketExists;
  const pending = ports.filter((p) => !served.has(p));
  if (pending.length === 0) return;
  if (!(await socketExists())) return;
  for (const port of pending) {
    try {
      await run(
        "tailscale",
        [`--socket=${TS_SOCK}`, "serve", "--bg", `--http=${port}`, `localhost:${port}`],
        SERVE_TIMEOUT_MS,
      );
      served.add(port);
    } catch {
      // Non-fatal; retried on the next reconcile pass.
    }
  }
}
