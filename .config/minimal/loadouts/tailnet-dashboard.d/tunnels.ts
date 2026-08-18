import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

// SECURITY: a cloudflared quick tunnel exposes a local, UNAUTHENTICATED dev
// server to the public internet behind an unguessable *.trycloudflare.com URL.
// Anyone who has (or guesses/observes) the URL reaches the dev server with no
// login. This module therefore never starts a tunnel on its own — tunnels are
// strictly opt-in per port (an operator clicks "Share"), the dashboard flags
// them as PUBLIC, and they are ephemeral: they die with the cloudflared process
// and are NOT persisted across a sandbox restart (the process, and with it the
// URL, is gone). The pidfile only lets a restarted dashboard rediscover and
// keep managing tunnels that are still running — it never resurrects one.

/**
 * Spawn a detached cloudflared quick tunnel for `port` and return its PID. The
 * child must outlive the dashboard process (so a dashboard restart doesn't tear
 * down live tunnels), so the real implementation spawns detached + unref'd with
 * stdout/stderr redirected to the tunnel's log file. Tests inject a stub.
 */
export type SpawnTunnelFn = (port: number, pidDir: string) => Promise<number>;

/** Whether an executable is resolvable on the current PATH. Tests inject a stub. */
export type CommandExistsFn = (cmd: string) => Promise<boolean>;

/**
 * Whether `pid` is still the cloudflared serving `port`.
 *
 * A bare `kill -0` is not enough: PIDs are recycled, so a stale pidfile can name
 * a live but unrelated process. That misread is harmful in both directions — it
 * makes startTunnel hand back a ghost tunnel instead of spawning a real one, and
 * it makes stopTunnel SIGTERM/SIGKILL a stranger. Mirrors the identity check in
 * dashboard.sh (`is_dashboard_pid`) and discover.ts.
 *
 * Matching on the binary name alone is NOT sufficient: a recycled PID can land
 * on a *different* cloudflared (another port's tunnel, or one started by hand),
 * and stopping port A would then kill port B's tunnel. The port must be part of
 * the identity, so this also matches the `--url` argument. Tests inject a stub.
 */
export type PidIsCloudflaredFn = (pid: number, port: number) => Promise<boolean>;

/**
 * What global DNS says about `host`. Tri-state on purpose: the two consumers
 * need OPPOSITE fail-safes for the ambiguous middle (probe timeout, SERVFAIL,
 * no egress to the probe resolvers).
 *
 * - "resolved":  the record is published — safe to surface the URL.
 * - "nxdomain":  an authoritative "no such name" from both A and AAAA.
 * - "ambiguous": the probe couldn't get an authoritative answer either way.
 *
 * The surface decision ({@link reachableUrl}) treats "ambiguous" as NOT
 * reachable — surfacing an unproven URL invites the first click to pin an
 * NXDOMAIN in the operator's resolver for trycloudflare.com's 1800s SOA
 * minttl, the exact poisoning this feature exists to prevent. The teardown
 * decision (startTunnel's revocation check) treats "ambiguous" as alive —
 * killing a healthy tunnel over a probe blip churns the operator's public
 * URL for nothing. One boolean cannot express both. Tests inject a stub.
 */
export type HostProbeResult = "resolved" | "nxdomain" | "ambiguous";
export type ProbeHostFn = (host: string) => Promise<HostProbeResult>;

export interface TunnelInfo {
  port: number;
  pid: number;
  /** The public URL, or null while cloudflared is still negotiating it. */
  url: string | null;
  alive: boolean;
}

export type StartTunnelResult =
  | { ok: true; tunnel: TunnelInfo }
  | { ok: false; reason: "not-installed" }
  | { ok: false; reason: "spawn-failed"; message: string };

// Pidfile/log naming mirrors scripts/dev.sh's `minimal-dev-<port>.pid`
// convention (files under $TMPDIR, off the bind-mounted project dir to avoid
// the overlayfs whiteout cascade documented there).
const TUNNEL_PIDFILE_RE = /^minimal-tunnel-(\d+)\.pid$/;

// cloudflared prints the quick-tunnel URL to stderr inside a boxed banner:
//   |  https://<random-words>.trycloudflare.com  |
// Match the first such URL in the captured log.
const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// Same bounds and rationale as discover.ts: a corrupt pidfile
// could carry an out-of-range port (a dead link) or a non-positive / absurd PID
// (`kill -0 0` probes the process group, not a real process — a ghost "alive"
// row). Bound both before trusting them.
const MIN_PORT = 1024;
const MAX_PORT = 65_535;
const MAX_PID = 2 ** 22; // Linux pid_max ceiling; comfortably above any real PID.

const CLOUDFLARED_BIN = "cloudflared";

/**
 * The local target a tunnel for `port` proxies to. Single source of truth: it
 * builds cloudflared's `--url` argument AND is matched back out of
 * `/proc/<pid>/cmdline` to bind a PID to its port, so the two cannot drift.
 */
function tunnelTargetUrl(port: number): string {
  return `http://localhost:${port}`;
}

// Bounded poll for the URL to appear in the log after spawn AND for its
// hostname to be published in DNS: cloudflared takes a few seconds to register
// the quick tunnel, and the record lands a moment after the URL is printed.
// 24 * 500ms = 12s. If neither has happened by then we return the tunnel with a
// null URL (pending); the dashboard's refresh loop re-reads the log and surfaces
// the URL once it lands and resolves.
const URL_POLL_ITERS = 24;
const URL_POLL_INTERVAL_MS = 500;

// Bounded wait for a killed cloudflared to actually exit before escalating
// SIGTERM → SIGKILL. 10 * 100ms = 1s, mirroring scripts/dev.sh's stop loop.
const STOP_POLL_ITERS = 10;
const STOP_POLL_INTERVAL_MS = 100;

// Public resolvers for the DNS probe, deliberately NOT the system resolver.
// "Is this hostname live in global DNS?" is a different question from "can this
// box resolve it right now?", and only the first one is evidence about the
// tunnel. Resolvers on the path to a dev box routinely negative-cache: a lookup
// issued in the seconds before Cloudflare publishes the record pins NXDOMAIN
// for trycloudflare.com's SOA minttl (1800s), long outliving the propagation
// gap that caused it. Probing through such a resolver reports every live tunnel
// as revoked, so startTunnel tears down a working tunnel and re-issues a new
// hostname — rotating the URL out from under whoever it was already shared with,
// and restarting the same race on the replacement.
const PROBE_RESOLVERS = ["1.1.1.1", "8.8.8.8"];
const PROBE_TIMEOUT_MS = 3_000;
const PROBE_TRIES = 2;

// Wall-clock bound on startTunnel's URL poll. The iteration count alone does
// NOT bound it: each pass can block on a DNS probe, and the probe's own worst
// case is PROBE_TIMEOUT_MS * PROBE_TRIES per lookup with up to two lookups on
// the NXDOMAIN-confirmation path (~12s). At 24 iterations that is minutes, not
// the 12s the poll constants describe. The deadline is checked between passes,
// so the true ceiling is this budget plus one in-flight probe — a pending DNS
// query can't be cancelled.
const URL_POLL_BUDGET_MS = URL_POLL_ITERS * URL_POLL_INTERVAL_MS;

// Backoff for a hostname that has not resolved yet, applied on the dashboard
// refresh path. A tunnel whose hostname never publishes (revoked during
// negotiation, a wedged cloudflared) is otherwise re-probed on every 4s tick
// for the life of the dashboard process — one DNS lookup per such tunnel per
// tick, forever. Successive misses double the wait from one tick up to
// PROBE_BACKOFF_MAX_MS; a success clears the entry, as does reapTunnelFiles
// when the tunnel goes away.
const PROBE_BACKOFF_BASE_MS = 4_000;
const PROBE_BACKOFF_MAX_MS = 5 * 60_000;

export function tunnelPidfilePath(pidDir: string, port: number): string {
  return join(pidDir, `minimal-tunnel-${port}.pid`);
}

export function tunnelLogPath(pidDir: string, port: number): string {
  return join(pidDir, `minimal-tunnel-${port}.log`);
}

/**
 * Extract the port from a tunnel pidfile name (`minimal-tunnel-<port>.pid`).
 * Returns null when the name doesn't match or the port is out of range.
 */
export function portFromTunnelPidfile(name: string): number | null {
  const m = name.match(TUNNEL_PIDFILE_RE);
  if (!m || m[1] === undefined) return null;
  const port = Number.parseInt(m[1], 10);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return null;
  return port;
}

/** Parse the first *.trycloudflare.com URL out of a captured cloudflared log. */
export function parseTrycloudflareUrl(logText: string): string | null {
  const m = logText.match(TRYCLOUDFLARE_URL_RE);
  return m ? m[0] : null;
}

function defaultPidDir(): string {
  return process.env.TMPDIR ?? "/tmp";
}

async function defaultCommandExists(cmd: string): Promise<boolean> {
  const pathEnv = process.env.PATH ?? "";
  const { access } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  for (const dir of pathEnv.split(":")) {
    if (dir === "") continue;
    try {
      await access(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      // Not in this PATH entry; keep looking.
    }
  }
  return false;
}

/**
 * Spawn cloudflared detached, its output redirected to the tunnel log file.
 * detached + unref + a file (not the parent's pipes) for stdio is what lets the
 * tunnel survive the dashboard process — required so a dashboard restart
 * rediscovers running tunnels rather than orphaning (or killing) them.
 */
const defaultSpawnTunnel: SpawnTunnelFn = async (port, pidDir) => {
  const { spawn } = await import("node:child_process");
  const { openSync, closeSync } = await import("node:fs");
  const logFd = openSync(tunnelLogPath(pidDir, port), "a");
  try {
    // Protocol is left to cloudflared's auto-negotiation. An earlier revision
    // pinned --protocol http2 because the v1 sandbox blocked outbound UDP,
    // which made an auto-negotiated QUIC connection register a tunnel that
    // then couldn't carry traffic. That constraint is gone: the sandbox now
    // permits UDP/443, cloudflared's own connectivity pre-checks report QUIC
    // as usable, and auto-negotiation picks the faster transport.
    const args = ["tunnel", "--url", tunnelTargetUrl(port)];
    const child = spawn(CLOUDFLARED_BIN, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    // A spawn failure (ENOENT / EACCES / ENOMEM) is delivered asynchronously on
    // the child's 'error' event. With no listener attached, Node re-throws it as
    // an uncaught exception that would take the whole dashboard process down.
    // Race 'spawn' (success) against 'error' (failure): a failure rejects and is
    // routed into startTunnel's spawn-failed path; a late error after a
    // successful spawn is logged rather than thrown, since the listener stays
    // attached for the child's lifetime.
    let settled = false;
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        settled = true;
        resolve();
      });
      child.on("error", (err) => {
        if (settled) {
          console.warn(`[dashboard] cloudflared tunnel (:${port}) child error:`, err);
          return;
        }
        settled = true;
        reject(err);
      });
    });
    if (child.pid === undefined) throw new Error("cloudflared did not report a PID");
    return child.pid;
  } finally {
    // The child dup'd the fd; the parent's copy is no longer needed.
    closeSync(logFd);
  }
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Read a PID's argv from `/proc` (Linux — the sandbox and CI), falling back to
 * `ps` for a macOS operator running the dashboard directly on the host. Mirrors
 * dashboard.sh's `pid_cmdline`.
 */
async function pidCmdline(pid: number): Promise<string | null> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
  } catch {
    // Not Linux, or the process vanished between the liveness probe and here.
  }
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("ps", ["-p", String(pid), "-o", "command="]);
    return stdout;
  } catch {
    // Both probes failed. Usually benign (the process exited between the
    // liveness check and here), but on a host with neither /proc nor a working
    // `ps` it means EVERY tunnel reads as a recycled PID and gets reaped on the
    // next refresh — silently, and indistinguishably from tunnels that really
    // did die. Log it so that case is diagnosable.
    console.warn(`[dashboard] could not read cmdline for pid ${pid} (no /proc, and ps failed)`);
    return null;
  }
}

/**
 * Whether a process command line is cloudflared serving `port`.
 *
 * Token equality, not substring: `http://localhost:432` is a substring of
 * `http://localhost:4326`, so a substring test would let port 432 claim port
 * 4326's process. cmdline arrives NUL-separated (rendered to spaces), so the
 * `--url` value is always its own whitespace-delimited token.
 */
export function cmdlineMatchesTunnel(cmd: string, port: number): boolean {
  if (!cmd.includes(CLOUDFLARED_BIN)) return false;
  return cmd.split(/\s+/).includes(tunnelTargetUrl(port));
}

const defaultPidIsCloudflared: PidIsCloudflaredFn = async (pid, port) => {
  const cmd = await pidCmdline(pid);
  return cmd === null ? false : cmdlineMatchesTunnel(cmd, port);
};

// Hostname of a quick tunnel URL, for the DNS liveness probe.
function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Hostnames observed resolvable at least once. A quick tunnel's hostname is
// fixed for the life of its cloudflared, so a single success is proof for good;
// caching it keeps the refresh path (discoverTunnels, once per tick per tunnel)
// from re-probing tunnels already known reachable. Only successes are cached —
// a hostname that hasn't landed yet stays pending and is probed again next tick.
const confirmedHosts = new Set<string>();

// Miss counters + earliest next attempt for hostnames still awaiting a
// resolvable answer. See PROBE_BACKOFF_BASE_MS.
const pendingProbes = new Map<string, { misses: number; nextAttempt: number }>();

/** Record a failed probe for `host` and schedule the next attempt. */
function recordProbeMiss(host: string, nowMs: number): void {
  const misses = (pendingProbes.get(host)?.misses ?? 0) + 1;
  const delay = Math.min(PROBE_BACKOFF_BASE_MS * 2 ** (misses - 1), PROBE_BACKOFF_MAX_MS);
  pendingProbes.set(host, { misses, nextAttempt: nowMs + delay });
}

/**
 * Mark `host` proven resolvable. Confirming also drops any backoff state: a
 * hostname is confirmed for good, so a lingering `pendingProbes` entry would
 * leave the two maps disagreeing about whether it is still pending. Every read
 * path checks {@link confirmedHosts} first today, so that disagreement is
 * currently invisible — clearing here keeps it that way if the order changes.
 */
function markHostConfirmed(host: string): void {
  confirmedHosts.add(host);
  pendingProbes.delete(host);
}

/**
 * The URL to surface for a tunnel, or null while it isn't reachable yet.
 *
 * A quick-tunnel URL is not usable the instant cloudflared prints it: Cloudflare
 * publishes the DNS record a moment later. Surfacing the URL inside that gap
 * invites the first click to pin an NXDOMAIN in whatever resolver the operator's
 * browser sits behind — for the full 1800s SOA minttl, on a tunnel that is about
 * to work (see {@link PROBE_RESOLVERS}). Reporting it as pending until it
 * resolves closes the window in which that misfire is possible.
 */
async function reachableUrl(url: string | null, probeHost: ProbeHostFn): Promise<string | null> {
  if (url === null) return null;
  const host = hostOfUrl(url);
  // Unparseable URL: there's nothing to probe, so don't withhold it.
  if (host === null) return url;
  if (confirmedHosts.has(host)) return url;
  const status = await probeHost(host);
  switch (status) {
    case "resolved":
      markHostConfirmed(host);
      return url;
    // Only a POSITIVE answer surfaces the URL. "ambiguous" holds it pending
    // alongside "nxdomain": an unproven URL clicked during a probe blip can
    // poison the operator's resolver just as surely as one clicked before
    // propagation.
    case "nxdomain":
    case "ambiguous":
      return null;
  }
}

/**
 * {@link reachableUrl} with the pending-hostname backoff applied, for the
 * dashboard refresh path.
 *
 * startTunnel deliberately does NOT go through this: its poll is already
 * bounded by {@link URL_POLL_BUDGET_MS}, and an operator who just clicked
 * Share should get the tightest possible confirmation loop. startTunnel does
 * not record misses, so a hostname still pending when the start returns is
 * probed once more on the next refresh tick before backoff begins.
 */
async function reachableUrlBackedOff(
  url: string | null,
  probeHost: ProbeHostFn,
  nowMs: number,
): Promise<string | null> {
  if (url === null) return null;
  const host = hostOfUrl(url);
  if (host === null || confirmedHosts.has(host)) return reachableUrl(url, probeHost);
  const pending = pendingProbes.get(host);
  if (pending !== undefined && nowMs < pending.nextAttempt) return null;
  const resolved = await reachableUrl(url, probeHost);
  // A non-null result here means reachableUrl took its "resolved" branch, which
  // already cleared the backoff entry via markHostConfirmed.
  if (resolved === null) recordProbeMiss(host, nowMs);
  return resolved;
}

/** An authoritative "no such name" resolver error, vs a transient failure. */
export function isAuthoritativeNxdomain(code: string | undefined): boolean {
  return code === "ENOTFOUND" || code === "ENODATA";
}

const defaultProbeHost: ProbeHostFn = async (host) => {
  const { Resolver } = await import("node:dns/promises");
  const dns = new Resolver({ timeout: PROBE_TIMEOUT_MS, tries: PROBE_TRIES });
  dns.setServers(PROBE_RESOLVERS);
  try {
    if ((await dns.resolve4(host)).length > 0) return "resolved";
    return "ambiguous";
  } catch (err) {
    if (!isAuthoritativeNxdomain((err as NodeJS.ErrnoException).code)) return "ambiguous";
    // A-record absence alone does not mean the name is gone: an AAAA-only host
    // answers ENODATA for an A query. Confirm against AAAA before declaring an
    // authoritative NXDOMAIN, so an IPv6-only answer can't read as revoked.
    try {
      if ((await dns.resolve6(host)).length > 0) return "resolved";
      return "ambiguous";
    } catch (err6) {
      return isAuthoritativeNxdomain((err6 as NodeJS.ErrnoException).code)
        ? "nxdomain"
        : "ambiguous";
    }
  }
};

export interface TunnelDeps {
  /** Shared pidfile/log dir. Defaults to `$TMPDIR` (or `/tmp`). */
  pidDir?: string;
  spawnTunnel?: SpawnTunnelFn;
  commandExists?: CommandExistsFn;
  /**
   * Signal delivery. Positive PID, mirroring scripts/dev.sh + discover.ts: a
   * cloudflared quick tunnel is a single Go process (it does not fork helpers),
   * so a plain per-PID kill is sufficient and avoids the process-group hazards
   * called out in discover.ts. Tests inject a stub.
   */
  killFn?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
  pidIsCloudflared?: PidIsCloudflaredFn;
  probeHost?: ProbeHostFn;
  /** Monotonic-enough clock for the poll deadline and probe backoff. */
  now?: () => number;
}

function defaultKill(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

/**
 * Whether the cloudflared binary is resolvable on PATH. The dashboard uses this
 * to decide up front whether to offer the "Share" action or show the
 * `min add cloudflared` hint, rather than only discovering it's missing on the
 * first click.
 */
export async function isCloudflaredInstalled(
  deps: Pick<TunnelDeps, "commandExists"> = {},
): Promise<boolean> {
  const commandExists = deps.commandExists ?? defaultCommandExists;
  return commandExists(CLOUDFLARED_BIN);
}

function isAlive(pid: number, killFn: (pid: number, signal: NodeJS.Signals | 0) => void): boolean {
  try {
    killFn(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Liveness AND identity: the PID is running and is still a cloudflared. Use this
 * wherever a wrong answer would act on an unrelated process (see
 * {@link PidIsCloudflaredFn}); the bare {@link isAlive} is fine only for the
 * tight post-signal exit polls, where identity has already been established.
 */
async function isLiveCloudflared(
  pid: number,
  port: number,
  killFn: (pid: number, signal: NodeJS.Signals | 0) => void,
  pidIsCloudflared: PidIsCloudflaredFn,
): Promise<boolean> {
  return isAlive(pid, killFn) && (await pidIsCloudflared(pid, port));
}

async function readPidfile(path: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && pid <= MAX_PID) return pid;
  } catch {
    // Absent or unreadable pidfile.
  }
  return null;
}

async function readTunnelUrl(pidDir: string, port: number): Promise<string | null> {
  try {
    return parseTrycloudflareUrl(await readFile(tunnelLogPath(pidDir, port), "utf8"));
  } catch {
    return null;
  }
}

/** Best-effort removal of a tunnel's pidfile + log. Swallows missing-file errors. */
async function reapTunnelFiles(pidDir: string, port: number): Promise<void> {
  // Drop the readiness-cache entry here rather than in each caller: this is the
  // one choke point through which a tunnel ceases to exist. The hostname dies
  // with its cloudflared and is never reissued, so retaining it would leak an
  // entry per share cycle for the life of the dashboard process.
  const url = await readTunnelUrl(pidDir, port);
  const host = url === null ? null : hostOfUrl(url);
  if (host !== null) {
    confirmedHosts.delete(host);
    pendingProbes.delete(host);
  }
  await unlink(tunnelPidfilePath(pidDir, port)).catch(() => undefined);
  await unlink(tunnelLogPath(pidDir, port)).catch(() => undefined);
}

// Coalesces concurrent startTunnel calls for the same port onto one in-flight
// promise. Without this, two overlapping requests (two dashboard tabs, or a
// double-submit) could both observe "no live pidfile," both spawn cloudflared,
// and race the pidfile write — leaving one orphaned public tunnel with no
// pidfile pointing at it, invisible to discoverTunnels() and thus unstoppable
// from the UI. Keyed by port; the entry is cleared when the start settles.
const inFlightStarts = new Map<number, Promise<StartTunnelResult>>();

/**
 * Start (or re-attach to) a public cloudflared quick tunnel for `port`.
 *
 * Idempotent: if a live tunnel already exists for the port, its current info is
 * returned rather than spawning a second cloudflared. Returns `not-installed`
 * (without spawning) when cloudflared isn't on PATH so the caller can show the
 * `min add cloudflared` hint and degrade gracefully.
 *
 * Concurrency-safe: overlapping calls for the same port share one in-flight
 * start (see {@link inFlightStarts}) so a double-submit can't spawn — and orphan
 * — a second cloudflared.
 *
 * On a fresh start the URL may not have been negotiated yet within the poll
 * window; the returned tunnel then carries `url: null` (pending) and the caller
 * surfaces it once {@link discoverTunnels} reads it from the log on a later
 * refresh.
 */
export async function startTunnel(port: number, deps: TunnelDeps = {}): Promise<StartTunnelResult> {
  const existing = inFlightStarts.get(port);
  if (existing) return existing;
  const started = startTunnelInner(port, deps).finally(() => {
    inFlightStarts.delete(port);
  });
  inFlightStarts.set(port, started);
  return started;
}

async function startTunnelInner(port: number, deps: TunnelDeps): Promise<StartTunnelResult> {
  const pidDir = deps.pidDir ?? defaultPidDir();
  const commandExists = deps.commandExists ?? defaultCommandExists;
  const spawnTunnel = deps.spawnTunnel ?? defaultSpawnTunnel;
  const killFn = deps.killFn ?? defaultKill;
  const sleep = deps.sleep ?? defaultSleep;
  const pidIsCloudflared = deps.pidIsCloudflared ?? defaultPidIsCloudflared;
  const probeHost = deps.probeHost ?? defaultProbeHost;
  const now = deps.now ?? Date.now;

  const existingPid = await readPidfile(tunnelPidfilePath(pidDir, port));
  if (
    existingPid !== null &&
    (await isLiveCloudflared(existingPid, port, killFn, pidIsCloudflared))
  ) {
    const existingUrl = await readTunnelUrl(pidDir, port);
    // A live cloudflared is NOT proof of a working tunnel. Cloudflare can
    // revoke a quick tunnel's hostname while the local process keeps running
    // and still self-reports a ready connection — the URL then resolves to
    // nothing. Without this probe the operator is stuck: every "Share" click
    // hands back the same dead URL and never respawns.
    //
    // But an NXDOMAIN alone is NOT proof of revocation either: a hostname in
    // its propagation window answers exactly the same way. Only a hostname
    // that has ALREADY been seen resolvable ({@link confirmedHosts}) and now
    // authoritatively fails to can be called revoked — anything else is
    // (propagation-)pending, and tearing it down would let a retry or a
    // double-POST during the window kill a healthy tunnel, restart the DNS
    // race, and violate this function's idempotency contract. The cost of
    // this rule: a tunnel revoked BEFORE a dashboard restart (which clears
    // the confirmation cache) shows as pending forever instead of
    // self-healing on Share; the explicit Stop + Share path recovers it.
    const host = existingUrl === null ? null : hostOfUrl(existingUrl);
    if (host !== null) {
      const status = await probeHost(host);
      const revoked = ((): boolean => {
        switch (status) {
          case "resolved":
            markHostConfirmed(host);
            return false;
          case "nxdomain":
            // Only a hostname already proven resolvable can be called revoked;
            // otherwise this is the propagation window (see above).
            return confirmedHosts.has(host);
          case "ambiguous":
            // Probe blip — treat as alive rather than churning the operator's
            // public URL over an inconclusive lookup.
            return false;
        }
      })();
      if (!revoked) {
        return {
          ok: true,
          tunnel: {
            port,
            pid: existingPid,
            // Same surface rule as reachableUrl: only a confirmed hostname's
            // URL is handed out; unproven ones stay pending (null).
            url: confirmedHosts.has(host) ? existingUrl : null,
            alive: true,
          },
        };
      }
      await stopTunnel(port, deps);
    } else {
      // No URL in the log yet (or unparseable): nothing to probe — the
      // tunnel is simply still negotiating. Hand it back as pending.
      return { ok: true, tunnel: { port, pid: existingPid, url: existingUrl, alive: true } };
    }
  }
  // Stale pidfile (dead PID, a recycled non-cloudflared PID, or a revoked
  // tunnel just torn down) or none: clear any leftover files before a fresh
  // spawn so we never read a previous tunnel's URL out of an old log.
  await reapTunnelFiles(pidDir, port);

  if (!(await commandExists(CLOUDFLARED_BIN))) return { ok: false, reason: "not-installed" };

  let pid: number;
  try {
    pid = await spawnTunnel(port, pidDir);
  } catch (err) {
    return {
      ok: false,
      reason: "spawn-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(tunnelPidfilePath(pidDir, port), `${pid}\n`, "utf8");

  const deadline = now() + URL_POLL_BUDGET_MS;
  let url: string | null = null;
  for (let i = 0; i < URL_POLL_ITERS; i++) {
    url = await reachableUrl(await readTunnelUrl(pidDir, port), probeHost);
    if (url !== null) break;
    // A cloudflared that exits during startup (bad flags, network) leaves a dead
    // PID and no URL — stop polling rather than waiting out the full window.
    if (!isAlive(pid, killFn)) break;
    // Wall-clock stop, not just the iteration count: a slow probe can consume
    // many iterations' worth of the budget on its own (see URL_POLL_BUDGET_MS).
    if (now() >= deadline) break;
    await sleep(URL_POLL_INTERVAL_MS);
  }
  return { ok: true, tunnel: { port, pid, url, alive: isAlive(pid, killFn) } };
}

/**
 * Stop the tunnel for `port`: SIGTERM the cloudflared process, escalate to
 * SIGKILL if it doesn't exit within the poll window, then remove its pidfile +
 * log. Returns whether a live process was actually signalled (false when the
 * pidfile was absent or already dead — the files are still reaped).
 */
export async function stopTunnel(
  port: number,
  deps: TunnelDeps = {},
): Promise<{ stopped: boolean }> {
  const pidDir = deps.pidDir ?? defaultPidDir();
  const killFn = deps.killFn ?? defaultKill;
  const sleep = deps.sleep ?? defaultSleep;
  const pidIsCloudflared = deps.pidIsCloudflared ?? defaultPidIsCloudflared;

  const pid = await readPidfile(tunnelPidfilePath(pidDir, port));
  let stopped = false;
  // Identity-checked: signalling a recycled PID would kill an unrelated
  // process. The post-signal polls below use the cheap liveness probe — by
  // then the PID is confirmed ours.
  if (pid !== null && (await isLiveCloudflared(pid, port, killFn, pidIsCloudflared))) {
    stopped = true;
    try {
      killFn(pid, "SIGTERM");
    } catch {
      // Already gone between the liveness check and the signal.
    }
    for (let i = 0; i < STOP_POLL_ITERS && isAlive(pid, killFn); i++) {
      await sleep(STOP_POLL_INTERVAL_MS);
    }
    if (isAlive(pid, killFn)) {
      try {
        killFn(pid, "SIGKILL");
      } catch {
        // Raced to exit before SIGKILL landed.
      }
      for (let i = 0; i < STOP_POLL_ITERS && isAlive(pid, killFn); i++) {
        await sleep(STOP_POLL_INTERVAL_MS);
      }
    }
  }
  await reapTunnelFiles(pidDir, port);
  return { stopped };
}

/**
 * Discover every tunnel with a pidfile under `pidDir`. A tunnel whose PID is
 * dead — or alive but no longer a cloudflared (a recycled PID) — is reaped
 * (pidfile + log removed) and omitted, so a tunnel left behind by a killed
 * cloudflared self-heals on the next refresh. Live tunnels are returned with
 * their current URL (re-read from the log each call, so a URL that lands after
 * start is picked up).
 *
 * A tunnel whose hostname has not been published in DNS yet is returned with
 * `url: null` (pending) rather than a URL that would fail to load — clicking one
 * during that window is exactly what poisons a resolver's negative cache (see
 * {@link reachableUrl}). The probe costs one lookup per tunnel until it first
 * succeeds, after which {@link confirmedHosts} short-circuits it, so a steady
 * state of healthy tunnels issues no lookups at all. A hostname that never
 * publishes backs off instead of being probed every tick forever (see
 * {@link PROBE_BACKOFF_BASE_MS}).
 *
 * Still does NOT re-probe for revocation once a hostname is confirmed: that
 * would be a lookup per tunnel per tick for a rare event. A revoked tunnel is
 * recovered when the operator clicks Share, which re-issues it.
 */
export async function discoverTunnels(deps: TunnelDeps = {}): Promise<TunnelInfo[]> {
  const pidDir = deps.pidDir ?? defaultPidDir();
  const killFn = deps.killFn ?? defaultKill;
  const pidIsCloudflared = deps.pidIsCloudflared ?? defaultPidIsCloudflared;
  const probeHost = deps.probeHost ?? defaultProbeHost;
  const now = deps.now ?? Date.now;

  let names: string[];
  try {
    names = await readdir(pidDir);
  } catch {
    return [];
  }
  const tunnels: TunnelInfo[] = [];
  for (const name of names) {
    const port = portFromTunnelPidfile(name);
    if (port === null) continue;
    const pid = await readPidfile(join(pidDir, name));
    if (pid === null || !(await isLiveCloudflared(pid, port, killFn, pidIsCloudflared))) {
      await reapTunnelFiles(pidDir, port);
      continue;
    }
    const url = await reachableUrlBackedOff(await readTunnelUrl(pidDir, port), probeHost, now());
    tunnels.push({ port, pid, url, alive: true });
  }
  tunnels.sort((a, b) => a.port - b.port);
  return tunnels;
}
