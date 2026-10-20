/**
 * Detached turns of the relay (server/jobs.mjs): a real `node server/relay.mjs`
 * with the stand-in CLI of relay-wiring.test.ts. What is checked: a turn
 * started with `detach: true` answers a job id at once, its events are read
 * back and followed from any sequence number, a reader leaving does not stop
 * the CLI, stop does, and the app is told when the job is over.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const RELAY = path.resolve(__dirname, "../../server/relay.mjs");
const SECRET = "secret-de-test-jobs";

const STUB = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const dir = process.env.STUB_DIR;
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
const turn = JSON.parse(fs.readFileSync(path.join(dir, "turn.json"), "utf8"));
let alive = true;
process.on("SIGTERM", () => { fs.appendFileSync(path.join(dir, "signals.log"), "SIGTERM\\n"); alive = false; process.exit(143); });
(async () => {
  for (const e of turn.events) {
    if (e.wait) await new Promise((r) => setTimeout(r, e.wait));
    else process.stdout.write(JSON.stringify(e) + "\\n");
  }
  if (turn.hang) await new Promise((r) => setTimeout(r, turn.hang === true ? 60000 : turn.hang));
  if (alive) process.exit(turn.exit || 0);
})();
`;

interface Sse { type: string; seq?: number; [k: string]: unknown }

let root = "";
let port = 0;
let appPort = 0;
let relay: ChildProcess | null = null;
let logs = "";
const completions: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];
let appServer: http.Server | null = null;
const state = () => path.join(root, "state");
const stubDir = () => path.join(root, "stub");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

/** Stand-in for the app: records the completion webhooks. */
function startApp(): Promise<void> {
  return new Promise((resolve) => {
    appServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        completions.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
        res.writeHead(req.url === "/api/ai/jobs/complete" ? 200 : 404, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    appServer.listen(appPort, "127.0.0.1", () => resolve());
  });
}

async function startRelay() {
  const child = spawn(process.execPath, [RELAY], {
    env: {
      NODE_ENV: "test",
      PATH: path.join(root, "bin"),
      HOME: path.join(root, "home"),
      RELAY_PORT: String(port),
      RELAY_SHARED_SECRET: SECRET,
      RELAY_CLAUDE_CWD: state(),
      RELAY_APP_URL: `http://127.0.0.1:${appPort}`,
      MAX_ACCOUNTS_FILE: path.join(root, "accounts.json"),
      QUOTA_STATE_FILE: path.join(root, "quota-notified.json"),
      HQ_OAUTH_FILE: path.join(root, "hq-oauth.json"),
      STUB_DIR: stubDir(),
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
}

async function stopRelay() {
  const child = relay;
  relay = null;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
}

const headers = { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` };
const base = () => `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const result = (text: string) => ({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 10, result: text, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
const toolCall = () => ({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__meta-ads-impulse__Get_Campaigns", input: { a: 1 } }] } });

function play(events: unknown[], opts: Record<string, unknown> = {}) {
  fs.rmSync(path.join(stubDir(), "signals.log"), { force: true });
  fs.writeFileSync(path.join(stubDir(), "turn.json"), JSON.stringify({ events, ...opts }));
}
const signals = () => { try { return fs.readFileSync(path.join(stubDir(), "signals.log"), "utf8"); } catch { return ""; } };

async function detach(message: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${base()}/api/chat`, { method: "POST", headers, body: JSON.stringify({ messages: [{ role: "user", content: message }], detach: true, ...extra }) });
  expect(res.status).toBe(202);
  const json = (await res.json()) as { jobId: string };
  expect(json.jobId).toMatch(/^[a-f0-9]{32}$/);
  return json.jobId;
}

/** Reads the job's SSE until the stream closes (or `until` matches). */
async function follow(jobId: string, after = 0, until?: (e: Sse) => boolean, signal?: AbortSignal): Promise<Sse[]> {
  const res = await fetch(`${base()}/api/jobs/${jobId}?after=${after}`, { headers, signal });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Sse[] = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const e = JSON.parse(line.slice(6)) as Sse;
      events.push(e);
      if (until?.(e)) { await reader.cancel(); return events; }
    }
  }
  return events;
}

const jobState = async (jobId: string) => ((await (await fetch(`${base()}/api/jobs/${jobId}/state`, { headers })).json()) as { job: Record<string, unknown> }).job;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-jobs-"));
  for (const d of ["bin", "home", "state", "stub"]) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, "bin", "claude"), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "hq-oauth.json"), JSON.stringify({ access_token: "jeton-de-test", refresh_token: "r", client_id: "c", token_endpoint: "http://127.0.0.1:9/token", expires_at: Date.now() + 24 * 3600 * 1000 }));
  port = await freePort();
  appPort = await freePort();
  await startApp();
  await startRelay();
}, 20_000);

afterAll(async () => {
  await stopRelay();
  await new Promise<void>((resolve) => { appServer?.close(() => resolve()); });
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("relay — tâches détachées", () => {
  it("répond l'identifiant tout de suite, puis la tâche se lit et se rejoue", async () => {
    play([delta("Bon"), delta("jour"), result("Bonjour")]);
    const jobId = await detach("Salut");
    const events = await follow(jobId);
    expect(events.map((e) => e.type)).toContain("delta");
    expect(events.at(-1)?.type).toBe("done");
    const text = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(text).toBe("Bonjour");
    // Every event carries its sequence number; a replay from the middle only gives the rest.
    const seqs = events.map((e) => e.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const later = await follow(jobId, seqs[1]);
    expect(later.map((e) => e.seq)).toEqual(seqs.slice(2));
    const st = await jobState(jobId);
    expect(st).toMatchObject({ status: "done", text: "Bonjour", sawDone: true });
    expect((st.usage as { cost: number }).cost).toBeCloseTo(0.001, 6);
  }, 15_000);

  it("ne s'arrête pas quand le lecteur part, et prévient l'app à la fin", async () => {
    completions.length = 0;
    // The first characters of a reply are held back by the relay (account
    // error check): the tool call is the event that comes out at once.
    play([toolCall(), { wait: 1500 }, delta("Je travaille… fini"), result("Je travaille… fini")]);
    const jobId = await detach("Long travail", { sessionKey: "test:detache", jobMeta: { surface: "console" } });
    const ctl = new AbortController();
    const first = await follow(jobId, 0, (e) => e.type === "tool_call", ctl.signal);
    ctl.abort();
    expect(first.some((e) => e.type === "tool_call")).toBe(true);
    await sleep(300);
    expect(signals()).not.toContain("SIGTERM");
    expect((await jobState(jobId)).status).toBe("running");
    const rest = await follow(jobId, first.at(-1)?.seq as number);
    expect(rest.at(-1)?.type).toBe("done");
    const st = await jobState(jobId);
    expect(st).toMatchObject({ status: "done", text: "Je travaille… fini", toolCalls: [{ name: "mcp__meta-ads-impulse__Get_Campaigns", id: "t1" }] });
    expect((st.meta as { app: unknown }).app).toEqual({ surface: "console" });
    for (let i = 0; i < 40 && !completions.length; i++) await sleep(50);
    expect(completions).toHaveLength(1);
    expect(completions[0].auth).toBe(`Bearer ${SECRET}`);
    expect(completions[0].body.job).toMatchObject({ id: jobId, status: "done", text: "Je travaille… fini" });
  }, 15_000);

  it("s'arrête sur demande : le CLI reçoit SIGTERM et la tâche se termine", async () => {
    play([toolCall(), delta("Début ")], { hang: true });
    const jobId = await detach("Interminable");
    await follow(jobId, 0, (e) => e.type === "tool_call");
    const res = await fetch(`${base()}/api/jobs/${jobId}/stop`, { method: "POST", headers });
    expect(await res.json()).toMatchObject({ ok: true, stopped: true });
    const events = await follow(jobId);
    expect(events.at(-1)?.type).toBe("done");
    for (let i = 0; i < 40 && !signals().includes("SIGTERM"); i++) await sleep(50);
    expect(signals()).toContain("SIGTERM");
    expect((await jobState(jobId)).status).toBe("stopped");
  }, 15_000);

  it("refuse un identifiant inconnu et un appel sans secret", async () => {
    expect((await fetch(`${base()}/api/jobs/${"0".repeat(32)}/state`, { headers })).status).toBe(404);
    expect((await fetch(`${base()}/api/jobs/${"0".repeat(32)}`, { headers: { "Content-Type": "application/json" } })).status).toBe(401);
  });

  it("compte les tâches en cours dans /health", async () => {
    play([delta("…")], { hang: 1500 });
    const jobId = await detach("Compte-moi");
    const health = (await (await fetch(`${base()}/health`)).json()) as { jobsRunning: number };
    expect(health.jobsRunning).toBeGreaterThanOrEqual(1);
    await follow(jobId);
  }, 15_000);
});
