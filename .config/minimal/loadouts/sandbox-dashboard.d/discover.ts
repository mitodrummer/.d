import { readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Synchronously-shaped exec callback. Returns stdout (trimmed) on success and
 * throws on non-zero exit. Tests inject a stub; runtime uses {@link defaultExec}.
 */
export type ExecFn = (cmd: string, args: readonly string[]) => Promise<string>;

export interface DiscoveredWorktree {
  branch: string;
  port: number;
  worktreePath: string;
  prNumber?: number;
  prTitle?: string;
  prUrl?: string;
  prState?: string;
  alive: boolean;
}

/**
 * Probe a dev server's shallow liveness via `GET /healthcheck` on its recorded
 * port. Resolves true only on an HTTP 200; any non-200, connection refusal, or
 * timeout resolves false. Tests inject a stub; runtime uses
 * {@link defaultProbeHealth}.
 *
 * This is the authoritative "is it actually serving" signal. A live PID proves
 * a process exists, but not that it serves the recorded port: a server that
 * silently walked to another port, or a wedged server returning 500s from a
 * deleted worktree, both have a live PID yet fail this probe.
 */
export type ProbeHealthFn = (port: number) => Promise<boolean>;

const DEFAULT_DEV_PORT = 4321;
const PR_CACHE_TTL_MS = 60_000;
const HEALTHCHECK_TIMEOUT_MS = 1500;

// The project's scripts/dev.sh writes its pidfile to `${TMPDIR:-/tmp}/minimal-dev-<port>.pid`
// (moved off the bind-mounted project dir in #220 to avoid an overlayfs
// whiteout cascade). These shared-dir pidfiles carry only the port in their
// name — the owning worktree is recovered from the process's cwd. The legacy
// in-worktree `.dev-*.pid` form is still honored for un-migrated worktrees.
const TMPDIR_PIDFILE_RE = /^minimal-dev-(\d+)\.pid$/;

// Pidfile-derived values are untrusted: a stray or corrupt `.dev-*.pid` could
// carry an out-of-range port (surfacing a dead dashboard link) or a
// non-positive / absurd PID (a ghost "alive" row, since `kill -0 0` probes the
// process group rather than a real process). Bound both before trusting them.
const MIN_PORT = 1024;
const MAX_PORT = 65_535;
const MAX_PID = 2 ** 22; // Linux pid_max ceiling; comfortably above any real PID.

// `gh` output and the state file are external process boundaries. Validation
// is hand-rolled (the webapp original used zod): this file is patched into
// sessions as a bare script with no node_modules to resolve packages from, so
// it must run on node builtins alone. Fail-closed like zod's `.parse`: one
// malformed record rejects the whole payload.

// Rendered into an `href` server- and client-side, so require a well-formed
// https URL rather than an arbitrary string — rejects the javascript:/data:
// hrefs a manipulated `gh` payload could otherwise inject into the dashboard.
function isHttpsUrl(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("https://") && URL.canParse(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: string;
}

function isPrInfo(v: unknown): v is PrInfo {
  return (
    isRecord(v) &&
    typeof v.number === "number" &&
    typeof v.title === "string" &&
    isHttpsUrl(v.url) &&
    typeof v.state === "string"
  );
}

/** JSON-parse + validate an array payload, throwing on any shape mismatch. */
function parseValidatedArray<T>(raw: string, guard: (v: unknown) => v is T, what: string): T[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(guard)) {
    throw new Error(`unexpected ${what} payload shape`);
  }
  return parsed;
}

interface PrCacheEntry {
  expiresAt: number;
  value: PrInfo | null;
}

const prCache = new Map<string, PrCacheEntry>();

// GitHub login whose open assigned issues the dashboard surfaces. The in-sandbox
// agent authenticates as this account (`gh api user` reports `agent-137`), so
// issues assigned to it are work the agent is expected to pick up. The hyphen is
// load-bearing: `gh issue list --assignee agent137` (no hyphen) matches nothing.
// File/hook names use the hyphenless "agent137" spelling for brevity; only this
// constant — the value handed to `gh` — must match the real login.
export const ASSIGNED_ISSUES_LOGIN = "agent-137";

// `gh issue list --assignee <login> --json number,title,url` is an external
// process boundary — validated with the same fail-closed guards as the PR list
// above (https-only URLs included). A failing parse degrades the section to
// empty.
export interface AssignedIssue {
  number: number;
  title: string;
  url: string;
}

function isAssignedIssue(v: unknown): v is AssignedIssue {
  return (
    isRecord(v) && typeof v.number === "number" && typeof v.title === "string" && isHttpsUrl(v.url)
  );
}

const ASSIGNED_ISSUES_CACHE_TTL_MS = 60_000;
// On failure (gh missing / unauthenticated / offline) we cache the empty result
// for a shorter window so the dashboard recovers within ~10s of auth coming back
// rather than showing a stale "no issues" for the full success TTL.
const ASSIGNED_ISSUES_ERROR_TTL_MS = 10_000;

interface AssignedIssuesCacheEntry {
  expiresAt: number;
  value: AssignedIssue[];
}

// Single-key cache (keyed by assignee login) mirroring the prCache 60s-TTL
// pattern so the dashboard's REFRESH_MS loop doesn't hammer `gh issue list`.
const assignedIssuesCache = new Map<string, AssignedIssuesCacheEntry>();

export async function defaultExec(cmd: string, args: readonly string[]): Promise<string> {
  // Lazy import keeps this module trivially mockable from tests without
  // node:child_process being touched on the import-only path.
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/**
 * Parse `git worktree list --porcelain` output into worktree paths +
 * branch refs. Returns one entry per worktree. The porcelain format
 * groups lines per worktree separated by a blank line; each group has
 * `worktree <path>`, optional `HEAD <sha>`, and `branch refs/heads/<name>`
 * (or `detached`).
 */
export function parseWorktreePorcelain(out: string): Array<{ path: string; branch: string }> {
  const result: Array<{ path: string; branch: string }> = [];
  let cur: { path?: string; branch?: string } = {};
  for (const line of out.split("\n")) {
    if (line === "") {
      if (cur.path && cur.branch) result.push({ path: cur.path, branch: cur.branch });
      cur = {};
      continue;
    }
    if (line.startsWith("worktree ")) cur.path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/"))
      cur.branch = line.slice("branch refs/heads/".length);
    else if (line === "detached") cur.branch = "(detached)";
  }
  if (cur.path && cur.branch) result.push({ path: cur.path, branch: cur.branch });
  return result;
}

/**
 * Extract the dev-server port from a pidfile name. `.dev.pid` is the legacy
 * default-port file and maps to 4321; `.dev-${PORT}.pid` carries the port.
 * Returns null if the name doesn't match either pattern.
 */
export function portFromPidfile(name: string): number | null {
  if (name === ".dev.pid") return DEFAULT_DEV_PORT;
  const m = name.match(/^\.dev-(\d+)\.pid$/);
  if (!m || m[1] === undefined) return null;
  const port = Number.parseInt(m[1], 10);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return null;
  return port;
}

async function readPidfileEntries(
  worktreePath: string,
): Promise<Array<{ port: number; pid: number }>> {
  let names: string[];
  try {
    names = await readdir(worktreePath);
  } catch {
    return [];
  }
  const out: Array<{ port: number; pid: number }> = [];
  for (const name of names) {
    const port = portFromPidfile(name);
    if (port === null) continue;
    try {
      const raw = await readFile(join(worktreePath, name), "utf8");
      const pid = Number.parseInt(raw.trim(), 10);
      if (Number.isInteger(pid) && pid > 0 && pid <= MAX_PID) out.push({ port, pid });
    } catch {
      // Ignore pidfile read errors; the row will simply not appear.
    }
  }
  return out;
}

/** Resolve a PID's working directory via `/proc/<pid>/cwd` (Linux). */
async function defaultPidCwd(pid: number): Promise<string | null> {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * Whether a resolved process cwd belongs to a current worktree.
 *
 * Linux appends a literal ` (deleted)` suffix to `/proc/<pid>/cwd` once the
 * directory the process is chdir'd into is unlinked — which is exactly what
 * happens to an orphaned dev server after `git worktree remove`. Such a process
 * keeps holding its port and serving 500s from files that no longer exist, so
 * it must never be attributed to a live worktree row. A cwd that doesn't match
 * any entry in the current `git worktree list` is likewise treated as not-live
 * (a leftover process from a removed worktree whose dir was reused).
 */
function cwdMatchesWorktree(cwd: string, worktreePaths: ReadonlySet<string>): boolean {
  if (cwd.endsWith(" (deleted)")) return false;
  return worktreePaths.has(cwd);
}

/**
 * Probe `http://127.0.0.1:<port>/healthcheck` and resolve true only on a 200.
 * Uses a short {@link HEALTHCHECK_TIMEOUT_MS} abort so a wedged or
 * non-listening port fails fast rather than stalling the dashboard refresh.
 */
async function defaultProbeHealth(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthcheck`, {
      signal: controller.signal,
      // A liveness probe must observe the live process, never a cached 200.
      cache: "no-store",
    });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scan the shared pidfile directory ($TMPDIR) for `minimal-dev-<port>.pid`
 * files written by the post-#220 scripts/dev.sh. Each file's name carries only
 * the port, so the owning worktree is recovered from the process cwd
 * (`pidCwd`). Returns one entry per readable, in-range pidfile whose cwd
 * resolves; bad ports/PIDs and unreadable files are skipped.
 */
async function readTmpdirPidEntries(
  pidDir: string,
  pidCwd: (pid: number) => Promise<string | null>,
  groupMemberPid: (pgid: number) => Promise<number | null>,
): Promise<Array<{ port: number; pid: number; cwd: string }>> {
  let names: string[];
  try {
    names = await readdir(pidDir);
  } catch {
    return [];
  }
  const out: Array<{ port: number; pid: number; cwd: string }> = [];
  for (const name of names) {
    const m = name.match(TMPDIR_PIDFILE_RE);
    if (!m || m[1] === undefined) continue;
    const port = Number.parseInt(m[1], 10);
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) continue;
    try {
      const raw = await readFile(join(pidDir, name), "utf8");
      const pid = Number.parseInt(raw.trim(), 10);
      if (!(Number.isInteger(pid) && pid > 0 && pid <= MAX_PID)) continue;
      // The recorded pid is a setsid group leader (scripts/dev.sh), and a
      // node listener can outlive it — /proc/<leader>/cwd is then gone even
      // though the server still holds the port. Recover the cwd from any
      // surviving member of the leader's process group so the row isn't
      // dropped in exactly the state `dev.sh status` still reports as
      // running.
      let cwd = await pidCwd(pid);
      if (cwd === null) {
        const member = await groupMemberPid(pid);
        cwd = member === null ? null : await pidCwd(member);
      }
      if (cwd === null) continue;
      out.push({ port, pid, cwd });
    } catch {
      // Ignore pidfile read errors; the row will simply not appear.
    }
  }
  return out;
}

// Mirrors group_alive() in scripts/dev.sh, the other consumer of these
// pidfiles: probe the process group first (negative pid) so a listener that
// outlived the recorded setsid leader still counts as alive; the plain-pid
// fallback covers legacy pidfiles whose pid is not a group leader. Keeping
// the two liveness semantics aligned is the contract — `dev.sh status` and
// the dashboard must agree on whether a server is up.
function isAlive(pid: number, killFn: (pid: number, signal: 0) => void): boolean {
  try {
    killFn(-pid, 0);
    return true;
  } catch {
    try {
      killFn(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Parse the pgrp field out of a `/proc/<pid>/stat` line.
 *
 * comm (field 2) may itself contain spaces and parentheses, so the
 * space-split fields are only trustworthy after the LAST `)` — from there
 * the layout is `state ppid pgrp ...`, putting pgrp at index 2. Returns
 * null on malformed input. Exported for direct unit coverage of the
 * parsing, which the injectable-`groupMemberPid` tests bypass.
 */
export function pgrpFromStat(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const pgrp = Number.parseInt(stat.slice(close + 2).split(" ")[2] ?? "", 10);
  return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
}

/**
 * Find any live member of the given process group by scanning /proc.
 * Only consulted on the rare leader-dead recovery path above. Exported so
 * the real scan (not just the injectable stub) has test coverage.
 */
export async function defaultGroupMemberPid(pgid: number): Promise<number | null> {
  let names: string[];
  try {
    names = await readdir("/proc");
  } catch {
    return null;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number.parseInt(name, 10);
    if (pid === pgid) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      if (pgrpFromStat(stat) === pgid) return pid;
    } catch {
      // Process exited mid-scan; skip it.
    }
  }
  return null;
}

async function lookupPr(branch: string, exec: ExecFn, now: number): Promise<PrInfo | null> {
  const cached = prCache.get(branch);
  if (cached && cached.expiresAt > now) return cached.value;
  let value: PrInfo | null = null;
  try {
    // `gh pr list --head <branch>` quietly returns `[]` for some open PRs
    // (an upstream gh CLI quirk reproducible against e.g. branch
    // `issue-198` even when the matching open PR exists). Forcing
    // `--state all` works around it; we still filter to `OPEN` PRs in
    // code below so the surfaced UI doesn't carry merged / closed
    // branches from a stale worktree.
    const raw = await exec("gh", [
      "pr",
      "list",
      "--state",
      "all",
      "--head",
      branch,
      "--json",
      "number,title,url,state",
      "--limit",
      "5",
    ]);
    const records = parseValidatedArray(raw, isPrInfo, "gh pr list");
    if (records.length > 0) {
      // Prefer the open PR for this branch if there is one; otherwise fall
      // back to the most-recently-listed entry so the dashboard surfaces
      // a merged / closed PR rather than silently dropping it.
      const open = records.find((r) => r.state === "OPEN");
      value = open ?? records[0] ?? null;
    }
  } catch (err) {
    console.warn(`[dashboard] gh pr list --head ${branch} failed:`, err);
  }
  prCache.set(branch, { expiresAt: now + PR_CACHE_TTL_MS, value });
  return value;
}

export interface DiscoverOptions {
  exec?: ExecFn;
  killFn?: (pid: number, signal: 0) => void;
  now?: () => number;
  /** Shared dev-server pidfile dir. Defaults to `$TMPDIR` (or `/tmp`). */
  pidDir?: string;
  /** Resolve a PID to its cwd. Defaults to reading `/proc/<pid>/cwd`. */
  pidCwd?: (pid: number) => Promise<string | null>;
  /**
   * Find a live member of a process group (for cwd recovery when the
   * recorded setsid leader is gone). Defaults to scanning /proc.
   */
  groupMemberPid?: (pgid: number) => Promise<number | null>;
  /** Probe `/healthcheck` on a port. Defaults to {@link defaultProbeHealth}. */
  probeHealth?: ProbeHealthFn;
}

/**
 * Discover every running dev server across the repo's worktrees.
 *
 * Liveness reconciliation — three sources of truth, evaluated in this fixed
 * precedence so identical on-disk state always renders identically:
 *
 *   1. **`git worktree list` cwd** — the set of currently-checked-out worktree
 *      paths. A pidfile's owning worktree must be in this set. A shared-dir
 *      pidfile whose process cwd resolves to ` (deleted)` (Linux's marker for
 *      an unlinked cwd, i.e. a `git worktree remove`d dir) or to a path not in
 *      the set is an orphan and is dropped — it is NEVER attributed to a row.
 *   2. **Pidfile + live PID** — the recorded PID must satisfy `kill -0`. A
 *      stale pidfile (dead PID) is dropped.
 *   3. **`/healthcheck` on the recorded port** — the surviving candidate must
 *      answer `GET /healthcheck` with a 200. This is what makes the recorded
 *      port == the listening port: a server that drifted ports, or a wedged
 *      server serving 500s, has a live PID but fails here and is dropped.
 *
 * A row is emitted only when all three pass; otherwise the worktree's server
 * is considered down and produces no row (the dashboard renders it as absent).
 *
 * @param repoRoot - Path to the main worktree (used as the `git` cwd).
 * @param opts - Injected boundaries for testability.
 */
export async function discover(
  repoRoot: string,
  opts: DiscoverOptions = {},
): Promise<DiscoveredWorktree[]> {
  const exec = opts.exec ?? defaultExec;
  const killFn = opts.killFn ?? ((pid, sig) => process.kill(pid, sig));
  const now = (opts.now ?? Date.now)();
  const pidDir = opts.pidDir ?? process.env.TMPDIR ?? "/tmp";
  const pidCwd = opts.pidCwd ?? defaultPidCwd;
  const groupMemberPid = opts.groupMemberPid ?? defaultGroupMemberPid;
  const probeHealth = opts.probeHealth ?? defaultProbeHealth;

  const porcelain = await exec("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
  const worktrees = parseWorktreePorcelain(porcelain);
  const worktreePaths = new Set(worktrees.map((w) => w.path));

  // Shared-dir pidfiles are keyed by port only; resolve each to the cwd its
  // dev server runs in once. Source-of-truth #1: drop any whose cwd is
  // `(deleted)` or not a current worktree (an orphaned server from a removed
  // worktree) before it can be matched to a row below.
  const tmpdirEntries = (await readTmpdirPidEntries(pidDir, pidCwd, groupMemberPid)).filter((e) =>
    cwdMatchesWorktree(e.cwd, worktreePaths),
  );

  const rows: DiscoveredWorktree[] = [];
  for (const wt of worktrees) {
    // A worktree's dev servers can appear in either pidfile location: the
    // legacy in-worktree `.dev-*.pid` or the shared `$TMPDIR/minimal-dev-*.pid`
    // (matched by process cwd). Merge both, deduped by port so a worktree that
    // somehow carries both forms for one port doesn't surface twice.
    const legacy = await readPidfileEntries(wt.path);
    const fromTmpdir = tmpdirEntries.filter((e) => e.cwd === wt.path);
    const pidByPort = new Map<number, number>();
    for (const { port, pid } of [...legacy, ...fromTmpdir]) {
      if (!pidByPort.has(port)) pidByPort.set(port, pid);
    }
    for (const [port, pid] of pidByPort) {
      // Source-of-truth #2: stale pidfile (dead PID) → not live.
      if (!isAlive(pid, killFn)) continue;
      // Source-of-truth #3: the recorded port must actually serve
      // `/healthcheck`. A drifted or wedged server has a live PID but fails
      // here, so its row is dropped — recorded port == listening port.
      if (!(await probeHealth(port))) continue;
      const pr = await lookupPr(wt.branch, exec, now);
      const row: DiscoveredWorktree = {
        branch: wt.branch,
        port,
        worktreePath: wt.path,
        alive: true,
      };
      if (pr) {
        row.prNumber = pr.number;
        row.prTitle = pr.title;
        row.prUrl = pr.url;
        row.prState = pr.state;
      }
      rows.push(row);
    }
  }
  rows.sort((a, b) => a.port - b.port);
  return rows;
}

/** Test-only: reset the in-memory PR cache. */
export function _resetPrCache(): void {
  prCache.clear();
}

/** Test-only: reset the in-memory assigned-issues cache. */
export function _resetAssignedIssuesCache(): void {
  assignedIssuesCache.clear();
}

/**
 * Default path for the seen-set state file the dashboard writes and the
 * UserPromptSubmit hook reads. Lives under `$TMPDIR` (off the bind-mounted
 * project dir, like the dev pidfiles) so it's sandbox-local and disposable.
 */
export function assignedIssuesStatePath(): string {
  return join(process.env.TMPDIR ?? tmpdir(), "agent137-assigned-issues.json");
}

export interface DiscoverAssignedIssuesOptions {
  exec?: ExecFn;
  now?: () => number;
  /** GitHub login to filter issues by. Defaults to {@link ASSIGNED_ISSUES_LOGIN}. */
  assignee?: string;
}

/**
 * List open GitHub issues assigned to {@link ASSIGNED_ISSUES_LOGIN}.
 *
 * Runs `gh issue list --assignee <login> --state open --json number,title,url`
 * through the injectable `exec`, validates the JSON with Zod, and caches the
 * result for {@link ASSIGNED_ISSUES_CACHE_TTL_MS} (keyed by assignee) so the
 * dashboard's auto-refresh loop doesn't hammer `gh`. On any `gh` failure or
 * malformed output it logs a warning and returns an empty list — the section
 * simply doesn't appear rather than breaking the dashboard. A failed lookup is
 * cached for the shorter {@link ASSIGNED_ISSUES_ERROR_TTL_MS} so the dashboard
 * recovers quickly once `gh` works again.
 */
export async function discoverAssignedIssues(
  opts: DiscoverAssignedIssuesOptions = {},
): Promise<AssignedIssue[]> {
  const exec = opts.exec ?? defaultExec;
  const now = (opts.now ?? Date.now)();
  const assignee = opts.assignee ?? ASSIGNED_ISSUES_LOGIN;

  const cached = assignedIssuesCache.get(assignee);
  if (cached && cached.expiresAt > now) return cached.value;

  let value: AssignedIssue[] = [];
  let failed = false;
  try {
    const raw = await exec("gh", [
      "issue",
      "list",
      "--assignee",
      assignee,
      "--state",
      "open",
      "--json",
      "number,title,url",
      "--limit",
      "50",
    ]);
    value = parseValidatedArray(raw, isAssignedIssue, "gh issue list");
  } catch (err) {
    failed = true;
    console.warn(`[dashboard] gh issue list --assignee ${assignee} failed:`, err);
  }
  const ttl = failed ? ASSIGNED_ISSUES_ERROR_TTL_MS : ASSIGNED_ISSUES_CACHE_TTL_MS;
  assignedIssuesCache.set(assignee, { expiresAt: now + ttl, value });
  return value;
}

export interface AssignedIssuesState {
  assignee: string;
  updatedAt: string;
  issues: AssignedIssue[];
}

function isAssignedIssuesState(v: unknown): v is AssignedIssuesState {
  return (
    isRecord(v) &&
    typeof v.assignee === "string" &&
    typeof v.updatedAt === "string" &&
    Array.isArray(v.issues) &&
    v.issues.every(isAssignedIssue)
  );
}

/**
 * Persist the current open assigned-issue set to the `$TMPDIR` state file the
 * UserPromptSubmit hook reads. Recording the full {number,title,url}
 * lets the hook surface titles without a second `gh` call, and the snapshot
 * doubles as the "last seen" baseline so newly-assigned issues can be flagged.
 *
 * Best-effort: a write failure is logged and swallowed so a read-only or full
 * `$TMPDIR` never takes the dashboard down.
 *
 * @returns The issue numbers that are new since the previous snapshot. The
 *   dashboard does NOT plumb this into the badge (that uses a separate
 *   in-process session baseline); it's surfaced for the unit tests that verify
 *   the diff and as a building block should a caller ever want the disk-diff.
 */
export async function writeAssignedIssuesState(
  issues: readonly AssignedIssue[],
  opts: { statePath?: string; now?: () => number } = {},
): Promise<number[]> {
  const statePath = opts.statePath ?? assignedIssuesStatePath();
  const nowIso = new Date((opts.now ?? Date.now)()).toISOString();

  const previous = await readAssignedIssuesState(statePath);
  const previousNumbers = new Set(previous?.issues.map((i) => i.number) ?? []);
  const newNumbers = issues.filter((i) => !previousNumbers.has(i.number)).map((i) => i.number);

  const state: AssignedIssuesState = {
    assignee: ASSIGNED_ISSUES_LOGIN,
    updatedAt: nowIso,
    issues: [...issues],
  };
  try {
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(`[dashboard] failed to write assigned-issues state to ${statePath}:`, err);
  }
  return newNumbers;
}

/**
 * Read and validate the assigned-issues state file. Returns null if the file
 * is absent or malformed (the hook treats both as "nothing to surface").
 */
export async function readAssignedIssuesState(
  statePath: string,
): Promise<AssignedIssuesState | null> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isAssignedIssuesState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
