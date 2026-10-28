/**
 * Persistent CLI sessions ("warm" processes) of the relay.
 *
 * A turn of a named conversation used to spawn a fresh `claude` process every
 * time (startup, MCP servers, a first ToolSearch round-trip): 9 to 13 s before
 * the first tool call, even on a resumed transcript. For the surfaces that
 * must answer at the pace of a conversation (Mo, the voice assistant), this
 * pool keeps ONE CLI process per sessionKey alive between turns, started with
 * `--input-format stream-json`: every new user message is written on its
 * stdin, the CLI answers with the same event stream as a one-shot run and
 * ends the turn with its `result` event, then waits for the next message
 * (checked on CLI 2.1.312: the process stays alive, re-emits `system init`
 * at each turn, `usage` is the turn alone, `total_cost_usd`/`modelUsage` run
 * since the session started — exactly what a `--resume` run reports, so the
 * turn meter of relay-prompt.mjs applies unchanged). The CLI starts its MCP
 * servers at launch, before any message: a process started ahead of the
 * first turn (`warm`, POST /api/chat/warm) answers it warm too.
 *
 * The chat code (relay.mjs, runChat) does not know about the pool: `acquire`
 * hands it a TurnHandle that looks like the ChildProcess it reads today
 * (`stdout`/`stderr` "data", `stdin.write/end`, `kill`, `exitCode`,
 * `on("close")`, `on("error")`). The handle "closes" when the turn's result
 * is out (exit code 0) or when the process dies (its real code). Killing the
 * handle during a turn kills the process — the time budget and the client
 * disconnect keep their meaning — and the next turn starts cold again, on
 * the transcript the CLI left on disk (`--session-id` → `--resume`).
 *
 * A process is recycled when the scope signature of the conversation changes
 * (servers, tools, account scope, system prompt, model, effort…), when its
 * session id changes (new conversation on the same key), when its Max
 * account is refused, after MAX_TURNS turns or MAX_AGE_MS (bearer tokens in
 * its MCP config last an hour), and after IDLE_MS without a turn. At most
 * MAX_PROCESSES live at once; beyond, the least recently used idle one goes,
 * and when all are busy the caller runs the turn one-shot as before.
 *
 * A warm process that stays silent after a message (stuck) is killed after
 * FIRST_EVENT_MS and the turn is re-run on a fresh one-shot process, over the
 * same handle: the caller sees one turn, a little slower.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";

// Memory per warm Mo conversation on this 4 GB host (measured 2026-10-28):
// CLI ~200 MB + ~80 MB per stdio MCP server — ~280 MB on the default belt
// ("mo" alone), ~600 MB on the wide one (five servers). Four at most.
const MAX_PROCESSES = clampInt(process.env.RELAY_PERSISTENT_MAX, 1, 32, 4);
const IDLE_MS = clampInt(process.env.RELAY_PERSISTENT_IDLE_MS, 30_000, 6 * 3600_000, 10 * 60_000);
const MAX_TURNS = clampInt(process.env.RELAY_PERSISTENT_MAX_TURNS, 2, 1000, 40);
const MAX_AGE_MS = clampInt(process.env.RELAY_PERSISTENT_MAX_AGE_MS, 60_000, 24 * 3600_000, 50 * 60_000);
// A warm process answers a message with `system init` within ~100 ms.
const FIRST_EVENT_MS = clampInt(process.env.RELAY_PERSISTENT_FIRST_EVENT_MS, 2_000, 120_000, 15_000);
const KILL_GRACE_MS = 5_000;
const RSS_LOG_MS = 10 * 60_000;
// Which conversations run warm: "mo:" unless MO_PERSISTENT=0, plus any
// prefix listed in RELAY_PERSISTENT_PREFIXES (comma-separated, for trials).
const EXTRA_PREFIXES = (process.env.RELAY_PERSISTENT_PREFIXES || "").split(",").map((s) => s.trim()).filter(Boolean);
const MO_ON = !["0", "false", "off"].includes((process.env.MO_PERSISTENT || "").trim().toLowerCase());

function clampInt(raw, min, max, dflt) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
}

/** Whether a conversation of this key runs on a persistent process. */
export function persistentEnabled(sessionKey) {
  if (typeof sessionKey !== "string" || !sessionKey) return false;
  if (sessionKey.startsWith("mo:")) return MO_ON;
  return EXTRA_PREFIXES.some((p) => sessionKey.startsWith(p));
}

/** @type {Map<string, Entry>} */
const pool = new Map();
/** Counters since the relay started (for /health and the logs). */
const stats = { started: 0, warmTurns: 0, coldTurns: 0, recycled: 0, muteFallbacks: 0, diedIdle: 0, diedInTurn: 0 };

/**
 * What the chat code reads in place of a ChildProcess. One per turn.
 */
class TurnHandle extends EventEmitter {
  constructor(entry) {
    super();
    this.entry = entry;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = null;
    this.signalCode = null;
    this.pid = entry.proc?.pid ?? null;
    this.ended = false;
    this.sawEvent = false;
    this.startedAt = Date.now();
    /** The one JSON line of the turn, kept for a one-shot re-run. */
    this.input = "";
    this.watchdog = null;
    this.fallback = null; // one-shot ChildProcess when the warm process went mute
    const handle = this;
    this.stdin = {
      write(data) {
        const text = String(data);
        handle.input += text;
        if (handle.fallback) { handle.fallback.stdin.write(text); return true; }
        return entry.write(text);
      },
      // The process must stay open for the next turn: nothing to end here.
      end() { if (handle.fallback) handle.fallback.stdin.end(); },
      on() { return this; },
      once() { return this; },
    };
  }

  /** Mirrors ChildProcess.kill: stops the turn — and the process with it. */
  kill(signal = "SIGTERM") {
    if (this.ended) return false;
    if (this.fallback) {
      try { this.fallback.kill(signal); } catch { /* gone */ }
      return true;
    }
    this.entry.evict(`arrêt du tour (${signal})`, { keepHandle: true });
    return true;
  }

  /** A line of the event stream for this turn. */
  deliver(line) {
    if (this.ended) return;
    if (!this.sawEvent) { this.sawEvent = true; clearTimeout(this.watchdog); }
    this.stdout.emit("data", Buffer.from(line + "\n"));
  }

  endTurn(code, signal) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.watchdog);
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

class Entry {
  constructor({ key, sessionId, signature, account }) {
    this.key = key;
    this.sessionId = sessionId;
    this.signature = signature;
    this.account = account;
    this.proc = null;
    /** Started on an existing transcript (--resume) rather than a fresh id. */
    this.resumed = false;
    this.startedAt = Date.now();
    this.lastUsedAt = Date.now();
    this.turns = 0;
    /** @type {TurnHandle | null} */
    this.active = null;
    this.buffer = "";
    this.idleTimer = null;
    this.dead = false;
    this.evicting = false;
    this.mcpCleanup = null;
  }

  get alive() {
    return !this.dead && !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  start({ args, spawnOptions }) {
    const proc = spawn("claude", args, spawnOptions);
    this.proc = proc;
    stats.started += 1;
    proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) if (line.trim()) this.onLine(line);
    });
    proc.stderr.on("data", (chunk) => {
      if (this.active) this.active.stderr.emit("data", chunk);
      else {
        const t = chunk.toString().trim();
        if (t) console.error(`[mo-session] ${this.key} (au repos) claude: ${t.slice(0, 300)}`);
      }
    });
    proc.stdin.on("error", (err) => {
      console.error(`[mo-session] ${this.key} : stdin ${err.code || err.message}`);
      this.evict("stdin fermé");
    });
    proc.on("error", (err) => {
      this.dead = true;
      const h = this.active;
      this.active = null;
      this.drop();
      if (h) h.emit("error", err);
    });
    proc.on("close", (code, signal) => {
      this.dead = true;
      const h = this.active;
      this.active = null;
      if (!this.evicting) {
        if (h) stats.diedInTurn += 1; else stats.diedIdle += 1;
        console.error(`[mo-session] ${this.key} : processus terminé de lui-même (${signal || code}) ${h ? "pendant un tour — le tour échoue" : "au repos — le prochain tour redémarre à froid"}`);
      }
      this.drop();
      if (h) h.endTurn(code, signal);
    });
  }

  write(text) {
    if (!this.alive) return false;
    try { return this.proc.stdin.write(text); } catch { return false; }
  }

  onLine(line) {
    const h = this.active;
    if (!h) return; // late event of a turn already closed (rate_limit_event…)
    h.deliver(line);
    let type = null;
    try { type = JSON.parse(line)?.type; } catch { /* not for us */ }
    if (type !== "result") return;
    // The turn is over: the process stays, idle, for the next message.
    this.active = null;
    this.turns += 1;
    this.lastUsedAt = Date.now();
    if (h.warm) stats.warmTurns += 1; else stats.coldTurns += 1;
    console.log(`[mo-session] ${this.key} turn ${this.turns} en ${Date.now() - h.startedAt} ms (${h.warm ? "warm" : "cold"})`);
    this.armIdle();
    setImmediate(() => h.endTurn(0, null));
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.evict(`inactif depuis ${Math.round(IDLE_MS / 60000)} min`), IDLE_MS);
    this.idleTimer.unref?.();
  }

  /** Forgets the entry (pool, MCP config); does not touch the process. */
  drop() {
    clearTimeout(this.idleTimer);
    if (pool.get(this.key) === this) pool.delete(this.key);
    const cleanup = this.mcpCleanup;
    this.mcpCleanup = null;
    try { cleanup?.(); } catch { /* best effort */ }
  }

  /**
   * Kills the process (SIGTERM, then SIGKILL). With `keepHandle` the active
   * turn is told through the process close (its real exit code); without it
   * the active turn, if any, is detached first (the caller re-runs it).
   */
  evict(reason, { keepHandle = false } = {}) {
    if (this.evicting) return;
    this.evicting = true;
    clearTimeout(this.idleTimer);
    if (!keepHandle) this.active = null;
    if (pool.get(this.key) === this) pool.delete(this.key);
    stats.recycled += 1;
    console.log(`[mo-session] ${this.key} : processus recyclé — ${reason}${memoryLine(" ; ")}`);
    if (!this.alive) { this.dead = true; this.drop(); return; }
    const proc = this.proc;
    try { proc.kill("SIGTERM"); } catch { /* gone */ }
    setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill("SIGKILL"); } catch { /* gone */ } } }, KILL_GRACE_MS).unref();
  }
}

/** Why an entry cannot take this turn, or null when it can. */
function unfit(entry, { sessionId, signature, accountOk }) {
  if (!entry.alive) return "processus mort";
  if (entry.active) return "tour précédent encore actif";
  if (entry.sessionId !== sessionId) return "nouvelle conversation";
  if (entry.signature !== signature) return "périmètre ou consignes modifiés";
  if (entry.turns >= MAX_TURNS) return `${MAX_TURNS} tours atteints`;
  if (Date.now() - entry.startedAt > MAX_AGE_MS) return "âge maximal atteint";
  if (accountOk && !accountOk(entry.account)) return "compte Claude Max refusé";
  return null;
}

/**
 * The account a warm process of this conversation would answer with, or
 * null when the turn will start a process (the caller then picks one).
 */
export function warmAccount({ key, sessionId, signature, accountOk = null }) {
  const entry = pool.get(key);
  return entry && !unfit(entry, { sessionId, signature, accountOk }) ? entry.account : null;
}

/**
 * The session id of a process pre-warmed for this conversation that has not
 * spoken yet and was started on a fresh id (no transcript behind it): a
 * first turn adopts it instead of drawing a new id, so the warm-up pays.
 */
export function freshSessionId(key, signature) {
  const entry = pool.get(key);
  if (!entry || !entry.alive || entry.active || entry.resumed || entry.turns > 0 || entry.signature !== signature) return null;
  return entry.sessionId;
}

/** The flag that attaches a process to its transcript: resume it when it exists. */
function sessionArgsFor(sessionId, transcriptPath) {
  return fs.existsSync(transcriptPath) ? ["--resume", sessionId] : ["--session-id", sessionId];
}

/**
 * The entry that will take the next turn of `key`: the existing one when it
 * fits, else a new process (the old one, if any, is recycled). Null when the
 * pool is full of busy processes or the process cannot start.
 */
function entryFor({ key, sessionId, signature, account, accountOk, args, spawnOptions, transcriptPath, mcpCleanup }) {
  let entry = pool.get(key);
  if (entry) {
    const why = unfit(entry, { sessionId, signature, accountOk });
    if (!why) {
      try { mcpCleanup?.(); } catch { /* best effort */ }
      return { entry, created: false };
    }
    // An active handle (never, the per-conversation lock forbids it) would
    // learn the end from the process exit.
    entry.evict(why, { keepHandle: !!entry.active });
    entry = null;
  }
  if (pool.size >= MAX_PROCESSES) {
    const idle = [...pool.values()].filter((e) => !e.active).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!idle) return { entry: null, created: false, reason: `${MAX_PROCESSES} processus occupés` };
    idle.evict("place libérée pour une autre conversation");
  }
  entry = new Entry({ key, sessionId, signature, account });
  entry.mcpCleanup = mcpCleanup;
  pool.set(key, entry);
  const sessionArgs = sessionArgsFor(sessionId, transcriptPath);
  entry.resumed = sessionArgs[0] === "--resume";
  try {
    entry.start({ args: [...args, ...sessionArgs], spawnOptions });
  } catch (err) {
    console.error(`[mo-session] ${key} : lancement impossible — ${err.message}`);
    entry.drop();
    return { entry: null, created: false, reason: `lancement impossible (${err.message})` };
  }
  return { entry, created: true };
}

/**
 * A handle for one turn of `key`: on the warm process when one fits, else on
 * a new one (started with `args` + the session flag, `--input-format
 * stream-json` expected in `args`). Returns null when the pool is full of
 * busy processes — the caller then runs the turn one-shot.
 *
 * `mcpCleanup` removes the scoped MCP config written for this turn: a new
 * process keeps it for its whole life, a warm one has its own (the new file
 * is removed at once).
 */
export function acquire(params) {
  const { entry, created, reason } = entryFor(params);
  if (!entry) { console.error(`[mo-session] ${params.key} : ${reason} — tour en one-shot`); return null; }
  const warm = !created;
  clearTimeout(entry.idleTimer);
  const handle = new TurnHandle(entry);
  handle.warm = warm;
  entry.active = handle;
  if (warm) {
    // A warm process that says nothing is stuck: the turn moves to a one-shot
    // process over the same handle, and the stuck one goes.
    const { key, args, spawnOptions, transcriptPath, sessionId } = params;
    handle.watchdog = setTimeout(() => {
      if (handle.ended || handle.sawEvent) return;
      stats.muteFallbacks += 1;
      console.error(`[mo-session] ${key} : REPLI one-shot n°${stats.muteFallbacks} — processus chaud muet ${FIRST_EVENT_MS} ms après le message (pid ${entry.proc?.pid ?? "?"}, ${entry.turns} tours, ${Math.round((Date.now() - entry.startedAt) / 1000)} s de vie)`);
      entry.evict("processus muet");
      runOneShot(handle, { key, args: [...args, ...sessionArgsFor(sessionId, transcriptPath)], spawnOptions });
    }, FIRST_EVENT_MS);
  }
  return { child: handle, warm, account: entry.account };
}

/**
 * Starts the process of `key` ahead of its first turn, without a message
 * (POST /api/chat/warm). Idempotent: a fitting warm process is left alone.
 * @returns {{ warm: boolean, created: boolean, reason: string }}
 */
export function warm(params) {
  const existing = pool.get(params.key);
  if (existing?.active) return { warm: true, created: false, reason: "un tour est en cours sur ce processus" };
  const { entry, created, reason } = entryFor(params);
  if (!entry) return { warm: false, created: false, reason: reason ?? "pool plein" };
  entry.armIdle();
  console.log(`[mo-session] ${params.key} : ${created ? `préchauffé (pid ${entry.proc?.pid}, ${entry.resumed ? "reprise du transcript" : "session neuve"})` : "déjà chaud"}`);
  return { warm: true, created, reason: created ? "processus démarré" : "déjà chaud" };
}

/** Re-runs the turn of `handle` on a fresh process that exits after it. */
function runOneShot(handle, { key, args, spawnOptions }) {
  let proc;
  try { proc = spawn("claude", args, spawnOptions); }
  catch (err) { handle.emit("error", err); return; }
  handle.fallback = proc;
  handle.pid = proc.pid;
  let buffer = "";
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) handle.deliver(line);
  });
  proc.stderr.on("data", (chunk) => handle.stderr.emit("data", chunk));
  proc.on("error", (err) => handle.emit("error", err));
  proc.on("close", (code, signal) => {
    console.log(`[mo-session] ${key} tour de repli terminé en ${Date.now() - handle.startedAt} ms (one-shot, code ${signal || code})`);
    handle.endTurn(code, signal);
  });
  proc.stdin.write(handle.input);
  proc.stdin.end();
}

// ── Memory of the pool ───────────────────────────────────────────────────────
// Resident memory of every pool process and its children (the MCP servers),
// read from /proc — Linux only, which is where the relay runs.
const PAGE_KB = 4;
function procTable() {
  const byParent = new Map();
  const rssKb = new Map();
  let names;
  try { names = fs.readdirSync("/proc"); } catch { return { byParent, rssKb }; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(after[1]);
      const rss = Number(after[21]) * PAGE_KB; // resident pages
      const pid = Number(name);
      rssKb.set(pid, rss);
      if (!byParent.has(ppid)) byParent.set(ppid, []);
      byParent.get(ppid).push(pid);
    } catch { /* process gone */ }
  }
  return { byParent, rssKb };
}

/** @returns {{ processes: number, totalMb: number, cliMb: number, mcpMb: number, perKey: Array<{ key: string, mb: number, children: number }> }} */
export function memory() {
  const { byParent, rssKb } = procTable();
  const perKey = [];
  let cli = 0, mcp = 0;
  for (const entry of pool.values()) {
    const pid = entry.proc?.pid;
    if (!pid || !rssKb.has(pid)) continue;
    const own = rssKb.get(pid);
    let kids = 0, kidsKb = 0;
    const stack = [...(byParent.get(pid) ?? [])];
    while (stack.length) {
      const p = stack.pop();
      kids += 1;
      kidsKb += rssKb.get(p) ?? 0;
      stack.push(...(byParent.get(p) ?? []));
    }
    cli += own;
    mcp += kidsKb;
    perKey.push({ key: entry.key, mb: Math.round((own + kidsKb) / 1024), children: kids });
  }
  return { processes: perKey.length, totalMb: Math.round((cli + mcp) / 1024), cliMb: Math.round(cli / 1024), mcpMb: Math.round(mcp / 1024), perKey };
}

function memoryLine(prefix = "") {
  const m = memory();
  if (!m.processes) return "";
  return `${prefix}mémoire du pool : ${m.processes} processus, ${m.totalMb} Mo (cli ${m.cliMb} Mo + mcp ${m.mcpMb} Mo)`;
}

setInterval(() => {
  if (!pool.size) return;
  const m = memory();
  console.log(`[mo-session] mémoire du pool : ${m.processes} processus, ${m.totalMb} Mo (cli ${m.cliMb} Mo + mcp ${m.mcpMb} Mo) — ${m.perKey.map((e) => `${e.key} ${e.mb} Mo/${e.children} mcp`).join(", ")}`);
}, RSS_LOG_MS).unref();

/** For /health. */
export function snapshot() {
  return { processes: pool.size, busy: [...pool.values()].filter((e) => e.active).length, max: MAX_PROCESSES, memoryMb: memory().totalMb, stats: { ...stats } };
}

/** Kills every process (relay shutdown). */
export function evictAll(reason = "arrêt du relay") {
  for (const entry of [...pool.values()]) entry.evict(reason);
}
