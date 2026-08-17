// Sandbox dashboard HTTP server.
//
// Extracted from gominimal/webapp (scripts/sandbox-dashboard.ts +
// src/lib/dashboard/): it is personal tooling, patched into sessions by the
// sandbox-dashboard loadout and run against whatever project checkout is the
// working directory — see repoRoot(). No npm dependencies on purpose: a
// patched-in bare file has no node_modules to resolve packages from.
//
// One process per sandbox; lists every running worktree-dev-server via
// `discover()` and links the host through to each dev server's port. Astro
// emits absolute asset paths (`/src/...`, `/_astro/...`), HMR over WebSocket,
// and view-transitioned <body> swaps — none of which survive a path-prefix
// proxy. So this is discovery only: each server is reachable two ways, and the
// dashboard hands out a clickable link for each:
//   - Tailnet (anywhere): http://sandbox:<port> — exposed via `tailscale serve`
//     (the dev loadout's tailnet hook, a sibling of this loadout), resolved by
//     MagicDNS, relay-bound.
//   - Direct (fast, same network): http://<vm-ip>:<port> — the sandbox's
//     192.168.64.x VM-bridge IPv4. Requires the Mac subnet router (the
//     loadout's host-side setup script) + "Use Tailscale subnets" on the
//     client; the VM IP churns across rebuilds, so the dashboard (reached by
//     the stable `sandbox` name) is the resolver that always shows it. Omitted
//     entirely when the sandbox has no address in that subnet — e.g. a
//     NAT-only Minimal v2 sandbox, where no direct route exists.
// Web-serve only — there is no SSH into the sandbox.
//
// Routes:
//   GET  /               → HTML dashboard with auto-refreshing rows
//   GET  /manifest.json  → { worktrees: WorktreeRow[],
//                            assignedIssues: AssignedIssue[],
//                            newAssignedIssueNumbers: number[],
//                            directHost, cloudflaredAvailable: boolean,
//                            orphanTunnels: TunnelInfo[] }
//                          (used by the dashboard JS; each worktree entry's
//                          `"port"` maps to http://sandbox:<port> and
//                          http://<directHost>:<port>, and — when a public
//                          share is active — carries `tunnelUrl` (resolved) or
//                          `tunnelPending` (URL still negotiating))
//   POST /tunnels/share  → { port } → open a public cloudflared tunnel to a
//                          live dev server's port (same-origin JSON only)
//   POST /tunnels/stop   → { port } → tear down that port's tunnel (idempotent)
//   GET  /healthz        → "OK"
//
// Listens on SANDBOX_DASHBOARD_PORT (default 4320 — one below the
// dev-server range so it survives expansions of 4321..N).

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

import {
  ASSIGNED_ISSUES_LOGIN,
  type AssignedIssue,
  type DiscoveredWorktree,
  discover,
  discoverAssignedIssues,
  writeAssignedIssuesState,
} from "./discover.ts";
import {
  discoverTunnels,
  isCloudflaredInstalled,
  startTunnel,
  stopTunnel,
  type TunnelInfo,
} from "./tunnels.ts";

/**
 * A discovered dev server plus its optional public-share state.
 *
 * SECURITY: `tunnelUrl` is a public, UNAUTHENTICATED entry point to the dev
 * server (see src/lib/dashboard/tunnels.ts). It is only ever present when an
 * operator explicitly clicked "Share"; the UI flags it in red as PUBLIC.
 */
interface WorktreeRow extends DiscoveredWorktree {
  /** Public *.trycloudflare.com URL, present once a share is active + resolved. */
  tunnelUrl?: string;
  /** A share whose cloudflared is up but whose URL hasn't been negotiated yet. */
  tunnelPending?: boolean;
}

/** Manifest payload served at /manifest.json and consumed by the refresh loop. */
interface Manifest {
  worktrees: WorktreeRow[];
  assignedIssues: AssignedIssue[];
  /** Issue numbers newly assigned since the dashboard's previous poll. */
  newAssignedIssueNumbers: number[];
  /**
   * Sandbox's VM-bridge IPv4 (`192.168.64.x`) for the fast same-network
   * "Direct" link, or null when the sandbox has no directly reachable address
   * (see {@link primaryIpv4}). The VM IP churns across rebuilds, so this is
   * read fresh on every manifest load.
   */
  directHost: string | null;
  /**
   * The node's settled MagicDNS machine name — deduped (`sandbox-1`, …) when
   * several sessions share the tailnet. Read fresh on every manifest load so
   * the client refresh loop picks up a name that settles after first paint.
   */
  tailnetHost: string;
  /** Whether cloudflared is on PATH; gates the "Share" action in the UI. */
  cloudflaredAvailable: boolean;
  /**
   * Live tunnels whose dev server is no longer running. A public URL pointing
   * at a dead (or reused) port is surfaced here so an operator can stop it,
   * rather than silently leaving it exposed.
   */
  orphanTunnels: TunnelInfo[];
}

const DEFAULT_PORT = 4320;
const REFRESH_MS = 4000;

// MagicDNS name for the in-sandbox tailnet node. The developer loadout's
// tailnet hook requests `sandbox`, but Tailscale dedupes the machine name
// (sandbox-1, sandbox-2, …) when several sessions are on the tailnet at
// once, so the hook records the settled name in `.tailscale/node-name`
// after `tailscale up`. Read lazily per render — the dashboard starts
// before that hook runs — falling back to the stable name until the file
// appears (or forever, in a session with no tailnet).
const TAILNET_HOST_FALLBACK = "sandbox";

// Test hook: point tailnetHost() at a fixture node-name file so tests don't
// depend on whether the checkout has a live tailnet. null restores the
// default `<repo-root>/.tailscale/node-name`.
let nodeNameFileOverride: string | null = null;
export function _setNodeNameFile(path: string | null): void {
  nodeNameFileOverride = path;
}

function tailnetHost(): string {
  const file = nodeNameFileOverride ?? resolve(repoRoot(), ".tailscale", "node-name");
  try {
    const name = readFileSync(file, "utf8").trim();
    if (/^[a-z0-9][a-z0-9-]*$/.test(name)) return name;
  } catch {
    // No node-name file yet: tailnet hook hasn't run, or no tailnet at all.
  }
  return TAILNET_HOST_FALLBACK;
}

// The macOS VM bridge subnet the loadout's host-side setup script advertises
// as a Tailscale subnet route from the Mac. An address is reachable over the
// "Direct" link ONLY if it falls inside this route — that advertisement is the
// entire mechanism by which a tailnet client reaches the sandbox off-tailnet.
// Keep in sync with VM_SUBNET in the dev loadout's host-side setup script
// (dev.d/host/setup-sandbox-tailnet.sh).
const DIRECT_SUBNET_PREFIX = "192.168.64.";

/**
 * The sandbox's IPv4 for the fast same-network "Direct" link, or null when the
 * sandbox has no directly reachable address.
 *
 * Only an address inside {@link DIRECT_SUBNET_PREFIX} qualifies. Returning any
 * non-internal IPv4 is wrong: a sandbox that sits behind NAT (Minimal v2 hands
 * out a 100.64.0.0/16 address on eth0, reachable only from its own host) would
 * otherwise advertise a link that no client can route to. That range is doubly
 * unusable — 100.64.0.0/10 is Tailscale's own CGNAT range, so it cannot be
 * subnet-routed over the tailnet without colliding with tailnet addressing.
 *
 * Returning null makes the dashboard degrade to the tailnet link alone, which
 * works everywhere via `tailscale serve`.
 */
export function selectDirectHost(ifaces: ReturnType<typeof networkInterfaces>): string | null {
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (
        addr.family === "IPv4" &&
        !addr.internal &&
        addr.address.startsWith(DIRECT_SUBNET_PREFIX)
      ) {
        return addr.address;
      }
    }
  }
  return null;
}

function primaryIpv4(): string | null {
  return selectDirectHost(networkInterfaces());
}

/**
 * The project checkout to discover — the directory `git worktree list` runs
 * from and `.tailscale/node-name` is read under. This file is patched into
 * the session rather than living in any repo, so the anchor is the working
 * directory: dashboard.sh is invoked from the project root by the loadout's
 * on_activate hook, and node inherits that cwd.
 */
function repoRoot(): string {
  return resolve(process.cwd());
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Render the two reachability links for one dev-server port:
//   - Tailnet (anywhere): http://sandbox:<port> — always shown.
//   - Direct (fast, same network): http://<directHost>:<port> — shown only
//     when the sandbox has a non-loopback IPv4; needs the Mac subnet router +
//     "Use Tailscale subnets" on the client.
function renderLinksHtml(port: number, directHost: string | null, tailnetName: string): string {
  const tailnet = `http://${tailnetName}:${port}`;
  const tailnetLink =
    `<div><a href="${escapeHtml(tailnet)}" target="_blank" rel="noopener">${escapeHtml(tailnet)}</a>` +
    ` <span class="tag">tailnet · anywhere</span></div>`;
  if (!directHost) return tailnetLink;
  const direct = `http://${directHost}:${port}`;
  const directLink =
    `<div><a href="${escapeHtml(direct)}" target="_blank" rel="noopener">${escapeHtml(direct)}</a>` +
    ` <span class="tag">direct · fast, same network</span></div>`;
  return tailnetLink + directLink;
}

// Render the public-share cell for one dev-server row. Three states, mirrored
// exactly by the client-side `shareCellHtml()` below:
//   - active + resolved  → red PUBLIC pill, the copyable trycloudflare URL, Stop
//   - active but pending  → red PUBLIC pill, "starting…", Stop
//   - not shared          → a Share button (disabled with a hint when
//                           cloudflared isn't installed)
function renderShareCellHtml(row: WorktreeRow, cloudflaredAvailable: boolean): string {
  if (row.tunnelUrl) {
    return (
      `<span class="pill PUBLIC">public</span> ` +
      `<a href="${escapeHtml(row.tunnelUrl)}" target="_blank" rel="noopener">${escapeHtml(row.tunnelUrl)}</a> ` +
      `<button type="button" class="btn" data-stop="${row.port}">Stop sharing</button>`
    );
  }
  if (row.tunnelPending) {
    return (
      `<span class="pill PUBLIC">public</span> <span class="tag">starting…</span> ` +
      `<button type="button" class="btn" data-stop="${row.port}">Stop sharing</button>`
    );
  }
  if (!cloudflaredAvailable) {
    return `<button type="button" class="btn" disabled title="Run 'min add cloudflared' to enable public sharing">Share</button> <span class="tag">needs <code>min add cloudflared</code></span>`;
  }
  return `<button type="button" class="btn" data-share="${row.port}">Share</button>`;
}

// MUST STAY IN SYNC with the client-side `row()`/`linksHtml()`/`shareCellHtml()`
// functions in renderHtml()'s inline <script> block below. Both render one table
// row from a WorktreeRow; the server-side path produces the initial paint and
// the client-side path produces every auto-refresh repaint. A field added here
// must be mirrored there or the row will change shape after the first refresh.
function renderRowsHtml(
  rows: readonly WorktreeRow[],
  directHost: string | null,
  cloudflaredAvailable: boolean,
  tailnetName: string,
): string {
  if (rows.length === 0) {
    return `<div class="empty">No dev servers running. Start one with <code>pnpm dev:start</code>.</div>`;
  }
  const body = rows
    .map((r) => {
      const pr = r.prNumber
        ? `<a href="${escapeHtml(r.prUrl ?? "#")}" target="_blank" rel="noopener">#${r.prNumber}</a> ` +
          escapeHtml(r.prTitle ?? "") +
          (r.prState
            ? ` <span class="pill ${escapeHtml(r.prState)}">${escapeHtml(r.prState)}</span>`
            : "")
        : `<span style="color:#9aa3ad">(no open PR)</span>`;
      return (
        `<tr>` +
        `<td><code>${escapeHtml(r.branch)}</code></td>` +
        `<td>${renderLinksHtml(r.port, directHost, tailnetName)}</td>` +
        `<td>${renderShareCellHtml(r, cloudflaredAvailable)}</td>` +
        `<td>${pr}</td>` +
        `<td><code>${escapeHtml(r.worktreePath)}</code></td>` +
        `</tr>`
      );
    })
    .join("");
  return (
    `<table><thead><tr>` +
    `<th>Branch</th><th>URLs</th><th>Public share</th><th>Pull request</th><th>Worktree</th>` +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

// MUST STAY IN SYNC with the client-side `orphanHtml()` function below. Renders
// live tunnels whose dev server has gone away — a public URL now pointing at a
// dead or reused port. Surfaced so an operator can stop the exposure.
function renderOrphanTunnelsHtml(orphans: readonly TunnelInfo[]): string {
  if (orphans.length === 0) return "";
  const items = orphans
    .map((t) => {
      const target = t.url
        ? `<a href="${escapeHtml(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.url)}</a>`
        : `<span class="tag">starting…</span>`;
      return (
        `<li><span class="pill PUBLIC">public</span> port <code>${t.port}</code> — ${target} ` +
        `<span class="tag">dev server stopped</span> ` +
        `<button type="button" class="btn" data-stop="${t.port}">Stop sharing</button></li>`
      );
    })
    .join("");
  return (
    `<h2>Public tunnels with no running server</h2>` +
    `<div class="warnbar">These URLs are public but the dev server they pointed at is gone. Stop them.</div>` +
    `<ul class="issues">${items}</ul>`
  );
}

// MUST STAY IN SYNC with the client-side `issueRow()` function in renderHtml()'s
// inline <script> block below. Both render one list item from an AssignedIssue;
// the server-side path produces the initial paint and the client-side path
// produces every auto-refresh repaint. A field added here must be mirrored
// there or the item will change shape after the first refresh.
function renderIssuesHtml(
  issues: readonly AssignedIssue[],
  newNumbers: ReadonlySet<number>,
): string {
  if (issues.length === 0) {
    return `<div class="empty">No open issues assigned to <code>${escapeHtml(ASSIGNED_ISSUES_LOGIN)}</code>.</div>`;
  }
  const body = issues
    .map((i) => {
      const badge = newNumbers.has(i.number) ? ` <span class="pill NEW">new</span>` : "";
      return `<li><a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">#${i.number}</a> ${escapeHtml(i.title)}${badge}</li>`;
    })
    .join("");
  return `<ul class="issues">${body}</ul>`;
}

function renderHtml(manifest: Manifest): string {
  // Initial render is server-side so the page is meaningful before JS runs
  // (and so the host's smoke-test `curl /` sees the actual links). The
  // inline script then re-fetches /manifest.json every REFRESH_MS to keep
  // the list current as worktree dev servers come and go.
  const initialRows = renderRowsHtml(
    manifest.worktrees,
    manifest.directHost,
    manifest.cloudflaredAvailable,
    manifest.tailnetHost,
  );
  const initialOrphans = renderOrphanTunnelsHtml(manifest.orphanTunnels);
  const initialIssues = renderIssuesHtml(
    manifest.assignedIssues,
    new Set(manifest.newAssignedIssueNumbers),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Sandbox dashboard</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0; padding: 2rem; background: #0b0d10; color: #e6e8eb;
  }
  h1 { font-size: 1.25rem; margin: 0 0 0.25rem; font-weight: 600; }
  .sub { color: #9aa3ad; margin-bottom: 1.5rem; font-size: 0.875rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  th, td { text-align: left; padding: 0.6rem 0.75rem; border-bottom: 1px solid #20262d; }
  th { color: #9aa3ad; font-weight: 500; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
  a { color: #7cc4ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125rem; color: #cfd5dc; }
  .pill { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 999px; font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .pill.OPEN { background: #1b3a23; color: #7ee3a0; }
  .pill.MERGED { background: #2a1d3a; color: #c89bff; }
  .pill.CLOSED { background: #3a1d1d; color: #ff8a8a; }
  .pill.NEW { background: #3a2f1b; color: #ffd479; }
  /* PUBLIC is intentionally the loudest pill — it marks an unauthenticated,
     internet-reachable entry point to a dev server. */
  .pill.PUBLIC { background: #4a1416; color: #ff6b6b; }
  .tag { color: #9aa3ad; font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.04em; }
  td > div + div { margin-top: 0.25rem; }
  .empty { padding: 2rem; text-align: center; color: #9aa3ad; }
  .btn { font: inherit; font-size: 0.75rem; padding: 0.2rem 0.55rem; border-radius: 6px; border: 1px solid #33404d; background: #17202a; color: #cfe3ff; cursor: pointer; }
  .btn:hover:not(:disabled) { border-color: #4a5b6d; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .warnbar { background: #2a1113; border: 1px solid #5a1c1f; color: #ffb4b4; padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.8125rem; margin-bottom: 0.75rem; }
  #flash { min-height: 1.25rem; margin: 0.5rem 0 0; font-size: 0.8125rem; color: #ff8a8a; }
  h2 { font-size: 0.95rem; margin: 2rem 0 0.75rem; font-weight: 600; }
  ul.issues { list-style: none; margin: 0; padding: 0; font-size: 0.875rem; }
  ul.issues li { padding: 0.5rem 0.75rem; border-bottom: 1px solid #20262d; }
  @media (prefers-color-scheme: light) {
    body { background: #f7f8fa; color: #1a1f24; }
    th, td { border-bottom-color: #e3e7eb; }
    ul.issues li { border-bottom-color: #e3e7eb; }
    th { color: #6b727a; }
    a { color: #0a66c2; }
    code { color: #3a4048; }
  }
</style>
</head>
<body>
<h1>Sandbox dev servers</h1>
<div class="sub">Auto-refreshes every ${REFRESH_MS / 1000}s. Each server lists a <strong>tailnet</strong> link (<code id="tailnet-example">http://${escapeHtml(manifest.tailnetHost)}:&lt;port&gt;</code>, works anywhere via relay) and, when available, a <strong>direct</strong> link (<code>http://&lt;vm-ip&gt;:&lt;port&gt;</code>, fast on the same network — needs the Mac subnet router + "Use Tailscale subnets"). <strong>Share</strong> opens a temporary <em>public, unauthenticated</em> cloudflared tunnel to that port — anyone with the URL reaches the dev server. Tunnels are opt-in, flagged PUBLIC, and die when stopped or when the sandbox restarts.</div>
<div id="flash"></div>
<div id="root">${initialRows}</div>
<div id="orphans">${initialOrphans}</div>
<h2>Assigned to ${escapeHtml(ASSIGNED_ISSUES_LOGIN)}</h2>
<div id="issues">${initialIssues}</div>
<script>
const REFRESH_MS = ${REFRESH_MS};
const ASSIGNED_LOGIN = ${JSON.stringify(ASSIGNED_ISSUES_LOGIN)};
const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// MUST STAY IN SYNC with the server-side renderLinksHtml()/renderRowsHtml()
// functions above. The tailnet name is seeded at page render and refreshed
// from each /manifest.json poll — the settled (possibly deduped) MagicDNS
// name can land AFTER first paint, since the dashboard starts before the
// loadout's tailnet hook writes .tailscale/node-name. The direct host comes
// from the manifest's directHost (the sandbox's current VM IP).
let TAILNET_HOST = ${JSON.stringify(manifest.tailnetHost)};
function linksHtml(port, directHost) {
  const tailnet = "http://" + TAILNET_HOST + ":" + port;
  let html = '<div><a href="' + esc(tailnet) + '" target="_blank" rel="noopener">' + esc(tailnet) + '</a>'
    + ' <span class="tag">tailnet · anywhere</span></div>';
  if (directHost) {
    const direct = "http://" + directHost + ":" + port;
    html += '<div><a href="' + esc(direct) + '" target="_blank" rel="noopener">' + esc(direct) + '</a>'
      + ' <span class="tag">direct · fast, same network</span></div>';
  }
  return html;
}
// MUST STAY IN SYNC with the server-side renderShareCellHtml().
function shareCellHtml(r, cloudflaredAvailable) {
  if (r.tunnelUrl) {
    return '<span class="pill PUBLIC">public</span> '
      + '<a href="' + esc(r.tunnelUrl) + '" target="_blank" rel="noopener">' + esc(r.tunnelUrl) + '</a> '
      + '<button type="button" class="btn" data-stop="' + r.port + '">Stop sharing</button>';
  }
  if (r.tunnelPending) {
    return '<span class="pill PUBLIC">public</span> <span class="tag">starting…</span> '
      + '<button type="button" class="btn" data-stop="' + r.port + '">Stop sharing</button>';
  }
  if (!cloudflaredAvailable) {
    return '<button type="button" class="btn" disabled title="Run \\'min add cloudflared\\' to enable public sharing">Share</button> <span class="tag">needs <code>min add cloudflared</code></span>';
  }
  return '<button type="button" class="btn" data-share="' + r.port + '">Share</button>';
}
function row(r, directHost, cloudflaredAvailable) {
  const pr = r.prNumber
    ? '<a href="' + esc(r.prUrl || "#") + '" target="_blank" rel="noopener">#' + r.prNumber + '</a> '
      + esc(r.prTitle || "")
      + (r.prState ? ' <span class="pill ' + esc(r.prState) + '">' + esc(r.prState) + '</span>' : "")
    : '<span style="color:#9aa3ad">(no open PR)</span>';
  return '<tr>'
    + '<td><code>' + esc(r.branch) + '</code></td>'
    + '<td>' + linksHtml(r.port, directHost) + '</td>'
    + '<td>' + shareCellHtml(r, cloudflaredAvailable) + '</td>'
    + '<td>' + pr + '</td>'
    + '<td><code>' + esc(r.worktreePath) + '</code></td>'
    + '</tr>';
}
// MUST STAY IN SYNC with the server-side renderOrphanTunnelsHtml().
function orphanHtml(orphans) {
  if (!orphans.length) return "";
  const items = orphans.map((t) => {
    const target = t.url
      ? '<a href="' + esc(t.url) + '" target="_blank" rel="noopener">' + esc(t.url) + '</a>'
      : '<span class="tag">starting…</span>';
    return '<li><span class="pill PUBLIC">public</span> port <code>' + t.port + '</code> — ' + target + ' '
      + '<span class="tag">dev server stopped</span> '
      + '<button type="button" class="btn" data-stop="' + t.port + '">Stop sharing</button></li>';
  }).join("");
  return '<h2>Public tunnels with no running server</h2>'
    + '<div class="warnbar">These URLs are public but the dev server they pointed at is gone. Stop them.</div>'
    + '<ul class="issues">' + items + '</ul>';
}
// MUST STAY IN SYNC with the server-side renderIssuesHtml() function above.
function issueRow(i, newSet) {
  const badge = newSet.has(i.number) ? ' <span class="pill NEW">new</span>' : "";
  return '<li><a href="' + esc(i.url) + '" target="_blank" rel="noopener">#' + i.number + '</a> '
    + esc(i.title) + badge + '</li>';
}
async function refresh() {
  try {
    const res = await fetch("/manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const manifest = await res.json();
    const rows = Array.isArray(manifest.worktrees) ? manifest.worktrees : [];
    const issues = Array.isArray(manifest.assignedIssues) ? manifest.assignedIssues : [];
    const orphans = Array.isArray(manifest.orphanTunnels) ? manifest.orphanTunnels : [];
    const directHost = typeof manifest.directHost === "string" && manifest.directHost ? manifest.directHost : null;
    // Same shape guard as the server-side tailnetHost() regex — the value is
    // interpolated into link hrefs, so reject anything that isn't a bare
    // MagicDNS machine name.
    if (typeof manifest.tailnetHost === "string" && /^[a-z0-9][a-z0-9-]*$/.test(manifest.tailnetHost)) {
      TAILNET_HOST = manifest.tailnetHost;
      $("tailnet-example").textContent = "http://" + TAILNET_HOST + ":<port>";
    }
    const cloudflaredAvailable = manifest.cloudflaredAvailable === true;
    const newSet = new Set(Array.isArray(manifest.newAssignedIssueNumbers) ? manifest.newAssignedIssueNumbers : []);
    $("root").innerHTML = rows.length === 0
      ? '<div class="empty">No dev servers running. Start one with <code>pnpm dev:start</code>.</div>'
      : '<table><thead><tr>'
        + '<th>Branch</th><th>URLs</th><th>Public share</th><th>Pull request</th><th>Worktree</th>'
        + '</tr></thead><tbody>' + rows.map((r) => row(r, directHost, cloudflaredAvailable)).join("") + '</tbody></table>';
    $("orphans").innerHTML = orphanHtml(orphans);
    $("issues").innerHTML = issues.length === 0
      ? '<div class="empty">No open issues assigned to <code>' + esc(ASSIGNED_LOGIN) + '</code>.</div>'
      : '<ul class="issues">' + issues.map((i) => issueRow(i, newSet)).join("") + '</ul>';
  } catch (e) {
    // Clear ALL panels so a fetch failure can't leave a section showing stale
    // data next to a "fetch failed" one — including a stale PUBLIC tunnel row.
    const msg = '<div class="empty">Manifest fetch failed: ' + esc(e && e.message ? e.message : String(e)) + '</div>';
    $("root").innerHTML = msg;
    $("orphans").innerHTML = "";
    $("issues").innerHTML = msg;
  }
}
function flash(msg) {
  const el = $("flash");
  if (el) el.textContent = msg || "";
}
// Delegated so the handlers survive the innerHTML repaints of the refresh loop:
// the buttons are re-created every ${REFRESH_MS}ms, so per-button listeners
// would be lost. One document-level listener keys off data-share / data-stop.
document.addEventListener("click", async (e) => {
  const shareBtn = e.target.closest && e.target.closest("[data-share]");
  const stopBtn = e.target.closest && e.target.closest("[data-stop]");
  const btn = shareBtn || stopBtn;
  if (!btn) return;
  const share = Boolean(shareBtn);
  const port = Number(btn.getAttribute(share ? "data-share" : "data-stop"));
  if (!Number.isInteger(port)) return;
  btn.disabled = true;
  btn.textContent = share ? "Starting…" : "Stopping…";
  flash("");
  try {
    const res = await fetch(share ? "/tunnels/share" : "/tunnels/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      flash(data.message || ("Request failed: HTTP " + res.status));
    }
  } catch (err) {
    flash("Request failed: " + (err && err.message ? err.message : String(err)));
  } finally {
    await refresh();
  }
});
refresh();
setInterval(refresh, REFRESH_MS);
</script>
</body>
</html>`;
}

// Dashboard-session badge state. The on-disk seen-set (writeAssignedIssuesState)
// advances on every poll and exists to give the hook its "new since last prompt"
// baseline — so it can't also drive the badge (the badge would clear after one
// 4s refresh). Instead the badge is computed against an in-memory baseline
// captured at the dashboard's first poll: any issue number that appears later is
// flagged "new" for the rest of this dashboard process's life (until restart).
let badgeBaseline: Set<number> | null = null;

/** Test-only: reset the in-process badge baseline so tests can isolate it. */
export function _resetBadgeBaseline(): void {
  badgeBaseline = null;
}

function computeNewlyAssigned(issues: readonly AssignedIssue[]): number[] {
  const current = issues.map((i) => i.number);
  if (badgeBaseline === null) {
    // First poll: everything is the baseline, nothing is "new" yet.
    badgeBaseline = new Set(current);
    return [];
  }
  // Capture in a const so TypeScript narrows away the `null` and the filter
  // can't accidentally invert on an `undefined` from optional chaining.
  const baseline = badgeBaseline;
  return current.filter((n) => !baseline.has(n));
}

/**
 * Resolve a manifest payload for the current sandbox. Catches discovery
 * errors per-source and returns empty arrays so the dashboard never serves a
 * 500 — a fresh sandbox with no dev servers and no assigned issues is the
 * expected case. As a side effect, persists the current assigned-issue set to
 * the `$TMPDIR` state file the UserPromptSubmit hook reads (best-effort).
 */
/**
 * Merge discovered tunnels into the dev-server rows.
 *
 * A tunnel whose port matches a live dev server is attached to that row
 * (resolved URL → `tunnelUrl`, still-negotiating → `tunnelPending`). A live
 * tunnel with no matching dev server is an orphan (the server it pointed at
 * stopped) and is returned separately so the UI can flag the lingering public
 * exposure. Dead-PID tunnels are already reaped inside {@link discoverTunnels}.
 */
function mergeTunnels(
  worktrees: readonly DiscoveredWorktree[],
  tunnels: readonly TunnelInfo[],
): { rows: WorktreeRow[]; orphanTunnels: TunnelInfo[] } {
  const byPort = new Map(tunnels.map((t) => [t.port, t]));
  const rows = worktrees.map((w): WorktreeRow => {
    const t = byPort.get(w.port);
    if (!t) return { ...w };
    return t.url ? { ...w, tunnelUrl: t.url } : { ...w, tunnelPending: true };
  });
  const livePorts = new Set(worktrees.map((w) => w.port));
  const orphanTunnels = tunnels.filter((t) => !livePorts.has(t.port));
  return { rows, orphanTunnels };
}

async function loadManifest(): Promise<Manifest> {
  let worktrees: DiscoveredWorktree[] = [];
  try {
    worktrees = await discover(repoRoot());
  } catch (err) {
    console.warn("[dashboard] discover() failed:", err);
  }

  // Tunnel discovery is isolated so a failure (bad $TMPDIR, etc.) can't 500 the
  // dashboard — it just renders as "no shares".
  let tunnels: TunnelInfo[] = [];
  try {
    tunnels = await discoverTunnels();
  } catch (err) {
    console.warn("[dashboard] discoverTunnels() failed:", err);
  }
  let cloudflaredAvailable = false;
  try {
    cloudflaredAvailable = await isCloudflaredInstalled();
  } catch (err) {
    console.warn("[dashboard] cloudflared availability check failed:", err);
  }
  const { rows, orphanTunnels } = mergeTunnels(worktrees, tunnels);

  let assignedIssues: AssignedIssue[] = [];
  try {
    assignedIssues = await discoverAssignedIssues();
  } catch (err) {
    console.warn("[dashboard] assigned-issues discovery failed:", err);
  }
  // Persist the seen-set for the hook (its return value is consumed by the
  // hook via the file, not here). Kept in its own try so a write failure can't
  // skip the badge computation below — badge state is independent of the disk
  // write.
  try {
    await writeAssignedIssuesState(assignedIssues);
  } catch (err) {
    console.warn("[dashboard] assigned-issues state write failed:", err);
  }
  const newAssignedIssueNumbers = computeNewlyAssigned(assignedIssues);

  return {
    worktrees: rows,
    assignedIssues,
    newAssignedIssueNumbers,
    directHost: primaryIpv4(),
    tailnetHost: tailnetHost(),
    cloudflaredAvailable,
    orphanTunnels,
  };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

/**
 * Read and JSON-parse a request body, capped at `maxBytes` so a malicious or
 * runaway client can't exhaust memory. An empty body parses to `{}`.
 */
async function readJsonBody(req: IncomingMessage, maxBytes = 4096): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw === "" ? {} : JSON.parse(raw);
}

/**
 * Extract a valid `port` from a parsed request body, or null if it doesn't
 * match. The body is an external-input boundary, validated with the same
 * fail-closed hand-rolled checks as the `gh` output in discover.ts (this file
 * runs without node_modules, so no schema library).
 */
function parsePortField(body: unknown): number | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const port = (body as Record<string, unknown>).port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  return port;
}

/**
 * Reject cross-origin or non-JSON writes to the tunnel actions.
 *
 * SECURITY (CSRF): the dashboard listens on 0.0.0.0 with no auth and is reachable
 * over the tailnet by design, so without this a malicious page open in the
 * operator's browser could drive-by `POST /tunnels/share` and expose a dev
 * server to the public internet with zero operator interaction — defeating the
 * "opt-in, operator clicks Share" guarantee. Two checks:
 *   1. Content-Type must be application/json. A cross-origin `fetch` with this
 *      type forces a CORS preflight the dashboard never answers, so the browser
 *      blocks the real request; a "simple" form POST (which skips preflight)
 *      can't set this type and is rejected here — closing the `text/plain`
 *      form-submit bypass.
 *   2. If an Origin header is present (browsers attach one to every POST), its
 *      host must equal the Host the request was addressed to. A drive-by from
 *      evil.example carries a mismatched Origin and is refused. Origin-less
 *      non-browser clients (curl, agents) are unaffected — CSRF is browser-only.
 * Returns true when the request may proceed; otherwise writes the rejection and
 * returns false.
 */
function tunnelActionGuard(req: IncomingMessage, res: ServerResponse): boolean {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    sendJson(res, 415, { ok: false, message: "Content-Type must be application/json" });
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "") {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      sendJson(res, 403, { ok: false, message: "invalid Origin" });
      return false;
    }
    if (originHost !== req.headers.host) {
      sendJson(res, 403, { ok: false, message: "cross-origin request refused" });
      return false;
    }
  }
  return true;
}

/**
 * Handle `POST /tunnels/share` and `POST /tunnels/stop`.
 *
 * SECURITY: `share` opens a public, unauthenticated tunnel, so it is gated to
 * ports that are *currently a live dev server* — a caller can't open a tunnel to
 * an arbitrary local port. `stop` is unconditional (idempotent) so an orphaned
 * tunnel whose dev server has since stopped can always be torn down. Cross-origin
 * / non-JSON requests are rejected upstream by {@link tunnelActionGuard}.
 */
async function handleTunnelAction(
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { ok: false, message: "invalid request body" });
    return;
  }
  const port = parsePortField(body);
  if (port === null) {
    sendJson(res, 400, { ok: false, message: "missing or invalid 'port'" });
    return;
  }

  if (pathname === "/tunnels/stop") {
    const { stopped } = await stopTunnel(port);
    sendJson(res, 200, { ok: true, stopped });
    return;
  }

  // share: refuse to tunnel a port that isn't a currently-live dev server.
  let livePorts = new Set<number>();
  try {
    livePorts = new Set((await discover(repoRoot())).map((w) => w.port));
  } catch (err) {
    console.warn("[dashboard] discover() during share failed:", err);
  }
  if (!livePorts.has(port)) {
    sendJson(res, 409, { ok: false, message: `no live dev server on port ${port}` });
    return;
  }
  const result = await startTunnel(port);
  if (!result.ok) {
    switch (result.reason) {
      case "not-installed":
        sendJson(res, 503, {
          ok: false,
          message: "cloudflared is not installed — run 'min add cloudflared'",
        });
        return;
      case "spawn-failed":
        sendJson(res, 500, { ok: false, message: `failed to start tunnel: ${result.message}` });
        return;
      default: {
        // Exhaustiveness: a newly-added StartTunnelResult reason becomes a
        // compile error here instead of a silent fallthrough.
        const _exhaustive: never = result;
        throw new Error(`unhandled tunnel start reason: ${String(_exhaustive)}`);
      }
    }
  }
  sendJson(res, 200, { ok: true, tunnel: result.tunnel });
}

/**
 * Route handler. Exported so unit tests can drive it without binding a
 * real TCP socket. Returns once the response is fully written.
 */
export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? "/";
  // Match on the parsed pathname so a query string (e.g. /manifest.json?ts=...,
  // which the auto-refresh fetch may append for cache-busting) doesn't 404.
  const pathname = new URL(rawUrl, "http://localhost").pathname;
  if (req.method === "POST" && (pathname === "/tunnels/share" || pathname === "/tunnels/stop")) {
    if (!tunnelActionGuard(req, res)) return;
    await handleTunnelAction(pathname, req, res);
    return;
  }
  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("OK");
    return;
  }
  if (pathname === "/manifest.json") {
    const manifest = await loadManifest();
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(manifest));
    return;
  }
  if (pathname === "/" || pathname === "/index.html") {
    const manifest = await loadManifest();
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(renderHtml(manifest));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Not found: ${escapeHtml(rawUrl)}`);
}

function main(): void {
  const port = Number.parseInt(process.env.SANDBOX_DASHBOARD_PORT ?? "", 10) || DEFAULT_PORT;
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[dashboard] handler error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Internal error");
    });
  });
  server.listen(port, () => {
    console.log(`[dashboard] listening on http://0.0.0.0:${port}`);
  });
  const shutdown = (sig: NodeJS.Signals): void => {
    console.log(`[dashboard] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Run only when invoked directly, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
