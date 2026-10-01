/**
 * TikTok Ads in a chat, as the relay wires it: a real `node server/relay.mjs`
 * with a stand-in for the `claude` CLI that writes down the MCP config and the
 * tools it was given. One TikTok token reads every advertiser of the agency,
 * so the server must never reach a conversation outside the scope proxy.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const RELAY = process.env.RELAY_UNDER_TEST || path.resolve(__dirname, "../../server/relay.mjs");
const SECRET = "secret-de-test";
const TIKTOK = "mcp-tiktok-ads";
const UPSTREAM = "https://example.invalid/mcp/tiktok/sse";

const STUB = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const list = (flag) => { const i = args.indexOf(flag); if (i < 0) return null; const out = []; for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]); return out; };
let config = null;
try { config = JSON.parse(fs.readFileSync(after("--mcp-config"), "utf8")); } catch {}
fs.appendFileSync(path.join(process.env.STUB_DIR, "calls.jsonl"), JSON.stringify({ config, allowed: list("--allowedTools"), system: after("--system-prompt") }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 10, result: "ok", total_cost_usd: 0.001,
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) + "\\n");
`;

let root = "";
let port = 0;
let relay: ChildProcess | null = null;
let logs = "";

type Entry = { command?: string; args?: string[]; env?: Record<string, string>; url?: string };
type Call = { config: { mcpServers: Record<string, Entry> } | null; allowed: string[] | null; system: string | null };

async function chat(body: Record<string, unknown>): Promise<Call> {
  const file = path.join(root, "stub", "calls.jsonl");
  fs.rmSync(file, { force: true });
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "Dépense TikTok de la semaine ?" }], ...body }),
  });
  await res.text();
  if (!fs.existsSync(file)) throw new Error(`CLI non lancé : ${logs.slice(-600)}`);
  return JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").at(-1)!) as Call;
}
const tiktokTools = (call: Call) => (call.allowed ?? []).filter((t) => t.startsWith(`mcp__${TIKTOK}__`)).map((t) => t.slice(`mcp__${TIKTOK}__`.length)).sort();

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tiktok-"));
  for (const d of ["bin", "home", "state", "stub"]) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, "bin", "claude"), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: { [TIKTOK]: { type: "sse", url: UPSTREAM } } }));
  port = await new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, [RELAY], {
    env: {
      NODE_ENV: "test",
      PATH: path.join(root, "bin"),
      HOME: path.join(root, "home"),
      RELAY_PORT: String(port),
      RELAY_SHARED_SECRET: SECRET,
      RELAY_CLAUDE_CWD: path.join(root, "state"),
      RELAY_MCP_CONFIG: path.join(root, "mcp.json"),
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

describe("relay — TikTok Ads dans une conversation", () => {
  it("place le serveur derrière le proxy, avec les comptes de l'appelant et la liste fermée d'outils", async () => {
    const call = await chat({ allowedServers: [TIKTOK], accountScope: { tiktok: ["7111111111111111111", "7222222222222222222"] } });
    const entry = call.config!.mcpServers[TIKTOK];
    // Never the n8n address itself: the CLI only knows the proxy.
    expect(entry.url).toBeUndefined();
    expect(entry.command).toBe("node");
    expect(entry.args?.[0]).toMatch(/mcp-scoped-ads\.mjs$/);
    expect(entry.env).toMatchObject({ SCOPED_SERVER_NAME: TIKTOK, SCOPED_UPSTREAM_URL: UPSTREAM, SCOPED_ACCOUNTS: "7111111111111111111,7222222222222222222" });
    const pinned = entry.env!.SCOPED_TOOLS.split(",").sort();
    expect(pinned).toEqual(tiktokTools(call));
    expect(pinned).toHaveLength(14);
    expect(pinned).toContain("search_ad_videos");
    // Open to the team; the proxy still refuses them outside an unrestricted scope.
    expect(pinned).toEqual(expect.arrayContaining(["list_business_centers", "list_bc_advertisers"]));
    expect(pinned).not.toContain("list_advertisers");
    expect(call.allowed).not.toContain(`mcp__${TIKTOK}__*`);
    expect(call.system).toContain("Comptes TikTok autorisés: 7111111111111111111, 7222222222222222222");
  });

  it("ne donne à un bot client que les outils de performance", async () => {
    const call = await chat({ allowedServers: [TIKTOK], accountScope: { tiktok: ["7111111111111111111"] }, dataScope: { clientKey: "client-demo" } });
    const tools = tiktokTools(call);
    expect(tools).toHaveLength(9);
    for (const closed of ["list_advertisers", "list_custom_audiences", "search_ad_videos", "search_ad_images", "list_business_centers", "list_bc_advertisers"]) expect(tools).not.toContain(closed);
    expect(tools).toContain("get_campaign_performance");
    expect(call.config!.mcpServers[TIKTOK].env!.SCOPED_TOOLS.split(",").sort()).toEqual(tools);
  });

  it("ne donne pas plus d'outils à l'assistant d'un client qui ne lit que TikTok", async () => {
    // Without the e-commerce warehouse nor GA4 the bot route sends no dataScope: only `provider` says it is a client bot.
    const call = await chat({ allowedServers: [TIKTOK], accountScope: { tiktok: ["7111111111111111111"] }, provider: "bedrock" });
    expect(tiktokTools(call)).toHaveLength(9);
    expect(call.config!.mcpServers[TIKTOK].env!.SCOPED_TOOLS.split(",")).not.toContain("search_ad_videos");
  });

  it("retire le serveur quand l'appelant n'a aucun compte TikTok", async () => {
    // « * » is the word of the administrator scope: listed as an id, it is no account at all.
    for (const accountScope of [{ meta: ["111"] }, { tiktok: [] }, { tiktok: ["", "  "] }, { tiktok: ["*"] }, { tiktok: [" * "] }, undefined]) {
      const call = await chat({ allowedServers: [TIKTOK], ...(accountScope ? { accountScope } : {}) });
      expect(call.config?.mcpServers?.[TIKTOK]).toBeUndefined();
      expect(tiktokTools(call)).toEqual([]);
    }
  });

  it("garde le proxy pour un administrateur : tous les comptes, mêmes outils fermés", async () => {
    const call = await chat({ allowedServers: [TIKTOK], accountScope: { unrestricted: true } });
    const entry = call.config!.mcpServers[TIKTOK];
    expect(entry.env).toMatchObject({ SCOPED_ACCOUNTS: "*" });
    expect(entry.env!.SCOPED_TOOLS.split(",")).not.toContain("list_advertisers");
    expect(tiktokTools(call)).toHaveLength(14);
  });

  it("ne l'ajoute pas à une conversation qui ne l'a pas demandé", async () => {
    const call = await chat({ allowedServers: [], accountScope: { tiktok: ["7111111111111111111"] } });
    expect(call.config?.mcpServers?.[TIKTOK]).toBeUndefined();
  });
});

describe("relay — TikTok Ads en appel direct", () => {
  const post = async (tool: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/tool`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ tool, input: { advertiser_ids: '["7111111111111111111"]' } }),
    });
    return { status: res.status, json: (await res.json()) as { error?: string } };
  };

  it.each(["list_advertisers", "get_campaigns", "get_report_integrated", "search_ad_videos", "create_campaign"])("ferme %s", async (tool) => {
    const out = await post(`${TIKTOK}.${tool}`);
    expect(out.status).toBe(403);
    expect(out.json.error).toMatch(/^tool not allowed/);
  });

  it("ouvre get_advertiser_info, la seule lecture dont l'application a besoin", async () => {
    // No mcporter in this relay's PATH: the call is let through, then fails to run — and the relay stays up.
    for (let i = 0; i < 2; i++) {
      const out = await post(`${TIKTOK}.get_advertiser_info`);
      expect(out.status).toBeGreaterThanOrEqual(500);
      expect(out.json.error).not.toMatch(/^tool not allowed/);
    }
  });
});
