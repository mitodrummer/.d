// Drive sandbox-dashboard.ts's exported handle() with stubbed
// req/res. The dashboard runs in-sandbox and isn't part of Playwright's
// webServer config, so a route-level unit test is the right granularity
// — it covers status codes, content types, and body shape without
// binding a real socket.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetBadgeBaseline,
  _setNodeNameFile,
  handle,
  selectDirectHost,
} from "./sandbox-dashboard.ts";

type Ifaces = Parameters<typeof selectDirectHost>[0];

// Minimal os.networkInterfaces()-shaped fixture; only the fields
// selectDirectHost reads are populated.
function iface(address: string, internal: boolean, family: "IPv4" | "IPv6" = "IPv4"): Ifaces {
  return {
    test0: [{ address, family, internal, netmask: "", mac: "", cidr: null }],
  } as unknown as Ifaces;
}

interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function recordResponse(): { res: import("node:http").ServerResponse; recorded: RecordedResponse } {
  const recorded: RecordedResponse = { status: 0, headers: {}, body: "" };
  const res = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>): void {
      recorded.status = status;
      recorded.headers = headers;
      this.headersSent = true;
    },
    end(body?: string): void {
      recorded.body = body ?? "";
    },
  };
  return { res: res as unknown as import("node:http").ServerResponse, recorded };
}

function makeReq(url: string): import("node:http").IncomingMessage {
  return { url, headers: undefined } as unknown as import("node:http").IncomingMessage;
}

// A POST request whose body is exposed as the async-iterable readJsonBody()
// consumes. Header keys are lowercased, matching Node's IncomingMessage.
function makePostReq(
  url: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): import("node:http").IncomingMessage {
  const body = Buffer.from(opts.body ?? "", "utf8");
  return {
    method: "POST",
    url,
    headers: opts.headers ?? {},
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      yield body;
    },
  } as unknown as import("node:http").IncomingMessage;
}

describe("sandbox-dashboard handle()", () => {
  // Point tailnetHost() at a per-test fixture path (missing by default) so
  // assertions don't depend on whether this checkout has a live tailnet
  // node-name file.
  let nodeNameDir: string;
  let nodeNameFile: string;

  beforeEach(() => {
    _resetBadgeBaseline();
    nodeNameDir = mkdtempSync(join(tmpdir(), "dashboard-node-name-"));
    nodeNameFile = join(nodeNameDir, "node-name");
    _setNodeNameFile(nodeNameFile);
  });

  afterEach(() => {
    _setNodeNameFile(null);
    rmSync(nodeNameDir, { recursive: true, force: true });
  });

  it("serves /healthz as text/plain OK", async () => {
    const { res, recorded } = recordResponse();
    await handle(makeReq("/healthz"), res);
    expect(recorded.status).toBe(200);
    expect(recorded.headers["Content-Type"]).toMatch(/text\/plain/);
    expect(recorded.body).toBe("OK");
  });

  // These three tests drive the real handle() → loadManifest(), which calls
  // discover() (one `gh pr list` per worktree) plus discoverAssignedIssues()
  // (one `gh issue list`). In a multi-worktree sandbox that's many serial live
  // `gh` calls, so they get a generous timeout — CI runs a single-worktree
  // checkout where this completes well under the default.
  const LIVE_GH_TIMEOUT_MS = 30_000;

  it(
    "serves /manifest.json with worktrees, assignedIssues, and a directHost field",
    async () => {
      const { res, recorded } = recordResponse();
      await handle(makeReq("/manifest.json"), res);
      expect(recorded.status).toBe(200);
      expect(recorded.headers["Content-Type"]).toMatch(/application\/json/);
      expect(recorded.headers["Cache-Control"]).toMatch(/no-store/);
      const parsed: unknown = JSON.parse(recorded.body);
      expect(parsed).toMatchObject({
        worktrees: expect.any(Array),
        assignedIssues: expect.any(Array),
        newAssignedIssueNumbers: expect.any(Array),
      });
      // directHost is the sandbox's primary IPv4 string, or null when only
      // loopback is present (e.g. an isolated CI runner).
      const directHost = (parsed as { directHost: unknown }).directHost;
      expect(directHost === null || typeof directHost === "string").toBe(true);
    },
    LIVE_GH_TIMEOUT_MS,
  );

  it(
    "resolves tailnetHost from the node-name file and seeds the page with it",
    async () => {
      writeFileSync(nodeNameFile, "sandbox-2\n");
      const manifest = recordResponse();
      await handle(makeReq("/manifest.json"), manifest.res);
      expect(JSON.parse(manifest.recorded.body)).toMatchObject({ tailnetHost: "sandbox-2" });

      const page = recordResponse();
      await handle(makeReq("/"), page.res);
      // The deduped name reaches both the client seed and the subtitle example.
      expect(page.recorded.body).toContain('let TAILNET_HOST = "sandbox-2"');
      expect(page.recorded.body).toContain("http://sandbox-2:&lt;port&gt;");
    },
    LIVE_GH_TIMEOUT_MS,
  );

  it(
    "falls back to the fixed tailnet host when the node-name file is missing",
    async () => {
      const { res, recorded } = recordResponse();
      await handle(makeReq("/manifest.json"), res);
      expect(JSON.parse(recorded.body)).toMatchObject({ tailnetHost: "sandbox" });
    },
    LIVE_GH_TIMEOUT_MS,
  );

  it(
    "rejects malformed node-name content rather than injecting it into the page",
    async () => {
      writeFileSync(nodeNameFile, "<script>alert(1)</script>\n");
      const { res, recorded } = recordResponse();
      await handle(makeReq("/manifest.json"), res);
      expect(JSON.parse(recorded.body)).toMatchObject({ tailnetHost: "sandbox" });
    },
    LIVE_GH_TIMEOUT_MS,
  );

  it(
    "serves / as HTML with the tailnet link, the refresh script, and the dual-URL header",
    async () => {
      const { res, recorded } = recordResponse();
      await handle(makeReq("/"), res);
      expect(recorded.status).toBe(200);
      expect(recorded.headers["Content-Type"]).toMatch(/text\/html/);
      expect(recorded.body).toContain("<!doctype html>");
      expect(recorded.body).toContain("Sandbox dev servers");
      // The URL column header reflects the two-link (tailnet + direct) model.
      expect(recorded.body).toContain("<th>URLs</th>");
      // Body either lists a running dev server with the fixed tailnet name, or
      // shows the no-dev-servers empty state. Either is a valid render.
      const hasTailnetLink = /http:\/\/sandbox:\d+/.test(recorded.body);
      const hasEmpty = recorded.body.includes("No dev servers running");
      expect(hasTailnetLink || hasEmpty).toBe(true);
      expect(recorded.body).toContain("/manifest.json");
      // The client-side refresh path uses the fixed tailnet host, not the
      // request origin.
      expect(recorded.body).toContain("TAILNET_HOST");
    },
    LIVE_GH_TIMEOUT_MS,
  );

  it(
    "renders a direct (same-network) link alongside the tailnet link when a dev server is running",
    async () => {
      const { res, recorded } = recordResponse();
      await handle(makeReq("/"), res);
      expect(recorded.status).toBe(200);
      // Only assert when a dev server is actually listed (CI may have none).
      if (/http:\/\/sandbox:\d+/.test(recorded.body)) {
        // The tailnet link is always present; the direct link appears only
        // when the sandbox has a non-loopback IPv4 (label disambiguates them).
        expect(recorded.body).toContain("tailnet · anywhere");
        if (/http:\/\/[\d.]+:\d+/.test(recorded.body)) {
          expect(recorded.body).toContain("direct · fast, same network");
        }
      }
    },
    LIVE_GH_TIMEOUT_MS,
  );

  it("matches /manifest.json even with a cache-busting query string", async () => {
    const { res, recorded } = recordResponse();
    await handle(makeReq("/manifest.json?ts=123"), res);
    expect(recorded.status).toBe(200);
    expect(recorded.headers["Content-Type"]).toMatch(/application\/json/);
  });

  it("404s an unknown path", async () => {
    const { res, recorded } = recordResponse();
    await handle(makeReq("/nope"), res);
    expect(recorded.status).toBe(404);
    expect(recorded.body).toMatch(/Not found/);
  });

  it("html-escapes the unknown path so a crafted URL cannot inject markup", async () => {
    const { res, recorded } = recordResponse();
    await handle(makeReq("/<script>alert(1)</script>"), res);
    expect(recorded.status).toBe(404);
    expect(recorded.body).not.toContain("<script>");
    expect(recorded.body).toContain("&lt;script&gt;");
  });

  // CSRF guard on the mutating tunnel actions: a drive-by page in the operator's
  // browser must not be able to open/close a public tunnel. The guard runs
  // before handleTunnelAction, so rejections never reach discover()/startTunnel.
  it("rejects a tunnel POST without Content-Type: application/json (415)", async () => {
    const { res, recorded } = recordResponse();
    await handle(
      makePostReq("/tunnels/share", {
        headers: { "content-type": "text/plain", host: "sandbox:4320" },
        body: '{"port":4321}',
      }),
      res,
    );
    expect(recorded.status).toBe(415);
    expect(JSON.parse(recorded.body)).toMatchObject({ ok: false });
  });

  it("rejects a cross-origin tunnel POST (403)", async () => {
    const { res, recorded } = recordResponse();
    await handle(
      makePostReq("/tunnels/share", {
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          host: "sandbox:4320",
        },
        body: '{"port":4321}',
      }),
      res,
    );
    expect(recorded.status).toBe(403);
    expect(JSON.parse(recorded.body)).toMatchObject({ ok: false });
  });

  it("allows a same-origin JSON tunnel POST through the guard", async () => {
    const { res, recorded } = recordResponse();
    // /tunnels/stop for an unshared port is deterministic (no discover(), no
    // cloudflared): reaching {ok:true, stopped:false} proves the guard passed.
    await handle(
      makePostReq("/tunnels/stop", {
        headers: {
          "content-type": "application/json",
          origin: "http://sandbox:4320",
          host: "sandbox:4320",
        },
        body: '{"port":4999}',
      }),
      res,
    );
    expect(recorded.status).toBe(200);
    expect(JSON.parse(recorded.body)).toEqual({ ok: true, stopped: false });
  });

  it("allows an Origin-less (non-browser) JSON tunnel POST", async () => {
    const { res, recorded } = recordResponse();
    await handle(
      makePostReq("/tunnels/stop", {
        headers: { "content-type": "application/json", host: "sandbox:4320" },
        body: '{"port":4999}',
      }),
      res,
    );
    expect(recorded.status).toBe(200);
    expect(JSON.parse(recorded.body)).toEqual({ ok: true, stopped: false });
  });

  it("rejects a tunnel POST with a missing port (400)", async () => {
    const { res, recorded } = recordResponse();
    await handle(
      makePostReq("/tunnels/stop", {
        headers: { "content-type": "application/json", host: "sandbox:4320" },
        body: "{}",
      }),
      res,
    );
    expect(recorded.status).toBe(400);
    expect(JSON.parse(recorded.body)).toMatchObject({ ok: false });
  });
});

describe("selectDirectHost()", () => {
  it("returns the VM-bridge address the Mac subnet route covers", () => {
    expect(selectDirectHost(iface("192.168.64.7", false))).toBe("192.168.64.7");
  });

  it("returns null for a NAT-only sandbox (Minimal v2 hands out 100.64.0.0/16)", () => {
    // Regression: this address is non-internal, so a bare "first non-loopback
    // IPv4" pick advertised it as a Direct link that nothing could route to.
    expect(selectDirectHost(iface("100.64.255.253", false))).toBeNull();
  });

  it("returns null when only loopback is present", () => {
    expect(selectDirectHost(iface("127.0.0.1", true))).toBeNull();
  });

  it("ignores IPv6 addresses", () => {
    expect(selectDirectHost(iface("fe80::1", false, "IPv6"))).toBeNull();
  });

  it("picks the VM-bridge address even when another interface sorts first", () => {
    const mixed = {
      eth0: [
        {
          address: "100.64.255.253",
          family: "IPv4",
          internal: false,
          netmask: "",
          mac: "",
          cidr: null,
        },
      ],
      bridge0: [
        {
          address: "192.168.64.12",
          family: "IPv4",
          internal: false,
          netmask: "",
          mac: "",
          cidr: null,
        },
      ],
    } as unknown as Ifaces;
    expect(selectDirectHost(mixed)).toBe("192.168.64.12");
  });
});
