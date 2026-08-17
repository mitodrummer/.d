import { afterEach, describe, expect, it } from "vitest";

import { _resetServed, ensureServed, type RunFn, TS_SOCK } from "./tailnet-serve.ts";

describe("ensureServed", () => {
  afterEach(() => _resetServed());

  function recorder(): { calls: Array<{ cmd: string; args: readonly string[] }>; run: RunFn } {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const run: RunFn = async (cmd, args) => {
      calls.push({ cmd, args });
    };
    return { calls, run };
  }

  it("serves each port with the exact tailscale invocation", async () => {
    const { calls, run } = recorder();
    await ensureServed([4320, 4322], { run, socketExists: async () => true });
    expect(calls).toEqual([
      {
        cmd: "tailscale",
        args: [`--socket=${TS_SOCK}`, "serve", "--bg", "--http=4320", "localhost:4320"],
      },
      {
        cmd: "tailscale",
        args: [`--socket=${TS_SOCK}`, "serve", "--bg", "--http=4322", "localhost:4322"],
      },
    ]);
  });

  it("memoizes served ports so repeat calls issue nothing", async () => {
    const { calls, run } = recorder();
    const deps = { run, socketExists: async () => true };
    await ensureServed([4320], deps);
    await ensureServed([4320], deps);
    expect(calls).toHaveLength(1);
  });

  it("skips without probing serve while the socket is absent, then catches up", async () => {
    const { calls, run } = recorder();
    let up = false;
    const deps = { run, socketExists: async () => up };
    await ensureServed([4320], deps);
    expect(calls).toHaveLength(0);
    up = true;
    await ensureServed([4320], deps);
    expect(calls).toHaveLength(1);
  });

  it("retries a failed serve on the next call instead of memoizing it", async () => {
    let attempts = 0;
    const run: RunFn = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("serve timed out");
    };
    const deps = { run, socketExists: async () => true };
    await ensureServed([4320], deps);
    await ensureServed([4320], deps);
    expect(attempts).toBe(2);
    // Now memoized: a third call issues nothing.
    await ensureServed([4320], deps);
    expect(attempts).toBe(2);
  });

  it("does not check the socket when every port is already served", async () => {
    const { run } = recorder();
    let socketProbes = 0;
    const deps = {
      run,
      socketExists: async () => {
        socketProbes += 1;
        return true;
      },
    };
    await ensureServed([4320], deps);
    await ensureServed([4320], deps);
    expect(socketProbes).toBe(1);
  });
});
