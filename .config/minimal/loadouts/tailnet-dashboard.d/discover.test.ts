import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetAssignedIssuesCache,
  _resetPrCache,
  type AssignedIssue,
  defaultGroupMemberPid,
  discover,
  discoverAssignedIssues,
  type ExecFn,
  parseWorktreePorcelain,
  pgrpFromStat,
  portFromPidfile,
  readAssignedIssuesState,
  writeAssignedIssuesState,
} from "./discover.ts";

describe("parseWorktreePorcelain", () => {
  it("parses the multi-worktree porcelain output", () => {
    const out = [
      "worktree /a/main",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree /a/.worktrees/issue-1",
      "HEAD bbbb",
      "branch refs/heads/issue-1",
      "",
    ].join("\n");
    expect(parseWorktreePorcelain(out)).toEqual([
      { path: "/a/main", branch: "main" },
      { path: "/a/.worktrees/issue-1", branch: "issue-1" },
    ]);
  });

  it("handles a trailing entry without a closing blank line", () => {
    const out = ["worktree /a/main", "branch refs/heads/main"].join("\n");
    expect(parseWorktreePorcelain(out)).toEqual([{ path: "/a/main", branch: "main" }]);
  });

  it("labels detached HEADs", () => {
    const out = ["worktree /a/detached", "HEAD cccc", "detached", ""].join("\n");
    expect(parseWorktreePorcelain(out)).toEqual([{ path: "/a/detached", branch: "(detached)" }]);
  });
});

describe("portFromPidfile", () => {
  it("maps the legacy .dev.pid to the default port", () => {
    expect(portFromPidfile(".dev.pid")).toBe(4321);
  });

  it("extracts the port from .dev-NNNN.pid", () => {
    expect(portFromPidfile(".dev-4325.pid")).toBe(4325);
  });

  it("rejects unrelated filenames", () => {
    expect(portFromPidfile(".dashboard.pid")).toBeNull();
    expect(portFromPidfile("dev.pid")).toBeNull();
    expect(portFromPidfile(".dev-.pid")).toBeNull();
    expect(portFromPidfile(".dev-abc.pid")).toBeNull();
  });

  it("rejects out-of-range ports", () => {
    expect(portFromPidfile(".dev-0.pid")).toBeNull();
    expect(portFromPidfile(".dev-80.pid")).toBeNull();
    expect(portFromPidfile(".dev-70000.pid")).toBeNull();
  });
});

describe("discover", () => {
  let root: string;

  beforeEach(async () => {
    _resetPrCache();
    root = await mkdtemp(join(tmpdir(), "dash-discover-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns one row per live dev pidfile and includes PR metadata", async () => {
    const mainPid = process.pid;
    await writeFile(join(root, ".dev.pid"), `${mainPid}\n`, "utf8");

    const calls: string[] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "git" && args[0] === "-C") {
        return [`worktree ${root}`, "branch refs/heads/main", ""].join("\n");
      }
      if (cmd === "gh") {
        return JSON.stringify([
          { number: 42, title: "Test PR", url: "https://example/42", state: "OPEN" },
        ]);
      }
      throw new Error(`unexpected exec: ${cmd}`);
    };

    const rows = await discover(root, {
      exec,
      killFn: () => undefined,
      probeHealth: async () => true,
    });

    expect(rows).toEqual([
      {
        branch: "main",
        port: 4321,
        worktreePath: root,
        prNumber: 42,
        prTitle: "Test PR",
        prUrl: "https://example/42",
        prState: "OPEN",
        alive: true,
      },
    ]);
    expect(calls.some((c) => c.startsWith("gh pr list --state all --head main"))).toBe(true);
  });

  it("returns no row when the worktree has no pidfile", async () => {
    const exec: ExecFn = async (cmd) => {
      if (cmd === "git") return [`worktree ${root}`, "branch refs/heads/main", ""].join("\n");
      return "[]";
    };
    expect(await discover(root, { exec, killFn: () => undefined })).toEqual([]);
  });

  it("drops rows whose PID is dead", async () => {
    await writeFile(join(root, ".dev-4322.pid"), "999999\n", "utf8");
    const exec: ExecFn = async (cmd) => {
      if (cmd === "git") return [`worktree ${root}`, "branch refs/heads/issue-1", ""].join("\n");
      return "[]";
    };
    const killFn = (): void => {
      throw new Error("ESRCH");
    };
    expect(await discover(root, { exec, killFn })).toEqual([]);
  });

  it("returns a row without PR metadata when gh fails", async () => {
    await writeFile(join(root, ".dev-4323.pid"), `${process.pid}\n`, "utf8");
    const warn = console.warn;
    console.warn = (): void => undefined;
    try {
      const exec: ExecFn = async (cmd) => {
        if (cmd === "git") return [`worktree ${root}`, "branch refs/heads/issue-2", ""].join("\n");
        throw new Error("gh not found");
      };
      const rows = await discover(root, {
        exec,
        killFn: () => undefined,
        probeHealth: async () => true,
      });
      expect(rows).toEqual([{ branch: "issue-2", port: 4323, worktreePath: root, alive: true }]);
    } finally {
      console.warn = warn;
    }
  });

  it("returns a row without PR metadata when gh returns an empty list", async () => {
    await writeFile(join(root, ".dev-4324.pid"), `${process.pid}\n`, "utf8");
    const exec: ExecFn = async (cmd) => {
      if (cmd === "git") return [`worktree ${root}`, "branch refs/heads/no-pr", ""].join("\n");
      return "[]";
    };
    const rows = await discover(root, {
      exec,
      killFn: () => undefined,
      probeHealth: async () => true,
    });
    expect(rows).toEqual([{ branch: "no-pr", port: 4324, worktreePath: root, alive: true }]);
  });

  it("sorts rows by port", async () => {
    await writeFile(join(root, ".dev-4325.pid"), `${process.pid}\n`, "utf8");
    await writeFile(join(root, ".dev-4322.pid"), `${process.pid}\n`, "utf8");
    const exec: ExecFn = async (cmd) => {
      if (cmd === "git") return [`worktree ${root}`, "branch refs/heads/multi", ""].join("\n");
      return "[]";
    };
    const rows = await discover(root, {
      exec,
      killFn: () => undefined,
      probeHealth: async () => true,
    });
    expect(rows.map((r) => r.port)).toEqual([4322, 4325]);
  });

  it("discovers a $TMPDIR pidfile and matches it to its worktree via cwd", async () => {
    const pidDir = await mkdtemp(join(tmpdir(), "dash-tmpdir-"));
    try {
      await writeFile(join(pidDir, "minimal-dev-4323.pid"), `${process.pid}\n`, "utf8");
      const exec: ExecFn = async (cmd) => {
        if (cmd === "git") return [`worktree ${root}`, "branch refs/heads/issue-3", ""].join("\n");
        return "[]";
      };
      // The dev server's cwd is the worktree root.
      const pidCwd = async (): Promise<string> => root;
      const rows = await discover(root, {
        exec,
        killFn: () => undefined,
        pidDir,
        pidCwd,
        probeHealth: async () => true,
      });
      expect(rows).toEqual([{ branch: "issue-3", port: 4323, worktreePath: root, alive: true }]);
    } finally {
      await rm(pidDir, { recursive: true, force: true });
    }
  });

  it("recovers a server whose setsid leader died via a surviving group member", async () => {
    const pidDir = await mkdtemp(join(tmpdir(), "dash-tmpdir-"));
    try {
      const leaderPid = 54321;
      const memberPid = 54322;
      await writeFile(join(pidDir, "minimal-dev-4327.pid"), `${leaderPid}\n`, "utf8");
      const exec: ExecFn = async (cmd) => {
        if (cmd === "git") return [`worktree ${root}`, "branch refs/heads/orphan", ""].join("\n");
        return "[]";
      };
      // Leader's /proc entry is gone; only the surviving member resolves.
      const pidCwd = async (pid: number): Promise<string | null> =>
        pid === memberPid ? root : null;
      const rows = await discover(root, {
        exec,
        // Group probe (negative pid) succeeds — a member is still alive —
        // while the plain leader pid probe fails, as after a leader death.
        killFn: (pid) => {
          if (pid >= 0) throw new Error("ESRCH");
        },
        pidDir,
        pidCwd,
        groupMemberPid: async (pgid) => (pgid === leaderPid ? memberPid : null),
        probeHealth: async () => true,
      });
      expect(rows).toEqual([{ branch: "orphan", port: 4327, worktreePath: root, alive: true }]);
    } finally {
      await rm(pidDir, { recursive: true, force: true });
    }
  });

  it("drops a pidfile whose leader is dead and group has no survivors", async () => {
    const pidDir = await mkdtemp(join(tmpdir(), "dash-tmpdir-"));
    try {
      await writeFile(join(pidDir, "minimal-dev-4328.pid"), "54331\n", "utf8");
      const exec: ExecFn = async (cmd) => {
        if (cmd === "git") return [`worktree ${root}`, "branch refs/heads/gone", ""].join("\n");
        return "[]";
      };
      const rows = await discover(root, {
        exec,
        killFn: () => {
          throw new Error("ESRCH");
        },
        pidDir,
        pidCwd: async () => null,
        groupMemberPid: async () => null,
        probeHealth: async () => true,
      });
      expect(rows).toEqual([]);
    } finally {
      await rm(pidDir, { recursive: true, force: true });
    }
  });

  it("ignores a $TMPDIR pidfile whose cwd is not a known worktree", async () => {
    const pidDir = await mkdtemp(join(tmpdir(), "dash-tmpdir-"));
    try {
      await writeFile(join(pidDir, "minimal-dev-4399.pid"), `${process.pid}\n`, "utf8");
      const exec: ExecFn = async (cmd) => {
        if (cmd === "git") return [`worktree ${root}`, "branch refs/heads/main", ""].join("\n");
        return "[]";
      };
      const pidCwd = async (): Promise<string> => "/some/other/worktree";
      const rows = await discover(root, { exec, killFn: () => undefined, pidDir, pidCwd });
      expect(rows).toEqual([]);
    } finally {
      await rm(pidDir, { recursive: true, force: true });
    }
  });

  it("dedupes a port present in both the worktree and $TMPDIR", async () => {
    const pidDir = await mkdtemp(join(tmpdir(), "dash-tmpdir-"));
    try {
      await writeFile(join(root, ".dev-4326.pid"), `${process.pid}\n`, "utf8");
      await writeFile(join(pidDir, "minimal-dev-4326.pid"), `${process.pid}\n`, "utf8");
      const exec: ExecFn = async (cmd) => {
        if (cmd === "git") return [`worktree ${root}`, "branch refs/heads/dup", ""].join("\n");
        return "[]";
      };
      const pidCwd = async (): Promise<string> => root;
      const rows = await discover(root, {
        exec,
        killFn: () => undefined,
        pidDir,
        pidCwd,
        probeHealth: async () => true,
      });
      expect(rows.map((r) => r.port)).toEqual([4326]);
    } finally {
      await rm(pidDir, { recursive: true, force: true });
    }
  });

  it("drops a stale pidfile whose recorded PID is dead", async () => {
    // A leftover `.dev-*.pid` from a crashed server: the PID no longer exists,
    // so `kill -0` throws and the row must not appear even though probeHealth
    // would happily return 200 (a different server may hold the port).
    await writeFile(join(root, ".dev-4330.pid"), "999999\n", "utf8");
    const exec: ExecFn = async (cmd) => {
      if (cmd === "git") return [`worktree ${root}`, "branch refs/heads/stale", ""].join("\n");
      return "[]";
    };
    const killFn = (): void => {
      throw new Error("ESRCH");
    };
    const rows = await discover(root, { exec, killFn, probeHealth: async () => true });
    expect(rows).toEqual([]);
  });

  it("drops an orphaned $TMPDIR server whose cwd resolves to (deleted)", async () => {
    // After `git worktree remove`, an orphaned dev server lingers with its cwd
    // unlinked: Linux reports `/proc/<pid>/cwd` as `<path> (deleted)`. It keeps
    // holding its port and serving 500s, so it must never be attributed to a
    // live worktree row — even though the PID is alive and the cwd prefix
    // matches a (now-removed) worktree path.
    const pidDir = await mkdtemp(join(tmpdir(), "dash-tmpdir-"));
    try {
      await writeFile(join(pidDir, "minimal-dev-4331.pid"), `${process.pid}\n`, "utf8");
      const exec: ExecFn = async (cmd) => {
        if (cmd === "git") return [`worktree ${root}`, "branch refs/heads/main", ""].join("\n");
        return "[]";
      };
      const pidCwd = async (): Promise<string> => `${root} (deleted)`;
      const rows = await discover(root, {
        exec,
        killFn: () => undefined,
        pidDir,
        pidCwd,
        probeHealth: async () => true,
      });
      expect(rows).toEqual([]);
    } finally {
      await rm(pidDir, { recursive: true, force: true });
    }
  });

  it("drops a server whose recorded port no longer serves /healthcheck", async () => {
    // Recorded-port ≠ listening-port drift: the pidfile says 4339 and the PID is
    // alive, but the server actually bound a different port (silent Vite walk)
    // or is wedged. The /healthcheck probe on 4339 fails, so the row is dropped
    // — the dashboard never advertises a port that isn't really serving.
    await writeFile(join(root, ".dev-4339.pid"), `${process.pid}\n`, "utf8");
    const exec: ExecFn = async (cmd) => {
      if (cmd === "git") return [`worktree ${root}`, "branch refs/heads/drift", ""].join("\n");
      return "[]";
    };
    const probedPorts: number[] = [];
    const probeHealth = async (port: number): Promise<boolean> => {
      probedPorts.push(port);
      return false; // nothing is actually serving the recorded port
    };
    const rows = await discover(root, { exec, killFn: () => undefined, probeHealth });
    expect(rows).toEqual([]);
    expect(probedPorts).toEqual([4339]);
  });

  it("keeps a server whose recorded port serves /healthcheck", async () => {
    // The positive of the drift case: PID alive AND the recorded port answers
    // /healthcheck with 200, so the row is emitted with the recorded port.
    await writeFile(join(root, ".dev-4340.pid"), `${process.pid}\n`, "utf8");
    const exec: ExecFn = async (cmd) => {
      if (cmd === "git") return [`worktree ${root}`, "branch refs/heads/healthy", ""].join("\n");
      return "[]";
    };
    const probeHealth = async (port: number): Promise<boolean> => port === 4340;
    const rows = await discover(root, { exec, killFn: () => undefined, probeHealth });
    expect(rows).toEqual([{ branch: "healthy", port: 4340, worktreePath: root, alive: true }]);
  });
});

describe("discoverAssignedIssues", () => {
  beforeEach(() => _resetAssignedIssuesCache());
  afterEach(() => vi.restoreAllMocks());

  it("runs gh issue list with the assignee filter and parses the JSON", async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return JSON.stringify([
        { number: 7, title: "Fix the thing", url: "https://example/7" },
        { number: 9, title: "Add the other thing", url: "https://example/9" },
      ]);
    };
    const issues = await discoverAssignedIssues({ exec, assignee: "agent137" });
    expect(issues).toEqual([
      { number: 7, title: "Fix the thing", url: "https://example/7" },
      { number: 9, title: "Add the other thing", url: "https://example/9" },
    ]);
    expect(
      calls.some((c) =>
        c.startsWith("gh issue list --assignee agent137 --state open --json number,title,url"),
      ),
    ).toBe(true);
  });

  it("caches results within the TTL so gh is not called twice", async () => {
    let calls = 0;
    const exec: ExecFn = async () => {
      calls += 1;
      return JSON.stringify([{ number: 1, title: "x", url: "https://example/1" }]);
    };
    const now = () => 1_000;
    await discoverAssignedIssues({ exec, now });
    await discoverAssignedIssues({ exec, now });
    expect(calls).toBe(1);
  });

  it("re-queries gh after the TTL expires", async () => {
    let calls = 0;
    const exec: ExecFn = async () => {
      calls += 1;
      return "[]";
    };
    await discoverAssignedIssues({ exec, now: () => 1_000 });
    await discoverAssignedIssues({ exec, now: () => 1_000 + 60_001 });
    expect(calls).toBe(2);
  });

  it("returns an empty list without calling gh when the assignee is empty", async () => {
    let calls = 0;
    const exec: ExecFn = async () => {
      calls += 1;
      return "[]";
    };
    expect(await discoverAssignedIssues({ exec, assignee: "" })).toEqual([]);
    expect(calls).toBe(0);
  });

  it("returns an empty list when gh fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const exec: ExecFn = async () => {
      throw new Error("gh not found");
    };
    expect(await discoverAssignedIssues({ exec })).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns an empty list when gh returns malformed JSON", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const exec: ExecFn = async () => "not json";
    expect(await discoverAssignedIssues({ exec })).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("caches a failure for the shorter error TTL, not the full success TTL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const exec: ExecFn = async () => {
      calls += 1;
      throw new Error("gh not found");
    };
    // First call fails and caches [] for the 10s error TTL.
    await discoverAssignedIssues({ exec, now: () => 0 });
    // Within the error TTL the cache is reused.
    await discoverAssignedIssues({ exec, now: () => 9_000 });
    expect(calls).toBe(1);
    // Past the error TTL (but well within the 60s success TTL) it re-queries.
    await discoverAssignedIssues({ exec, now: () => 11_000 });
    expect(calls).toBe(2);
  });
});

describe("assigned-issues state file", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "assigned-state-"));
    statePath = join(dir, "agent137-assigned-issues.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null for a missing state file", async () => {
    expect(await readAssignedIssuesState(statePath)).toBeNull();
  });

  it("returns null for a malformed state file", async () => {
    await writeFile(statePath, "{ not valid", "utf8");
    expect(await readAssignedIssuesState(statePath)).toBeNull();
  });

  it("round-trips the issue set and reports all as new on first write", async () => {
    const issues: AssignedIssue[] = [
      { number: 3, title: "First", url: "https://example/3" },
      { number: 4, title: "Second", url: "https://example/4" },
    ];
    const fresh = await writeAssignedIssuesState(issues, { statePath, now: () => 0 });
    expect(fresh).toEqual([3, 4]);

    const state = await readAssignedIssuesState(statePath);
    expect(state?.assignee).toBe("agent-137");
    expect(state?.issues).toEqual(issues);
  });

  it("flags only issues new since the previous snapshot", async () => {
    await writeAssignedIssuesState([{ number: 3, title: "First", url: "https://example/3" }], {
      statePath,
      now: () => 0,
    });
    const fresh = await writeAssignedIssuesState(
      [
        { number: 3, title: "First", url: "https://example/3" },
        { number: 5, title: "Newly assigned", url: "https://example/5" },
      ],
      { statePath, now: () => 1 },
    );
    expect(fresh).toEqual([5]);
  });
});

describe("pgrpFromStat", () => {
  it("parses pgrp when comm contains spaces and parens", () => {
    // Fields after the LAST ")" are `state ppid pgrp ...`; everything before
    // it (including nested parens/spaces in comm) must be ignored.
    expect(pgrpFromStat("1234 (tmux: server) (v2)) S 1 5678 9012 0 -1")).toBe(5678);
    expect(pgrpFromStat("42 (node) R 1 42 42 0 -1")).toBe(42);
  });

  it("returns null on malformed input", () => {
    expect(pgrpFromStat("")).toBeNull();
    expect(pgrpFromStat("no stat fields here")).toBeNull();
    expect(pgrpFromStat("99 (comm) S")).toBeNull();
  });
});

describe("defaultGroupMemberPid", () => {
  // The real /proc scan is Linux-only by design (macOS uses the ps fallback
  // paths elsewhere); on a darwin host this would poll /proc for 2s and fail.
  it.runIf(process.platform === "linux")("finds a real group member via /proc", async () => {
    // A detached shell becomes leader of a FRESH process group (pgid == its
    // own pid) and forks a sleep into that group — a member the scan must
    // find. Anchoring on a group we create keeps the test independent of
    // the runner's own group id, which reads as 0 inside CI's pid
    // namespace (the leader lives outside the namespace).
    const leader = spawn("bash", ["-c", "sleep 10 & wait"], { detached: true });
    const pgid = leader.pid;
    if (pgid === undefined) throw new Error("spawn returned no pid");
    try {
      let member: number | null = null;
      // The sleep forks asynchronously; poll briefly until it appears.
      for (let i = 0; i < 40 && member === null; i++) {
        member = await defaultGroupMemberPid(pgid);
        if (member === null) await new Promise((r) => setTimeout(r, 50));
      }
      expect(member).not.toBeNull();
      expect(member).not.toBe(pgid);
    } finally {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Group already gone.
      }
    }
  });
});
