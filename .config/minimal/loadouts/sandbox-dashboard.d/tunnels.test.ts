import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cmdlineMatchesTunnel,
  discoverTunnels,
  type HostProbeResult,
  isAuthoritativeNxdomain,
  parseTrycloudflareUrl,
  portFromTunnelPidfile,
  startTunnel,
  stopTunnel,
  tunnelLogPath,
  tunnelPidfilePath,
} from "./tunnels.ts";

const noSleep = async (): Promise<void> => undefined;

// The PIDs in these tests are fabricated and the hostnames don't exist, so the
// real identity (/proc/<pid>/cmdline) and DNS probes would reject every one of
// them. Default both to "healthy"; the tests that exercise a failing probe pass
// their own stub.
const isCloudflared = async (_pid: number, _port: number): Promise<boolean> => true;
const resolves = async (): Promise<HostProbeResult> => "resolved";
const healthy = { pidIsCloudflared: isCloudflared, probeHost: resolves } as const;

/** A killFn backed by a mutable set of "alive" PIDs. Signal 0 probes liveness. */
function makeKill(alive: Set<number>): (pid: number, signal: NodeJS.Signals | 0) => void {
  return (pid, signal) => {
    if (!alive.has(pid)) throw new Error("ESRCH");
    if (signal === "SIGTERM" || signal === "SIGKILL") alive.delete(pid);
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("portFromTunnelPidfile", () => {
  it("extracts the port from a tunnel pidfile name", () => {
    expect(portFromTunnelPidfile("minimal-tunnel-4326.pid")).toBe(4326);
  });

  it("rejects unrelated or malformed names", () => {
    expect(portFromTunnelPidfile("minimal-dev-4326.pid")).toBeNull();
    expect(portFromTunnelPidfile("minimal-tunnel-.pid")).toBeNull();
    expect(portFromTunnelPidfile("minimal-tunnel-abc.pid")).toBeNull();
  });

  it("rejects out-of-range ports", () => {
    expect(portFromTunnelPidfile("minimal-tunnel-80.pid")).toBeNull();
    expect(portFromTunnelPidfile("minimal-tunnel-70000.pid")).toBeNull();
  });
});

describe("parseTrycloudflareUrl", () => {
  it("extracts the URL from cloudflared's banner", () => {
    const log = [
      "2026-01-01 INF +----------------------------------------+",
      "2026-01-01 INF |  Your quick Tunnel has been created!    |",
      "2026-01-01 INF |  https://red-fox-tree-42.trycloudflare.com |",
      "2026-01-01 INF +----------------------------------------+",
    ].join("\n");
    expect(parseTrycloudflareUrl(log)).toBe("https://red-fox-tree-42.trycloudflare.com");
  });

  it("returns null when no URL is present yet", () => {
    expect(parseTrycloudflareUrl("2026-01-01 INF Starting tunnel")).toBeNull();
  });
});

describe("cmdlineMatchesTunnel", () => {
  const cmd = (port: number): string => `cloudflared tunnel --url http://localhost:${port} `;

  it("matches the cloudflared serving that port", () => {
    expect(cmdlineMatchesTunnel(cmd(4326), 4326)).toBe(true);
  });

  it("rejects a cloudflared serving a different port", () => {
    expect(cmdlineMatchesTunnel(cmd(4327), 4326)).toBe(false);
  });

  // A recycled PID landing on another port's tunnel must not match, or
  // stopTunnel would kill the wrong tunnel.
  it("does not let a port that is a prefix of another claim it", () => {
    expect(cmdlineMatchesTunnel(cmd(4326), 432)).toBe(false);
    expect(cmdlineMatchesTunnel(cmd(432), 4326)).toBe(false);
  });

  it("rejects a non-cloudflared process even on a matching port", () => {
    expect(cmdlineMatchesTunnel("node server.js --url http://localhost:4326", 4326)).toBe(false);
  });
});

describe("isAuthoritativeNxdomain", () => {
  it("treats NXDOMAIN / no-data as an authoritative 'gone'", () => {
    expect(isAuthoritativeNxdomain("ENOTFOUND")).toBe(true);
    expect(isAuthoritativeNxdomain("ENODATA")).toBe(true);
  });

  // Fail-safe: a resolver hiccup must not be read as "revoked", or a healthy
  // tunnel gets torn down and the operator's public URL churns for nothing.
  it("does not treat a transient resolver failure as 'gone'", () => {
    expect(isAuthoritativeNxdomain("ESERVFAIL")).toBe(false);
    expect(isAuthoritativeNxdomain("ETIMEOUT")).toBe(false);
    expect(isAuthoritativeNxdomain("ECONNREFUSED")).toBe(false);
    expect(isAuthoritativeNxdomain(undefined)).toBe(false);
  });
});

describe("startTunnel", () => {
  let pidDir: string;

  beforeEach(async () => {
    pidDir = await mkdtemp(join(tmpdir(), "tunnel-start-"));
  });
  afterEach(async () => {
    await rm(pidDir, { recursive: true, force: true });
  });

  it("returns not-installed and never spawns when cloudflared is absent", async () => {
    let spawned = false;
    const res = await startTunnel(4326, {
      pidDir,
      ...healthy,
      commandExists: async () => false,
      spawnTunnel: async () => {
        spawned = true;
        return 111;
      },
      sleep: noSleep,
    });
    expect(res).toEqual({ ok: false, reason: "not-installed" });
    expect(spawned).toBe(false);
    expect(await exists(tunnelPidfilePath(pidDir, 4326))).toBe(false);
  });

  it("spawns, writes the pidfile, and captures the URL from the log", async () => {
    const alive = new Set<number>();
    const res = await startTunnel(4326, {
      pidDir,
      ...healthy,
      commandExists: async () => true,
      killFn: makeKill(alive),
      spawnTunnel: async (port, dir) => {
        await writeFile(
          tunnelLogPath(dir, port),
          "INF |  https://calm-lake-9.trycloudflare.com |\n",
          "utf8",
        );
        alive.add(555);
        return 555;
      },
      sleep: noSleep,
    });
    expect(res).toEqual({
      ok: true,
      tunnel: { port: 4326, pid: 555, url: "https://calm-lake-9.trycloudflare.com", alive: true },
    });
    expect((await readFile(tunnelPidfilePath(pidDir, 4326), "utf8")).trim()).toBe("555");
  });

  it("returns a pending tunnel (null url) when the URL hasn't landed yet", async () => {
    const alive = new Set<number>();
    const res = await startTunnel(4326, {
      pidDir,
      ...healthy,
      commandExists: async () => true,
      killFn: makeKill(alive),
      spawnTunnel: async () => {
        alive.add(777);
        return 777;
      },
      sleep: noSleep,
    });
    expect(res).toEqual({
      ok: true,
      tunnel: { port: 4326, pid: 777, url: null, alive: true },
    });
  });

  it("is idempotent: returns the existing tunnel without spawning a second", async () => {
    const alive = new Set<number>([999]);
    await writeFile(tunnelPidfilePath(pidDir, 4326), "999\n", "utf8");
    await writeFile(
      tunnelLogPath(pidDir, 4326),
      "https://old-tunnel-1.trycloudflare.com\n",
      "utf8",
    );
    let spawned = false;
    const res = await startTunnel(4326, {
      pidDir,
      ...healthy,
      commandExists: async () => true,
      killFn: makeKill(alive),
      spawnTunnel: async () => {
        spawned = true;
        return 1;
      },
      sleep: noSleep,
    });
    expect(spawned).toBe(false);
    expect(res).toEqual({
      ok: true,
      tunnel: { port: 4326, pid: 999, url: "https://old-tunnel-1.trycloudflare.com", alive: true },
    });
  });

  // Regression: a cloudflared can stay alive and self-report a ready
  // connection after Cloudflare has revoked its quick-tunnel hostname. Before
  // the DNS probe, startTunnel saw "PID alive" and handed the dead URL back on
  // every Share click, so the operator could never re-issue the tunnel.
  // Revocation requires the hostname to have been CONFIRMED resolvable first
  // (here via a discoverTunnels pass) — an unconfirmed NXDOMAIN is
  // indistinguishable from the propagation window and must not tear down.
  it("re-issues a tunnel whose confirmed hostname has been revoked", async () => {
    const alive = new Set<number>([999]);
    await writeFile(tunnelPidfilePath(pidDir, 4326), "999\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://revoked-1.trycloudflare.com\n", "utf8");
    let published = true;
    const deps = {
      pidDir,
      pidIsCloudflared: isCloudflared,
      probeHost: async (host: string): Promise<HostProbeResult> =>
        host !== "revoked-1.trycloudflare.com" || published ? "resolved" : "nxdomain",
      commandExists: async () => true,
      killFn: makeKill(alive),
      spawnTunnel: async (port: number, dir: string) => {
        await writeFile(tunnelLogPath(dir, port), "https://fresh-2.trycloudflare.com\n", "utf8");
        alive.add(1234);
        return 1234;
      },
      sleep: noSleep,
    };
    // The hostname resolves once (confirmed), then Cloudflare revokes it.
    expect((await discoverTunnels(deps))[0]?.url).toBe("https://revoked-1.trycloudflare.com");
    published = false;
    const res = await startTunnel(4326, deps);
    expect(res).toEqual({
      ok: true,
      tunnel: { port: 4326, pid: 1234, url: "https://fresh-2.trycloudflare.com", alive: true },
    });
    // The revoked tunnel's process was torn down, not left orphaned.
    expect(alive.has(999)).toBe(false);
  });

  // Regression: an NXDOMAIN during the propagation window is NOT revocation.
  // A retry / second tab / agent double-POST arriving before the record
  // publishes must get the SAME tunnel back (pending), not tear it down and
  // restart the DNS race.
  it("keeps an unconfirmed tunnel through an NXDOMAIN instead of respawning it", async () => {
    const alive = new Set<number>([999]);
    await writeFile(tunnelPidfilePath(pidDir, 4326), "999\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://not-yet-1.trycloudflare.com\n", "utf8");
    let spawned = false;
    const res = await startTunnel(4326, {
      pidDir,
      pidIsCloudflared: isCloudflared,
      probeHost: async (): Promise<HostProbeResult> => "nxdomain",
      commandExists: async () => true,
      killFn: makeKill(alive),
      spawnTunnel: async () => {
        spawned = true;
        return 1;
      },
      sleep: noSleep,
    });
    expect(spawned).toBe(false);
    expect(alive.has(999)).toBe(true);
    // Pending, not the unproven URL.
    expect(res).toEqual({ ok: true, tunnel: { port: 4326, pid: 999, url: null, alive: true } });
  });

  // A probe blip (ambiguous) on an unconfirmed hostname holds the URL back —
  // surfacing an unproven URL during a blip invites the same resolver
  // poisoning as surfacing it before propagation.
  it("holds the URL pending on an ambiguous probe of an unconfirmed hostname", async () => {
    const alive = new Set<number>([999]);
    await writeFile(tunnelPidfilePath(pidDir, 4326), "999\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://blip-1.trycloudflare.com\n", "utf8");
    const res = await startTunnel(4326, {
      pidDir,
      pidIsCloudflared: isCloudflared,
      probeHost: async (): Promise<HostProbeResult> => "ambiguous",
      commandExists: async () => true,
      killFn: makeKill(alive),
      spawnTunnel: async () => 1,
      sleep: noSleep,
    });
    expect(res).toEqual({ ok: true, tunnel: { port: 4326, pid: 999, url: null, alive: true } });
  });

  // The inverse blip: a CONFIRMED hostname stays surfaced through an
  // ambiguous probe — proven once is proven, and a blip must not flap the
  // operator's working URL back to "starting…".
  it("keeps a confirmed URL surfaced through an ambiguous probe", async () => {
    const alive = new Set<number>([999]);
    await writeFile(tunnelPidfilePath(pidDir, 4326), "999\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://steady-1.trycloudflare.com\n", "utf8");
    let blip = false;
    const deps = {
      pidDir,
      pidIsCloudflared: isCloudflared,
      probeHost: async (): Promise<HostProbeResult> => (blip ? "ambiguous" : "resolved"),
      commandExists: async () => true,
      killFn: makeKill(alive),
      spawnTunnel: async () => 1,
      sleep: noSleep,
    };
    expect((await discoverTunnels(deps))[0]?.url).toBe("https://steady-1.trycloudflare.com");
    blip = true;
    const res = await startTunnel(4326, deps);
    expect(res).toEqual({
      ok: true,
      tunnel: { port: 4326, pid: 999, url: "https://steady-1.trycloudflare.com", alive: true },
    });
  });

  // Regression: cloudflared prints the URL a moment before Cloudflare publishes
  // the DNS record. Handing that URL over inside the gap invites the first click
  // to pin an NXDOMAIN in the operator's resolver for trycloudflare.com's 1800s
  // SOA minttl — on a tunnel that was about to work.
  it("holds a freshly spawned tunnel pending until its hostname is published", async () => {
    const alive = new Set<number>();
    const res = await startTunnel(4326, {
      pidDir,
      pidIsCloudflared: isCloudflared,
      probeHost: async (): Promise<HostProbeResult> => "nxdomain",
      commandExists: async () => true,
      killFn: makeKill(alive),
      spawnTunnel: async (port, dir) => {
        await writeFile(
          tunnelLogPath(dir, port),
          "https://unpublished-1.trycloudflare.com\n",
          "utf8",
        );
        alive.add(1234);
        return 1234;
      },
      sleep: noSleep,
    });
    expect(res).toEqual({ ok: true, tunnel: { port: 4326, pid: 1234, url: null, alive: true } });
  });

  it("surfaces the URL once the hostname lands mid-poll", async () => {
    const alive = new Set<number>();
    let probes = 0;
    const res = await startTunnel(4326, {
      pidDir,
      pidIsCloudflared: isCloudflared,
      // Publishes on the third lookup, mirroring propagation landing part-way
      // through the poll window.
      probeHost: async (): Promise<HostProbeResult> => (++probes >= 3 ? "resolved" : "nxdomain"),
      commandExists: async () => true,
      killFn: makeKill(alive),
      spawnTunnel: async (port, dir) => {
        await writeFile(
          tunnelLogPath(dir, port),
          "https://lands-late-1.trycloudflare.com\n",
          "utf8",
        );
        alive.add(1234);
        return 1234;
      },
      sleep: noSleep,
    });
    expect(res).toEqual({
      ok: true,
      tunnel: { port: 4326, pid: 1234, url: "https://lands-late-1.trycloudflare.com", alive: true },
    });
    expect(probes).toBe(3);
  });

  // The iteration count alone does not bound the poll: a slow DNS probe can
  // burn many iterations' worth of wall clock on its own.
  it("stops polling at the time budget even when iterations remain", async () => {
    const alive = new Set<number>();
    let probes = 0;
    let clock = 3_000_000;
    const res = await startTunnel(4326, {
      pidDir,
      pidIsCloudflared: isCloudflared,
      // Each lookup burns 5s of the 12s budget and never publishes.
      probeHost: async (): Promise<HostProbeResult> => {
        probes++;
        clock += 5_000;
        return "nxdomain" as const;
      },
      commandExists: async () => true,
      killFn: makeKill(alive),
      spawnTunnel: async (port, dir) => {
        await writeFile(tunnelLogPath(dir, port), "https://slow-1.trycloudflare.com\n", "utf8");
        alive.add(1234);
        return 1234;
      },
      sleep: noSleep,
      now: () => clock,
    });
    // Three passes fit in the budget; the 24-iteration cap would have allowed 24.
    expect(probes).toBe(3);
    expect(res).toEqual({
      ok: true,
      tunnel: { port: 4326, pid: 1234, url: null, alive: true },
    });
  });

  it("keeps a live tunnel whose hostname still resolves", async () => {
    const alive = new Set<number>([999]);
    await writeFile(tunnelPidfilePath(pidDir, 4326), "999\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://good-1.trycloudflare.com\n", "utf8");
    let spawned = false;
    const res = await startTunnel(4326, {
      pidDir,
      ...healthy,
      commandExists: async () => true,
      killFn: makeKill(alive),
      spawnTunnel: async () => {
        spawned = true;
        return 1;
      },
      sleep: noSleep,
    });
    expect(spawned).toBe(false);
    expect(res).toEqual({
      ok: true,
      tunnel: { port: 4326, pid: 999, url: "https://good-1.trycloudflare.com", alive: true },
    });
  });

  // PID recycling: the pidfile names a live process that is no longer ours.
  it("spawns fresh when the pidfile's PID is alive but is not a cloudflared", async () => {
    const alive = new Set<number>([999]);
    await writeFile(tunnelPidfilePath(pidDir, 4326), "999\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://ghost-1.trycloudflare.com\n", "utf8");
    const res = await startTunnel(4326, {
      pidDir,
      probeHost: resolves,
      pidIsCloudflared: async () => false,
      commandExists: async () => true,
      killFn: makeKill(alive),
      spawnTunnel: async (port, dir) => {
        await writeFile(tunnelLogPath(dir, port), "https://real-2.trycloudflare.com\n", "utf8");
        alive.add(4321);
        return 4321;
      },
      sleep: noSleep,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tunnel.url).toBe("https://real-2.trycloudflare.com");
    // The unrelated process that happened to hold PID 999 was never signalled.
    expect(alive.has(999)).toBe(true);
  });

  it("reaps a stale pidfile and spawns fresh", async () => {
    const alive = new Set<number>();
    await writeFile(tunnelPidfilePath(pidDir, 4326), "424242\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://stale-url-1.trycloudflare.com\n", "utf8");
    const res = await startTunnel(4326, {
      pidDir,
      ...healthy,
      commandExists: async () => true,
      killFn: makeKill(alive), // 424242 not in set → dead
      spawnTunnel: async (port, dir) => {
        await writeFile(tunnelLogPath(dir, port), "https://new-url-2.trycloudflare.com\n", "utf8");
        alive.add(321);
        return 321;
      },
      sleep: noSleep,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tunnel.pid).toBe(321);
      expect(res.tunnel.url).toBe("https://new-url-2.trycloudflare.com");
    }
  });

  it("coalesces concurrent starts for the same port into a single spawn", async () => {
    const alive = new Set<number>();
    let spawnCount = 0;
    const deps = {
      pidDir,
      ...healthy,
      commandExists: async (): Promise<boolean> => true,
      killFn: makeKill(alive),
      sleep: noSleep,
      spawnTunnel: async (port: number, dir: string): Promise<number> => {
        spawnCount++;
        await writeFile(tunnelLogPath(dir, port), "https://race-1.trycloudflare.com\n", "utf8");
        alive.add(888);
        return 888;
      },
    };
    const [a, b] = await Promise.all([startTunnel(4326, deps), startTunnel(4326, deps)]);
    expect(spawnCount).toBe(1);
    expect(a).toEqual(b);
    expect(a).toEqual({
      ok: true,
      tunnel: { port: 4326, pid: 888, url: "https://race-1.trycloudflare.com", alive: true },
    });
  });

  it("returns spawn-failed when the spawn throws", async () => {
    const res = await startTunnel(4326, {
      pidDir,
      ...healthy,
      commandExists: async () => true,
      spawnTunnel: async () => {
        throw new Error("boom");
      },
      sleep: noSleep,
    });
    expect(res).toEqual({ ok: false, reason: "spawn-failed", message: "boom" });
  });
});

describe("stopTunnel", () => {
  let pidDir: string;

  beforeEach(async () => {
    pidDir = await mkdtemp(join(tmpdir(), "tunnel-stop-"));
  });
  afterEach(async () => {
    await rm(pidDir, { recursive: true, force: true });
  });

  it("signals a live tunnel and removes its files", async () => {
    const alive = new Set<number>([200]);
    await writeFile(tunnelPidfilePath(pidDir, 4326), "200\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://x-1.trycloudflare.com\n", "utf8");
    const res = await stopTunnel(4326, {
      pidDir,
      ...healthy,
      killFn: makeKill(alive),
      sleep: noSleep,
    });
    expect(res).toEqual({ stopped: true });
    expect(alive.has(200)).toBe(false);
    expect(await exists(tunnelPidfilePath(pidDir, 4326))).toBe(false);
    expect(await exists(tunnelLogPath(pidDir, 4326))).toBe(false);
  });

  it("escalates to SIGKILL when SIGTERM doesn't take", async () => {
    const signals: Array<NodeJS.Signals | 0> = [];
    // A process that ignores SIGTERM but dies on SIGKILL.
    let live = true;
    const killFn = (_pid: number, signal: NodeJS.Signals | 0): void => {
      signals.push(signal);
      if (signal === 0) {
        if (!live) throw new Error("ESRCH");
        return;
      }
      if (signal === "SIGKILL") live = false;
    };
    await writeFile(tunnelPidfilePath(pidDir, 4326), "300\n", "utf8");
    const res = await stopTunnel(4326, { pidDir, ...healthy, killFn, sleep: noSleep });
    expect(res).toEqual({ stopped: true });
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
    expect(live).toBe(false);
  });

  // Worst case of a recycled PID: SIGTERM/SIGKILL aimed at a stranger.
  it("never signals a live PID that is not a cloudflared", async () => {
    const alive = new Set<number>([200]);
    await writeFile(tunnelPidfilePath(pidDir, 4326), "200\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://x-1.trycloudflare.com\n", "utf8");
    const res = await stopTunnel(4326, {
      pidDir,
      probeHost: resolves,
      pidIsCloudflared: async () => false,
      killFn: makeKill(alive),
      sleep: noSleep,
    });
    expect(res).toEqual({ stopped: false });
    expect(alive.has(200)).toBe(true);
    // The stale files are still cleaned up.
    expect(await exists(tunnelPidfilePath(pidDir, 4326))).toBe(false);
  });

  // A recycled PID can land on a DIFFERENT cloudflared (another port's tunnel,
  // or a hand-started one). Matching the binary name alone would let
  // stopTunnel(4326) kill port 4327's tunnel.
  it("never signals a cloudflared that belongs to a different port", async () => {
    const alive = new Set<number>([200]);
    await writeFile(tunnelPidfilePath(pidDir, 4326), "200\n", "utf8");
    const res = await stopTunnel(4326, {
      pidDir,
      probeHost: resolves,
      // Stands in for the real cmdline check: PID 200 is a cloudflared, but
      // it is serving 4327, so it must not match port 4326.
      pidIsCloudflared: async (_pid, port) => port === 4327,
      killFn: makeKill(alive),
      sleep: noSleep,
    });
    expect(res).toEqual({ stopped: false });
    expect(alive.has(200)).toBe(true);
  });

  it("returns stopped:false and reaps files when the pidfile is absent", async () => {
    const res = await stopTunnel(4326, { pidDir, killFn: makeKill(new Set()), sleep: noSleep });
    expect(res).toEqual({ stopped: false });
  });

  it("reaps files for an already-dead PID", async () => {
    await writeFile(tunnelPidfilePath(pidDir, 4326), "999999\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "log\n", "utf8");
    const res = await stopTunnel(4326, { pidDir, killFn: makeKill(new Set()), sleep: noSleep });
    expect(res).toEqual({ stopped: false });
    expect(await exists(tunnelPidfilePath(pidDir, 4326))).toBe(false);
    expect(await exists(tunnelLogPath(pidDir, 4326))).toBe(false);
  });
});

describe("discoverTunnels", () => {
  let pidDir: string;

  beforeEach(async () => {
    pidDir = await mkdtemp(join(tmpdir(), "tunnel-discover-"));
  });
  afterEach(async () => {
    await rm(pidDir, { recursive: true, force: true });
  });

  it("returns live tunnels sorted by port with their URLs", async () => {
    const alive = new Set<number>([10, 20]);
    await writeFile(tunnelPidfilePath(pidDir, 4327), "20\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4327), "https://b-2.trycloudflare.com\n", "utf8");
    await writeFile(tunnelPidfilePath(pidDir, 4326), "10\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://a-1.trycloudflare.com\n", "utf8");
    const tunnels = await discoverTunnels({ pidDir, ...healthy, killFn: makeKill(alive) });
    expect(tunnels).toEqual([
      { port: 4326, pid: 10, url: "https://a-1.trycloudflare.com", alive: true },
      { port: 4327, pid: 20, url: "https://b-2.trycloudflare.com", alive: true },
    ]);
  });

  it("reaps a dead-PID tunnel and omits it", async () => {
    await writeFile(tunnelPidfilePath(pidDir, 4326), "999999\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://gone-1.trycloudflare.com\n", "utf8");
    const tunnels = await discoverTunnels({ pidDir, killFn: makeKill(new Set()) });
    expect(tunnels).toEqual([]);
    expect(await exists(tunnelPidfilePath(pidDir, 4326))).toBe(false);
    expect(await exists(tunnelLogPath(pidDir, 4326))).toBe(false);
  });

  it("reaps and omits a tunnel whose PID was recycled by another process", async () => {
    await writeFile(tunnelPidfilePath(pidDir, 4326), "10\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://ghost-1.trycloudflare.com\n", "utf8");
    const tunnels = await discoverTunnels({
      pidDir,
      probeHost: resolves,
      pidIsCloudflared: async () => false,
      killFn: makeKill(new Set([10])),
    });
    expect(tunnels).toEqual([]);
    expect(await exists(tunnelPidfilePath(pidDir, 4326))).toBe(false);
  });

  it("reports a tunnel whose hostname is not published yet as pending", async () => {
    const alive = new Set<number>([999]);
    await writeFile(tunnelPidfilePath(pidDir, 4326), "999\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://pending-1.trycloudflare.com\n", "utf8");
    const tunnels = await discoverTunnels({
      pidDir,
      pidIsCloudflared: isCloudflared,
      probeHost: async (): Promise<HostProbeResult> => "nxdomain",
      killFn: makeKill(alive),
    });
    expect(tunnels).toEqual([{ port: 4326, pid: 999, url: null, alive: true }]);
  });

  // The refresh loop runs on a tick, so an un-cached probe would mean a DNS
  // lookup per tunnel per tick forever. One success is proof for good.
  it("probes a hostname only until it first resolves", async () => {
    const alive = new Set<number>([999]);
    await writeFile(tunnelPidfilePath(pidDir, 4326), "999\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://cached-1.trycloudflare.com\n", "utf8");
    let probes = 0;
    const deps = {
      pidDir,
      pidIsCloudflared: isCloudflared,
      probeHost: async (): Promise<HostProbeResult> => {
        probes++;
        return "resolved";
      },
      killFn: makeKill(alive),
    };
    expect((await discoverTunnels(deps))[0]?.url).toBe("https://cached-1.trycloudflare.com");
    expect(probes).toBe(1);
    expect((await discoverTunnels(deps))[0]?.url).toBe("https://cached-1.trycloudflare.com");
    expect(probes).toBe(1);
  });

  // A hostname that never publishes would otherwise cost one DNS lookup per
  // refresh tick for the life of the dashboard process.
  it("backs off probing a hostname that never resolves", async () => {
    const alive = new Set<number>([999]);
    await writeFile(tunnelPidfilePath(pidDir, 4326), "999\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://never-1.trycloudflare.com\n", "utf8");
    let probes = 0;
    let clock = 1_000_000;
    const deps = {
      pidDir,
      pidIsCloudflared: isCloudflared,
      probeHost: async (): Promise<HostProbeResult> => {
        probes++;
        return "nxdomain" as const;
      },
      killFn: makeKill(alive),
      now: () => clock,
    };

    expect((await discoverTunnels(deps))[0]?.url).toBeNull();
    expect(probes).toBe(1);

    // Next tick, still inside the first backoff window: no lookup issued.
    clock += 4_000 - 1;
    expect((await discoverTunnels(deps))[0]?.url).toBeNull();
    expect(probes).toBe(1);

    // Past it: one more attempt, and the window doubles.
    clock += 1;
    expect((await discoverTunnels(deps))[0]?.url).toBeNull();
    expect(probes).toBe(2);

    clock += 4_000;
    expect((await discoverTunnels(deps))[0]?.url).toBeNull();
    expect(probes).toBe(2);

    clock += 4_000;
    expect((await discoverTunnels(deps))[0]?.url).toBeNull();
    expect(probes).toBe(3);
  });

  it("resumes surfacing the URL when a backed-off hostname finally resolves", async () => {
    const alive = new Set<number>([999]);
    await writeFile(tunnelPidfilePath(pidDir, 4326), "999\n", "utf8");
    await writeFile(tunnelLogPath(pidDir, 4326), "https://late-1.trycloudflare.com\n", "utf8");
    let published = false;
    let clock = 2_000_000;
    const deps = {
      pidDir,
      pidIsCloudflared: isCloudflared,
      probeHost: async (): Promise<HostProbeResult> =>
        published ? ("resolved" as const) : ("nxdomain" as const),
      killFn: makeKill(alive),
      now: () => clock,
    };

    expect((await discoverTunnels(deps))[0]?.url).toBeNull();
    published = true;
    clock += 4_000;
    expect((await discoverTunnels(deps))[0]?.url).toBe("https://late-1.trycloudflare.com");
  });

  // Without this the confirmation cache leaks one entry per share cycle for the
  // life of the dashboard process.
  it("re-probes a hostname after its tunnel has been stopped", async () => {
    const alive = new Set<number>([999]);
    let probes = 0;
    const probeHost = async (): Promise<HostProbeResult> => {
      probes++;
      return "resolved";
    };
    const write = async (): Promise<void> => {
      await writeFile(tunnelPidfilePath(pidDir, 4326), "999\n", "utf8");
      await writeFile(
        tunnelLogPath(pidDir, 4326),
        "https://restopped-1.trycloudflare.com\n",
        "utf8",
      );
    };
    await write();
    await discoverTunnels({
      pidDir,
      pidIsCloudflared: isCloudflared,
      probeHost,
      killFn: makeKill(alive),
    });
    expect(probes).toBe(1);

    await stopTunnel(4326, {
      pidDir,
      pidIsCloudflared: isCloudflared,
      killFn: makeKill(alive),
      sleep: noSleep,
    });
    await write();
    alive.add(999);
    await discoverTunnels({
      pidDir,
      pidIsCloudflared: isCloudflared,
      probeHost,
      killFn: makeKill(alive),
    });
    expect(probes).toBe(2);
  });

  it("ignores non-tunnel files in the pid dir", async () => {
    await writeFile(join(pidDir, "minimal-dev-4321.pid"), "1\n", "utf8");
    await writeFile(join(pidDir, "unrelated.txt"), "x\n", "utf8");
    const tunnels = await discoverTunnels({ pidDir, killFn: makeKill(new Set([1])) });
    expect(tunnels).toEqual([]);
  });
});
