/**
 * /api/tool and /api/sheets/* of the relay as it runs: a real
 * `node server/relay.mjs` on a free port, with a stand-in for `mcporter` that
 * records what it is asked to call. Holding the shared secret is not enough to
 * reach a tool that writes.
 *
 * READ_CALLS is the list of the direct calls the application makes today
 * (dashboards, alerts, cockpit, account listing): none of them may break.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const RELAY = process.env.RELAY_UNDER_TEST || path.resolve(__dirname, "../../server/relay.mjs");
const SECRET = "secret-de-test";

const STUB = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.STUB_DIR, "mcporter.jsonl"), JSON.stringify(args) + "\\n");
if (args[0] === "list") { process.stdout.write(JSON.stringify({ servers: [] })); process.exit(0); }
process.stdout.write(JSON.stringify({ called: args[1] }));
`;

// lib/dashboard-widgets.ts, lib/alert-google.ts, lib/auto-alerts/google.ts,
// lib/cockpit/fetch.ts, app/api/admin/google-ads/accounts/route.ts.
const READ_CALLS = ["mcp-google-ads.Custom_GAQL_Query", "mcp-google-ads.List_Customers"];

const OTHER_READS = [
  "mcp-google-ads.Campaign_Performance", "mcp-google-ads.Get_Campaigns", "mcp-google-ads.List_Conversion_Actions",
  "meta-ads-impulse.List_Ad_Accounts1", "meta-ads-impulse.Campaign_Performance1",
  "mcp-google-analytics.run_report", "mcp-google-analytics.list_properties",
  "mcp-google-sheet.Get_row_s_in_sheet_in_Google_Sheets", "mcp-google-sheet.search_sheet",
];

const WRITES = [
  "mcp-google-sheet.Clear_sheet_in_Google_Sheets", "mcp-google-sheet.Append_row_in_sheet_in_Google_Sheets",
  "mcp-google-sheet.Update_row_in_sheet_in_Google_Sheets", "mcp-google-sheet.Append_or_update_row_in_sheet_in_Google_Sheets",
  "mcp-google-sheet.Create_sheet_in_Google_Sheets",
  "mcp-google-ads.Create_Conversion_Action",
  "mcp-google-analytics.update_custom_dimension", "mcp-google-analytics.create_custom_dimension", "mcp-google-analytics.archive_custom_metric",
  "mcp-google-analytics.create_key_event", "mcp-google-analytics.update_data_retention_settings", "mcp-google-analytics.update_enhanced_measurement_settings",
];

const CLOSED = [
  // Chat-only servers, unknown servers, unknown tools, shapes that are not "<server>.<tool>".
  "hq.hq_project_list", "gws.gws_run", "notion.Notion_Create_Page", "sandbox.run_python", "client-data.query",
  "inconnu.outil", "mcp-google-ads.Outil_Ajoute_Demain", "mcp-google-ads.", "mcp-google-ads", ".Custom_GAQL_Query",
  "constructor.Custom_GAQL_Query", "__proto__.x", "mcp-google-ads.Custom_GAQL_Query.Create_Conversion_Action",
  "mcp-google-ads.custom_gaql_query", " mcp-google-ads.Custom_GAQL_Query",
];

let root = "";
let port = 0;
let relay: ChildProcess | null = null;
let logs = "";

const headers = { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` };
const callsFile = () => path.join(root, "stub", "mcporter.jsonl");
const toolCalls = () => (fs.existsSync(callsFile()) ? fs.readFileSync(callsFile(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []).filter((a) => a[0] === "call");

async function post(pathname: string, body: unknown, auth = true) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: "POST", headers: auth ? headers : { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as { result?: unknown; error?: string; class?: string } };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tool-"));
  for (const d of ["bin", "home", "state", "stub"]) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, "bin", "mcporter"), STUB, { mode: 0o755 });
  port = await new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, [RELAY], {
    env: {
      NODE_ENV: "test",
      // Only the stand-in is reachable: no real mcporter, no claude, no Google secret.
      PATH: path.join(root, "bin"),
      HOME: path.join(root, "home"),
      RELAY_PORT: String(port),
      RELAY_SHARED_SECRET: SECRET,
      RELAY_CLAUDE_CWD: path.join(root, "state"),
      MAX_ACCOUNTS_FILE: path.join(root, "accounts.json"),
      HQ_OAUTH_FILE: path.join(root, "hq-oauth.json"),
      STUB_DIR: path.join(root, "stub"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  relay = child;
  child.stdout?.on("data", (c) => { logs += c; });
  child.stderr?.on("data", (c) => { logs += c; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`relay non démarré : ${logs.slice(-500)}`);
}, 20_000);

afterAll(async () => {
  const child = relay;
  relay = null;
  if (child && child.exitCode === null) await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("relay — /api/tool, read tools only", () => {
  it.each([...READ_CALLS, ...OTHER_READS])("lets %s through", async (tool) => {
    const before = toolCalls().length;
    const out = await post("/api/tool", { tool, input: { customer_id: "1234567890" } });
    expect(out.status).toBe(200);
    expect(out.json.result).toEqual({ called: tool });
    expect(toolCalls().length).toBe(before + 1);
  });

  it.each(WRITES)("refuses %s with 403 and never calls it", async (tool) => {
    const before = toolCalls().length;
    const out = await post("/api/tool", { tool, input: { Document: "x", Sheet: "y" } });
    expect(out.status).toBe(403);
    expect(out.json.error).toMatch(/^tool not allowed: .*outils de lecture/);
    expect(toolCalls().length).toBe(before);
  });

  it.each(CLOSED)("refuses %j", async (tool) => {
    const before = toolCalls().length;
    const out = await post("/api/tool", { tool, input: {} });
    expect(out.status).toBe(403);
    expect(out.json.error).toMatch(/^tool not allowed/);
    expect(toolCalls().length).toBe(before);
  });

  it("refuses a tool name that is not a text", async () => {
    for (const tool of [["mcp-google-ads.Custom_GAQL_Query"], { server: "mcp-google-ads" }, 42, true]) {
      expect((await post("/api/tool", { tool, input: {} })).status).toBe(403);
    }
    expect((await post("/api/tool", { input: {} })).status).toBe(400);
  });

  it("still asks for the shared secret", async () => {
    expect((await post("/api/tool", { tool: READ_CALLS[0], input: {} }, false)).status).toBe(401);
  });

  it("announces the allowlist in /health", async () => {
    const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { capabilities?: string[] };
    expect(body.capabilities).toEqual(expect.arrayContaining(["toolAllowlist", "sheetsDirect"]));
  });
});

describe("relay — /api/sheets/*", () => {
  const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEFG";

  it("asks for the shared secret on the three routes", async () => {
    for (const action of ["read", "append", "update"]) {
      expect((await post(`/api/sheets/${action}`, { spreadsheetId: ID, tab: "A" }, false)).status).toBe(401);
    }
  });

  it("refuses an invalid document or tab before asking for a Google token", async () => {
    for (const action of ["read", "append", "update"]) {
      const out = await post(`/api/sheets/${action}`, { spreadsheetId: "https://docs.google.com/spreadsheets/d/x/edit", tab: "A" });
      expect(out.status).toBe(400);
      expect(out.json).toMatchObject({ class: "functional", error: expect.stringContaining("Identifiant de document invalide") });
    }
    expect((await post("/api/sheets/read", { spreadsheetId: ID, tab: "../x" })).status).toBe(400);
    expect(logs).not.toContain("[gws-auth]");
  });

  it("knows no other action", async () => {
    for (const action of ["clear", "delete", "read/x", ""]) expect((await post(`/api/sheets/${action}`, { spreadsheetId: ID, tab: "A" })).status).toBe(404);
  });

  it("answers infra when the relay holds no Google secret", async () => {
    const out = await post("/api/sheets/read", { spreadsheetId: ID, tab: "A" });
    expect(out.status).toBe(502);
    expect(out.json.class).toBe("infra");
  });
});
