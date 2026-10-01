/**
 * The relay as it runs: a real `node server/relay.mjs` on a free port, with
 * its state in a temporary folder and a stand-in for the `claude` CLI that
 * plays back the events of a turn. What is checked is the wiring — what the
 * relay reads from sessions.json, sends to the CLI, bills and stores — which
 * the pure helpers (relay-prompt.test.ts) cannot show.
 *
 * The figures of the turns are the ones measured on CLI 2.1.284 (a session
 * of three turns, the first two with two tool calls each).
 *
 * RELAY_UNDER_TEST points the suite at another relay.mjs (a copy of the code
 * before a fix, to see the tests fail on it).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const RELAY = process.env.RELAY_UNDER_TEST || path.resolve(__dirname, "../../server/relay.mjs");
const SECRET = "secret-de-test";

// Stand-in for the CLI: records how it was called, leaves a transcript where
// the relay looks for one, then plays the turn written by the test.
const STUB = `#!${process.execPath}
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const dir = process.env.STUB_DIR;
const args = process.argv.slice(2);
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const id = after("--resume") || after("--session-id");
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ prompt: after("--print"), system: after("--system-prompt"), resume: after("--resume"), sessionId: after("--session-id") }) + "\\n");
if (id) {
  const projects = path.join(os.homedir(), ".claude", "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(projects, { recursive: true });
  fs.appendFileSync(path.join(projects, id + ".jsonl"), "{}\\n");
}
const played = JSON.parse(fs.readFileSync(path.join(dir, "turn.json"), "utf8"));
// \`attempts\`: one turn per launch of the CLI (a turn relaunched by the relay).
let turn = played;
if (played.attempts) {
  const counter = path.join(dir, "attempt");
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(n + 1));
  turn = played.attempts[Math.min(n, played.attempts.length - 1)];
}
(async () => {
  for (const e of turn.events) process.stdout.write(JSON.stringify(e) + "\\n");
  // \`hang\`: stays alive after its events, for good (true) or for so many ms.
  if (turn.hang) await new Promise((r) => setTimeout(r, turn.hang === true ? 60000 : turn.hang));
  process.exit(turn.exit || 0);
})();
`;

type Tokens = [input: number, output: number, cacheRead: number, cacheWrite: number];
/** Stream events of one model call, as the CLI sends them with --include-partial-messages. */
function call([input, output, cacheRead, cacheWrite]: Tokens) {
  const usage = { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite };
  return [
    { type: "stream_event", event: { type: "message_start", message: { usage: { ...usage, output_tokens: 1 } } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Réponse. " } } },
    { type: "stream_event", event: { type: "message_delta", usage: { ...usage, output_tokens: output } } },
    { type: "stream_event", event: { type: "message_stop" } },
  ];
}
function result(usage: Tokens | null, cumulative: Tokens | null, total: number | null, extra: Record<string, unknown> = {}) {
  return {
    type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 10, result: "Réponse.",
    ...(usage ? { usage: { input_tokens: usage[0], output_tokens: usage[1], cache_read_input_tokens: usage[2], cache_creation_input_tokens: usage[3], cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: usage[3] } } } : {}),
    ...(cumulative ? { modelUsage: { "claude-sonnet-5": { inputTokens: cumulative[0], outputTokens: cumulative[1], cacheReadInputTokens: cumulative[2], cacheCreationInputTokens: cumulative[3] } } } : {}),
    ...(total !== null ? { total_cost_usd: total } : {}),
    ...extra,
  };
}

// Measured: turn 1 (new session, four calls), turn 2 and turn 3 (resumed).
const T1: Tokens = [8, 259, 6399, 3429];
const T1_CALLS: Tokens[] = [[2, 111, 0, 1700], [2, 61, 1700, 289], [2, 60, 1989, 721], [2, 27, 2710, 719]];
const T2: Tokens = [6, 147, 11274, 1573];
const T2_CALLS: Tokens[] = [[2, 61, 3429, 133], [2, 60, 3562, 721], [2, 26, 4283, 719]];
const T3: Tokens = [2, 5, 5002, 79];
const plus = (a: Tokens, b: Tokens): Tokens => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
const SUM2 = plus(T1, T2);
const SUM3 = plus(SUM2, T3);
const TOTAL1 = 0.0176018;
const TOTAL2 = 0.0276306;
const TOTAL3 = 0.029001;

interface Sse { type: string; [k: string]: unknown }

let root = "";
let port = 0;
let relay: ChildProcess | null = null;
let logs = "";
const state = () => path.join(root, "state");
const stubDir = () => path.join(root, "stub");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

async function startRelay(extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [RELAY], {
    env: {
      ...extraEnv,
      NODE_ENV: "test",
      // Only the stand-in CLI is reachable: no mcporter, no real claude.
      PATH: path.join(root, "bin"),
      HOME: path.join(root, "home"),
      RELAY_PORT: String(port),
      RELAY_SHARED_SECRET: SECRET,
      RELAY_CLAUDE_CWD: state(),
      MAX_ACCOUNTS_FILE: path.join(root, "accounts.json"),
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
const thread = (n: number, last: string) => [
  ...Array.from({ length: n - 1 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i + 1}` })),
  { role: "user", content: last },
];

type Turn = { events: unknown[]; hang?: boolean | number; exit?: number };
function play(events: unknown[], opts: Omit<Turn, "events"> = {}) {
  fs.writeFileSync(path.join(stubDir(), "turn.json"), JSON.stringify({ events, ...opts }));
}
/** One turn per launch of the CLI: the relay relaunching a turn by itself. */
function playAttempts(attempts: Turn[]) {
  fs.rmSync(path.join(stubDir(), "attempt"), { force: true });
  fs.writeFileSync(path.join(stubDir(), "turn.json"), JSON.stringify({ attempts }));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chat(body: Record<string, unknown>): Promise<Sse[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Sse);
}

/** The final `usage` event of a turn (the one the ledger keeps). */
const billed = (events: Sse[]) => events.filter((e) => e.type === "usage" && !e.partial).at(-1) as (Sse & { cost: number; tokens: Record<string, number>; costEstimated?: boolean }) | undefined;
const asTokens = ([input, output, cacheRead, cacheWrite]: Tokens) => ({ input, output, cacheRead, cacheWrite });
const stored = (key: string) => (JSON.parse(fs.readFileSync(path.join(state(), "sessions.json"), "utf8")) as Record<string, { id: string; cost?: number }>)[key];
const calls = () => fs.readFileSync(path.join(stubDir(), "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { prompt: string; system: string; resume: string | null });
const workspace = (sessionKey: string) => crypto.createHash("sha256").update(sessionKey).digest("hex").slice(0, 24);

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wiring-"));
  for (const d of ["bin", "home", "state", "stub"]) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, "bin", "claude"), STUB, { mode: 0o755 });
  // A token that goes nowhere: it only lets the relay offer HQ to the stand-in CLI.
  fs.writeFileSync(path.join(root, "hq-oauth.json"), JSON.stringify({
    access_token: "jeton-de-test", refresh_token: "r", client_id: "c", token_endpoint: "http://127.0.0.1:9/token", expires_at: Date.now() + 24 * 3600 * 1000,
  }));
  port = await freePort();
  await startRelay();
}, 20_000);

afterAll(async () => {
  await stopRelay();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("relay — décompte d'une conversation", () => {
  const key = "test:decompte";

  it("facture le premier tour : la somme de ses appels, le coût du CLI", async () => {
    play([...T1_CALLS.flatMap(call), result(T1, T1, TOTAL1)]);
    const usage = billed(await chat({ messages: thread(1, "Dépense d'hier ?"), sessionKey: key }));
    expect(usage?.tokens).toEqual(asTokens(T1));
    expect(usage?.cost).toBeCloseTo(TOTAL1, 9);
    expect(stored(key).cost).toBe(TOTAL1);
  });

  it("facture le tour repris par différence avec le cumul gardé", async () => {
    play([...T2_CALLS.flatMap(call), result(T2, SUM2, TOTAL2)]);
    const usage = billed(await chat({ messages: thread(3, "Et avant-hier ?"), sessionKey: key }));
    expect(calls().at(-1)?.resume).toBe(stored(key).id);
    expect(usage?.tokens).toEqual(asTokens(T2));
    expect(usage?.cost).toBeCloseTo(TOTAL2 - TOTAL1, 9);
    expect(usage?.costEstimated).toBeUndefined();
    expect(stored(key).cost).toBe(TOTAL2);
  });

  it("ne remet pas le cumul à zéro sur un résultat d'erreur sans total", async () => {
    play([result([3, 0, 0, 0], null, null, { subtype: "error_during_execution", is_error: true, result: "Réponse partielle." })]);
    const usage = billed(await chat({ messages: thread(5, "Encore"), sessionKey: key }));
    expect(usage?.cost).toBe(0);
    expect(stored(key).cost).toBe(TOTAL2);
    expect(logs).toMatch(/\[usage\] test:decompte : résultat sans total_cost_usd/);
  });

  it("ne refacture pas la session au tour qui suit l'erreur", async () => {
    play([...call(T3), result(T3, SUM3, TOTAL3)]);
    const usage = billed(await chat({ messages: thread(7, "Merci"), sessionKey: key }));
    expect(usage?.cost).toBeCloseTo(TOTAL3 - TOTAL2, 9);
    expect(stored(key).cost).toBe(TOTAL3);
  });

  it("garde le cumul d'un tour interrompu, dont seuls les appels vus sont comptés", async () => {
    play(call([2, 304, 2643, 109]), { hang: true });
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers, body: JSON.stringify({ messages: thread(9, "Long travail"), sessionKey: key }), signal: ctl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!/"type":"usage"/.test(seen)) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    ctl.abort();
    const partial = seen.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Sse).find((e) => e.type === "usage");
    expect(partial).toMatchObject({ partial: true, cost: 0, tokens: asTokens([2, 304, 2643, 109]) });
    for (let i = 0; i < 100 && !/Client disconnected/.test(logs.slice(-400)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(stored(key).cost).toBe(TOTAL3);

    // The CLI's totals do not hold the turn that was killed (measured): the
    // next one is billed against the total of the last turn that ended.
    const next: Tokens = [2, 5, 5081, 60];
    play([...call(next), result(next, plus(SUM3, next), 0.0298)]);
    const usage = billed(await chat({ messages: thread(11, "Continue"), sessionKey: key }));
    expect(usage?.cost).toBeCloseTo(0.0298 - TOTAL3, 9);
  });
});

describe("relay — session écrite avant que le cumul soit gardé", () => {
  const key = "test:ancienne";

  it("ne facture pas le cumul de la session comme coût du tour", async () => {
    play([...T1_CALLS.flatMap(call), result(T1, T1, TOTAL1)]);
    await chat({ messages: thread(1, "Premier tour"), sessionKey: key });
    // sessions.json as the relay wrote it before the change: no `cost`.
    await stopRelay();
    const file = path.join(state(), "sessions.json");
    const all = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
    delete all[key].cost;
    fs.writeFileSync(file, JSON.stringify(all));
    await startRelay();

    play([...T2_CALLS.flatMap(call), result(T2, SUM2, TOTAL2)]);
    const usage = billed(await chat({ messages: thread(3, "Deuxième tour"), sessionKey: key }));
    expect(usage?.tokens).toEqual(asTokens(T2));
    // Estimated by the turn's weight in the session: here the real cost.
    expect(usage?.cost).toBeCloseTo(TOTAL2 - TOTAL1, 6);
    expect(usage?.costEstimated).toBe(true);
    expect(stored(key).cost).toBe(TOTAL2);
    expect(logs).toMatch(/\[usage\] test:ancienne : session reprise sans cumul connu/);

    play([...call(T3), result(T3, SUM3, TOTAL3)]);
    const third = billed(await chat({ messages: thread(5, "Troisième tour"), sessionKey: key }));
    expect(third?.cost).toBeCloseTo(TOTAL3 - TOTAL2, 9);
    expect(third?.costEstimated).toBeUndefined();
  }, 20_000);
});

describe("relay — garde-fous du décompte", () => {
  it("retient la somme des appels quand le résultat annonce moins", async () => {
    // A result that would hold the last call only.
    play([...T1_CALLS.flatMap(call), result(T1_CALLS[3], T1, TOTAL1)]);
    const usage = billed(await chat({ messages: thread(1, "Question"), sessionKey: "test:plancher" }));
    expect(usage?.tokens).toEqual(asTokens(T1));
    expect(logs).toMatch(/\[usage\] test:plancher : usage du résultat inférieur à la somme des appels du tour/);
  });

  it("journalise un total qui recule et prend le coût tel quel", async () => {
    const key = "test:recul";
    play([...call(T3), result(T3, T3, 0.05)]);
    await chat({ messages: thread(1, "Un"), sessionKey: key });
    play([...call(T3), result(T3, plus(T3, T3), 0.02)]);
    const usage = billed(await chat({ messages: thread(3, "Deux"), sessionKey: key }));
    expect(usage?.cost).toBe(0.02);
    expect(logs).toMatch(/\[usage\] test:recul : total_cost_usd recule \(0\.05 → 0\.02\)/);
  });

  it("prend tel quel un coût par invocation, même quand il monte", async () => {
    const key = "test:invocation";
    play([...call(T3), result(T3, T3, 0.05)]);
    await chat({ messages: thread(1, "Un"), sessionKey: key });
    // modelUsage = the turn alone: these totals are not running totals.
    play([...call(T3), result(T3, T3, 0.08)]);
    const usage = billed(await chat({ messages: thread(3, "Deux"), sessionKey: key }));
    expect(usage?.cost).toBe(0.08);
    expect(logs).toMatch(/\[usage\] test:invocation : total_cost_usd \(0\.08\) ne couvre que ce tour/);
  });
});

describe("relay — message envoyé au CLI", () => {
  const key = "test:contexte";
  const widgets = (n: number, last = "fin") => `[ÉTAT\n${Array.from({ length: n }, (_, i) => `- id=w${i} | config=${"x".repeat(60)}`).join("\n")}\n${last}]`;

  it("journalise la question, pas la date ni le contexte", async () => {
    play([...call(T3), result(T3, T3, 0.001)]);
    await chat({ messages: thread(1, "Quelle est la\ndépense d'hier ?"), sessionKey: key, turnContext: widgets(3) });
    expect(calls().at(-1)?.prompt).toMatch(/^\[Aujourd'hui : \d{4}-\d{2}-\d{2}\]\n\[ÉTAT\n/);
    expect(logs).toContain(`[chat] Prompt: "Quelle est la dépense d'hier ?"`);
    expect(logs).not.toContain(`[chat] Prompt: "[Aujourd'hui`);
  });

  it("renvoie un contexte long qui a changé au-delà de la coupe, et annonce la coupe", async () => {
    play([...call(T3), result(T3, T3, 0.001)]);
    await chat({ messages: thread(1, "Un"), sessionKey: key, turnContext: widgets(400) });
    expect(calls().at(-1)?.prompt).toContain("CONTEXTE TRONQUÉ par le relay");

    play([...call(T3), result(T3, plus(T3, T3), 0.002)]);
    await chat({ messages: thread(3, "Deux"), sessionKey: key, turnContext: widgets(400) });
    expect(calls().at(-1)?.prompt).not.toContain("[ÉTAT");

    play([...call(T3), result(T3, plus(T3, plus(T3, T3)), 0.003)]);
    await chat({ messages: thread(5, "Trois"), sessionKey: key, turnContext: widgets(400, "fin modifiée") });
    expect(calls().at(-1)?.prompt).toContain("[ÉTAT");
    expect(logs).toMatch(/\[chat\] contexte de tour tronqué/);
  });

  it("n'ajoute son bloc HQ que si l'appelant ne dit pas qu'il s'en charge", async () => {
    play([...call(T3), result(T3, T3, 0.001)]);
    const base = { messages: thread(1, "Question"), allowedServers: ["hq"], systemPrompt: "Ne parle pas du siège (HQ) au client." };
    await chat(base);
    expect(calls().at(-1)?.system).toContain("LECTURE SEULE, à HQ");
    await chat({ ...base, hqGuidance: "caller" });
    expect(calls().at(-1)?.system).not.toContain("LECTURE SEULE, à HQ");
  });
});

describe("relay — /health", () => {
  it("annonce ce que le relay comprend, sans authentification", async () => {
    const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { status: string; capabilities?: string[] };
    expect(body.status).toBe("ok");
    expect(body.capabilities).toEqual(expect.arrayContaining(["turnContext", "hqGuidance"]));
  });
});

describe("relay — fichiers d'un workspace", () => {
  const ws = workspace("test:fichiers");
  const dir = () => path.join(state(), "workspaces", ws);
  const secret = () => path.join(root, "hote-secret.txt");
  const get = (rel: string) => fetch(`http://127.0.0.1:${port}/api/files/${ws}/${rel}`, { headers });

  beforeAll(() => {
    fs.mkdirSync(path.join(dir(), "out"), { recursive: true });
    fs.mkdirSync(path.join(dir(), "uploads"), { recursive: true });
    fs.writeFileSync(secret(), "SECRET DE L'HÔTE");
    fs.writeFileSync(path.join(dir(), "out", "rapport.txt"), "contenu du rapport");
    fs.writeFileSync(path.join(dir(), "out", "vide.txt"), "");
    fs.symlinkSync(secret(), path.join(dir(), "out", "lien.txt"));
    fs.symlinkSync(secret(), path.join(dir(), "uploads", "piege.txt"));
  });

  it("sert un fichier du workspace", async () => {
    const res = await get("out/rapport.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("contenu du rapport");
    const empty = await get("out/vide.txt");
    expect(empty.status).toBe(200);
    expect(await empty.text()).toBe("");
  });

  it("refuse un lien symbolique vers un fichier de l'hôte", async () => {
    const res = await get("out/lien.txt");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("SECRET");
  });

  it("refuse un dossier out/ remplacé par un lien", async () => {
    const other = workspace("test:dossier-lien");
    const outside = path.join(root, "hote-dossier");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "passwd"), "SECRET DU DOSSIER");
    fs.mkdirSync(path.join(state(), "workspaces", other), { recursive: true });
    fs.symlinkSync(outside, path.join(state(), "workspaces", other, "out"));
    const res = await fetch(`http://127.0.0.1:${port}/api/files/${other}/out/passwd`, { headers });
    expect(res.status).toBe(404);
    const list = await (await fetch(`http://127.0.0.1:${port}/api/files/${other}`, { headers })).json() as { files: unknown[] };
    expect(list.files).toEqual([]);
  });

  it("ne liste pas les liens", async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/api/files/${ws}`, { headers })).json() as { files: Array<{ path: string }> };
    expect(list.files.map((f) => f.path).sort()).toEqual(["out/rapport.txt", "out/vide.txt"]);
  });

  it("dépose un fichier sans écrire à travers un lien qui porte son nom", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/files/${ws}`, { method: "POST", headers, body: JSON.stringify({ name: "piege.txt", data: Buffer.from("dépôt du consultant").toString("base64") }) });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(secret(), "utf8")).toBe("SECRET DE L'HÔTE");
    const placed = path.join(dir(), "uploads", "piege.txt");
    expect(fs.lstatSync(placed).isFile()).toBe(true);
    expect(fs.readFileSync(placed, "utf8")).toBe("dépôt du consultant");
    expect(fs.readdirSync(path.join(dir(), "uploads"))).toEqual(["piege.txt"]);
    expect(await (await get("uploads/piege.txt")).text()).toBe("dépôt du consultant");
  });
});

describe("relay — budget de temps et fin du tour", () => {
  // The default budget is not bounded from below: short enough for a test.
  beforeAll(async () => { await stopRelay(); await startRelay({ RELAY_CHAT_BUDGET_MS: "2500" }); }, 20_000);
  afterAll(async () => { await stopRelay(); await startRelay(); }, 20_000);

  it("n'envoie ni usage partiel ni « resumable » quand le budget tombe après le résultat", async () => {
    const key = "test:budget";
    // The result is out at once; the CLI is still there when the budget falls.
    play([...call(T1), result(T1, T1, TOTAL1)], { hang: 6000 });
    const t0 = Date.now();
    const events = await chat({ messages: thread(1, "Long"), sessionKey: key });
    expect(Date.now() - t0).toBeLessThan(5500); // the reply does not wait for the CLI
    const usages = events.filter((e) => e.type === "usage");
    expect(usages.at(-1)).toMatchObject({ cost: TOTAL1, tokens: asTokens(T1) });
    expect(usages.at(-1)?.partial).toBeUndefined();
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.at(-1)?.type).toBe("done");
    expect(stored(key).cost).toBe(TOTAL1);

    // The CLI left behind is stopped: the next turn resumes the session.
    play([...call(T2), result(T2, SUM2, TOTAL2)]);
    const next = billed(await chat({ messages: thread(3, "Suite"), sessionKey: key }));
    expect(calls().at(-1)?.resume).toBe(stored(key).id);
    expect(next?.cost).toBeCloseTo(TOTAL2 - TOTAL1, 9);
  }, 20_000);

  it("coupe encore un tour sans résultat : usage partiel, puis erreur « resumable »", async () => {
    play(call(T3), { hang: true });
    const events = await chat({ messages: thread(1, "Long"), sessionKey: "test:budget-coupe" });
    expect(events.filter((e) => e.type === "usage").at(-1)).toMatchObject({ partial: true, cost: 0, tokens: asTokens(T3) });
    expect(events.find((e) => e.type === "error")).toMatchObject({ resumable: true });
  }, 20_000);
});

describe("relay — appel relancé dans le flux", () => {
  it("ne prend pas le cumul de la session pour le tour quand un message_start est vu deux fois", async () => {
    const key = "test:relance-appel";
    play([...T1_CALLS.flatMap(call), result(T1, T1, TOTAL1)]);
    await chat({ messages: thread(1, "Un"), sessionKey: key });
    // One call of the turn, started twice: the first attempt never ended.
    const [start, ...rest] = call(T2);
    play([start, start, ...rest, result(T2, SUM2, TOTAL2)]);
    const usage = billed(await chat({ messages: thread(3, "Deux"), sessionKey: key }));
    expect(usage?.cost).toBeCloseTo(TOTAL2 - TOTAL1, 9);
    expect(usage?.tokens).toEqual(asTokens(T2));
    expect(stored(key).cost).toBe(TOTAL2);
    expect(logs).toMatch(/\[usage\] test:relance-appel : appel relancé avant sa fin/);
  });
});

describe("relay — un seul tour à la fois par conversation", () => {
  it("refuse le second tour tant que le premier court, et ne lance pas le CLI", async () => {
    const key = "test:simultane";
    play([...call(T1), result(T1, T1, TOTAL1)]);
    await chat({ messages: thread(1, "Un"), sessionKey: key });

    const launched = calls().length;
    play([...call(T2), result(T2, SUM2, TOTAL2)], { hang: 1500 });
    const first = chat({ messages: thread(3, "Deux"), sessionKey: key });
    await sleep(500);
    play([...call(T2), result(T2, SUM2, 0.02)]);
    const second = await chat({ messages: thread(3, "Deux"), sessionKey: key });
    expect(second.map((e) => e.type)).toEqual(["error", "done"]);
    expect(String(second[0].message)).toMatch(/déjà en cours sur cette conversation/);
    expect(second[0].resumable).toBeUndefined();

    expect(billed(await first)?.cost).toBeCloseTo(TOTAL2 - TOTAL1, 9);
    expect(calls().length).toBe(launched + 1);
    expect(stored(key).cost).toBe(TOTAL2);
    expect(logs).toMatch(/\[chat\] test:simultane : tour refusé/);

    // Once the first has ended the conversation goes on, from the right total.
    play([...call(T3), result(T3, SUM3, TOTAL3)]);
    const third = billed(await chat({ messages: thread(5, "Trois"), sessionKey: key }));
    expect(third?.cost).toBeCloseTo(TOTAL3 - TOTAL2, 9);
  }, 20_000);

  it("laisse courir en même temps deux conversations différentes", async () => {
    play([...call(T3), result(T3, T3, 0.001)], { hang: 800 });
    const both = await Promise.all(["test:paire-a", "test:paire-b"].map((k) => chat({ messages: thread(1, "Un"), sessionKey: k })));
    for (const events of both) expect(billed(events)?.cost).toBe(0.001);
  }, 20_000);
});

describe("relay — relance sur un autre compte Claude Max, jamais sur Bedrock", () => {
  // A second Max account in the pool: a refused turn is relaunched on it.
  const pool = () => fs.writeFileSync(path.join(root, "accounts.json"), JSON.stringify({ accounts: [{ id: "second", label: "Second", token: `sk-ant-oat01-${"x".repeat(40)}`, addedAt: "2026-10-01" }] }));
  beforeAll(async () => { await stopRelay(); pool(); await startRelay({ BEDROCK_FALLBACK: "1" }); }, 20_000);
  afterAll(async () => { await stopRelay(); fs.rmSync(path.join(root, "accounts.json"), { force: true }); await startRelay(); }, 20_000);

  it("compte ce que la tentative refusée avait consommé", async () => {
    const key = "test:relance-compte";
    const refused: Tokens = [2, 61, 0, 1700];
    playAttempts([
      { events: [...call(refused), result(refused, refused, 0.004, { is_error: true, result: "You've hit your usage limit" })] },
      { events: [...call(T3), result(T3, T3, 0.002)] },
    ]);
    const events = await chat({ messages: thread(1, "Question"), sessionKey: key });
    expect(logs).toMatch(/saturé — relance sur second/);
    const usage = billed(events);
    expect(usage).toMatchObject({ provider: "subscription", account: "second", tokens: asTokens(plus(refused, T3)) });
    expect(usage?.cost).toBeCloseTo(0.006, 9);
    expect(usage?.earlierAttempts).toEqual([expect.objectContaining({ tokens: asTokens(refused), cost: 0.004 })]);
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    // The session kept is the relaunched one, with its own total.
    expect(stored(key).cost).toBe(0.002);
    expect(logs).toMatch(/\[usage\] test:relance-compte : tentative sur le compte .* refusée après consommation/);
  }, 20_000);

  it("ne reporte rien quand le refus vient avant toute consommation", async () => {
    playAttempts([
      { events: [result([0, 0, 0, 0], null, null, { is_error: true, result: "You've hit your usage limit" })] },
      { events: [...call(T3), result(T3, T3, 0.002)] },
    ]);
    // The host account is parked since the refusal above: a relay that has
    // just started sends the first attempt to it again.
    await stopRelay();
    await startRelay({ BEDROCK_FALLBACK: "1" });
    const usage = billed(await chat({ messages: thread(1, "Question"), sessionKey: "test:relance-vide" }));
    expect(usage).toMatchObject({ provider: "subscription", account: "second", cost: 0.002, tokens: asTokens(T3) });
    expect(usage?.earlierAttempts).toBeUndefined();
  }, 20_000);

  it("tous les comptes saturés : un message clair, et toujours pas Bedrock (réservé aux bots clients)", async () => {
    await stopRelay();
    fs.rmSync(path.join(root, "accounts.json"), { force: true });
    await startRelay({ BEDROCK_FALLBACK: "1" });
    playAttempts([{ events: [result([0, 0, 0, 0], null, null, { is_error: true, result: "You've hit your usage limit" })] }]);
    const events = await chat({ messages: thread(1, "Question"), sessionKey: "test:tout-sature" });
    expect(logs).not.toMatch(/relance sur bedrock|bedrock@/);
    expect(events.filter((e) => e.type === "error").map((e) => String(e.message))).toEqual([expect.stringMatching(/Tous les comptes Claude Max de l'agence sont saturés/)]);
    pool();
  }, 20_000);
});

describe("relay — dossiers du workspace à l'ouverture d'un tour", () => {
  const dirOf = (key: string) => path.join(state(), "workspaces", workspace(key));
  const outside = (name: string) => path.join(root, name);

  it("remplace un out/ qui est un lien pendant, sans rien créer chez l'hôte", async () => {
    const key = "test:lien-pendant";
    fs.mkdirSync(dirOf(key), { recursive: true });
    fs.symlinkSync(outside("cree-par-le-relay"), path.join(dirOf(key), "out"));
    play([...call(T3), result(T3, T3, 0.001)]);
    const events = await chat({ messages: thread(1, "Question"), sessionKey: key, allowedServers: ["sandbox"] });
    expect(billed(events)?.cost).toBe(0.001);
    expect(events.at(-1)?.type).toBe("done");
    expect(fs.lstatSync(path.join(dirOf(key), "out")).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(dirOf(key), "uploads")).isDirectory()).toBe(true);
    expect(fs.existsSync(outside("cree-par-le-relay"))).toBe(false);
  });

  it("retire un uploads/ qui est un lien vers un dossier de l'hôte, sans le suivre", async () => {
    const key = "test:lien-dossier";
    fs.mkdirSync(outside("hote-uploads"));
    fs.writeFileSync(path.join(outside("hote-uploads"), "temoin"), "TÉMOIN");
    fs.mkdirSync(dirOf(key), { recursive: true });
    fs.symlinkSync(outside("hote-uploads"), path.join(dirOf(key), "uploads"));
    play([...call(T3), result(T3, T3, 0.001)]);
    expect(billed(await chat({ messages: thread(1, "Question"), sessionKey: key, allowedServers: ["sandbox"] }))?.cost).toBe(0.001);
    expect(fs.lstatSync(path.join(dirOf(key), "uploads")).isDirectory()).toBe(true);
    expect(fs.readdirSync(outside("hote-uploads"))).toEqual(["temoin"]);
  });

  it("répond par une erreur explicite quand le workspace est lui-même un lien", async () => {
    const key = "test:workspace-lien";
    fs.mkdirSync(outside("hote-workspace"));
    fs.mkdirSync(path.dirname(dirOf(key)), { recursive: true });
    fs.symlinkSync(outside("hote-workspace"), dirOf(key));
    const launched = calls().length;
    play([...call(T3), result(T3, T3, 0.001)]);
    const events = await chat({ messages: thread(1, "Question"), sessionKey: key, allowedServers: ["sandbox"] });
    expect(events.map((e) => e.type)).toEqual(["error", "done"]);
    expect(String(events[0].message)).toMatch(/dossier de travail .* inutilisable/);
    expect(calls().length).toBe(launched);
    expect(fs.readdirSync(outside("hote-workspace"))).toEqual([]);
    // The conversation is not left locked by the refusal.
    expect((await chat({ messages: thread(1, "Question"), sessionKey: key, allowedServers: ["sandbox"] })).map((e) => e.type)).toEqual(["error", "done"]);
    fs.unlinkSync(dirOf(key));
  });
});

describe("relay — purge des workspaces", () => {
  const OLD = new Date(Date.now() - 20 * 24 * 3600 * 1000);
  const ws = (name: string) => path.join(state(), "workspaces", name);
  const host = () => path.join(root, "hote-purge");
  /** Dates everything under `dir`, links themselves included, without following any. */
  const age = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) age(abs);
      else fs.lutimesSync(abs, OLD, OLD);
    }
    fs.utimesSync(dir, OLD, OLD);
  };

  beforeAll(async () => {
    await stopRelay();
    fs.mkdirSync(path.join(host(), "dossier"), { recursive: true });
    fs.writeFileSync(path.join(host(), "recent.txt"), "FICHIER DE L'HÔTE");
    fs.writeFileSync(path.join(host(), "dossier", "temoin"), "TÉMOIN");
    fs.mkdirSync(path.join(host(), "ancien", "out"), { recursive: true });
    fs.writeFileSync(path.join(host(), "ancien", "out", "temoin"), "TÉMOIN");
    age(path.join(host(), "ancien"));

    // Old, with a link to a host file touched today: the link's own date counts.
    fs.mkdirSync(path.join(ws("a".repeat(24)), "out"), { recursive: true });
    fs.mkdirSync(path.join(ws("a".repeat(24)), "uploads"));
    fs.writeFileSync(path.join(ws("a".repeat(24)), "out", "rapport.txt"), "x");
    fs.symlinkSync(path.join(host(), "recent.txt"), path.join(ws("a".repeat(24)), "out", "lien.txt"));
    age(ws("a".repeat(24)));
    // Old, its out/ a link to a host folder, and a link to one deeper down.
    fs.mkdirSync(path.join(ws("b".repeat(24)), "uploads", "sous"), { recursive: true });
    fs.symlinkSync(path.join(host(), "dossier"), path.join(ws("b".repeat(24)), "out"));
    fs.symlinkSync(path.join(host(), "dossier"), path.join(ws("b".repeat(24)), "uploads", "sous", "lien"));
    age(ws("b".repeat(24)));
    // A workspace that is itself a link, to an old host folder.
    fs.symlinkSync(path.join(host(), "ancien"), ws("c".repeat(24)));
    fs.lutimesSync(ws("c".repeat(24)), OLD, OLD);
    // Old but for one file of today.
    fs.mkdirSync(path.join(ws("d".repeat(24)), "out"), { recursive: true });
    age(ws("d".repeat(24)));
    fs.writeFileSync(path.join(ws("d".repeat(24)), "out", "du-jour.txt"), "x");
    fs.utimesSync(path.join(ws("d".repeat(24)), "out"), OLD, OLD);
    fs.utimesSync(ws("d".repeat(24)), OLD, OLD);

    await startRelay(); // the purge runs when the relay starts
  }, 20_000);

  it("purge un workspace ancien sans dater ni suivre les liens qu'il contient", () => {
    expect(fs.existsSync(ws("a".repeat(24)))).toBe(false);
    expect(fs.existsSync(ws("b".repeat(24)))).toBe(false);
    expect(fs.readFileSync(path.join(host(), "recent.txt"), "utf8")).toBe("FICHIER DE L'HÔTE");
    expect(fs.readdirSync(path.join(host(), "dossier"))).toEqual(["temoin"]);
  });

  it("refuse un workspace qui est lui-même un lien : ni purgé, ni suivi", () => {
    expect(fs.lstatSync(ws("c".repeat(24))).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(path.join(host(), "ancien", "out"))).toEqual(["temoin"]);
    expect(logs).toMatch(/\[workspace\] c{24} est un lien — ignoré par la purge/);
  });

  it("garde un workspace dont un fichier est récent", () => {
    expect(fs.readdirSync(path.join(ws("d".repeat(24)), "out"))).toEqual(["du-jour.txt"]);
  });
});
