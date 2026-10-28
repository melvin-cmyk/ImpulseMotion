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
 * turn meter of relay-prompt.mjs applies unchanged).
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

// Each warm Mo conversation holds ~600 MB (CLI ~220 MB + 5 MCP servers ~75 MB
// each) on a 4 GB host: three at most unless RELAY_PERSISTENT_MAX says otherwise.
const MAX_PROCESSES = clampInt(process.env.RELAY_PERSISTENT_MAX, 1, 32, 3);
const IDLE_MS = clampInt(process.env.RELAY_PERSISTENT_IDLE_MS, 30_000, 6 * 3600_000, 10 * 60_000);
const MAX_TURNS = clampInt(process.env.RELAY_PERSISTENT_MAX_TURNS, 2, 1000, 40);
const MAX_AGE_MS = clampInt(process.env.RELAY_PERSISTENT_MAX_AGE_MS, 60_000, 24 * 3600_000, 50 * 60_000);
// A warm process answers a message with `system init` within ~100 ms.
const FIRST_EVENT_MS = clampInt(process.env.RELAY_PERSISTENT_FIRST_EVENT_MS, 2_000, 120_000, 15_000);
const KILL_GRACE_MS = 5_000;
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
  constructor({ key, sessionId, signature, account, warmLabel }) {
    this.key = key;
    this.sessionId = sessionId;
    this.signature = signature;
    this.account = account;
    this.label = warmLabel;
    this.proc = null;
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
        if (t) console.error(`[mo-session] ${this.key} (inactif) claude: ${t.slice(0, 300)}`);
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
      if (!this.evicting) console.error(`[mo-session] ${this.key} : processus terminé (${signal || code})${h ? " pendant un tour" : " au repos"}`);
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
    console.log(`[mo-session] ${this.key} : processus recyclé — ${reason}`);
    if (!this.alive) { this.dead = true; this.drop(); return; }
    const proc = this.proc;
    try { proc.kill("SIGTERM"); } catch { /* gone */ }
    setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill("SIGKILL"); } catch { /* gone */ } } }, KILL_GRACE_MS).unref();
  }
}

/** Age/turn bounds a process must still respect to take another turn. */
function reusable(entry, { sessionId, signature, accountOk }) {
  if (!entry.alive || entry.active) return false;
  if (entry.sessionId !== sessionId) return false;
  if (entry.signature !== signature) return false;
  if (entry.turns >= MAX_TURNS) return false;
  if (Date.now() - entry.startedAt > MAX_AGE_MS) return false;
  if (accountOk && !accountOk(entry.account)) return false;
  return true;
}

/**
 * The account a warm process of this conversation would answer with, or
 * null when the turn will start a process (the caller then picks one).
 */
export function warmAccount({ key, sessionId, signature, accountOk = null }) {
  const entry = pool.get(key);
  return entry && reusable(entry, { sessionId, signature, accountOk }) ? entry.account : null;
}

/** The flag that attaches a process to its transcript: resume it when it exists. */
function sessionArgsFor(sessionId, transcriptPath) {
  return fs.existsSync(transcriptPath) ? ["--resume", sessionId] : ["--session-id", sessionId];
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
export function acquire({ key, sessionId, signature, account, accountOk = null, args, spawnOptions, transcriptPath, mcpCleanup = null }) {
  let entry = pool.get(key);
  let warm = false;
  if (entry) {
    if (reusable(entry, { sessionId, signature, accountOk })) warm = true;
    else {
      const why = !entry.alive ? "processus mort" : entry.active ? "tour précédent encore actif" : entry.sessionId !== sessionId ? "nouvelle conversation" : entry.signature !== signature ? "périmètre ou consignes modifiés" : entry.turns >= MAX_TURNS ? `${MAX_TURNS} tours atteints` : Date.now() - entry.startedAt > MAX_AGE_MS ? "âge maximal atteint" : "compte Claude Max refusé";
      // An active handle (never, the per-conversation lock forbids it) would
      // learn the end from the process exit.
      entry.evict(why, { keepHandle: !!entry.active });
      entry = null;
    }
  }
  if (!entry) {
    if (pool.size >= MAX_PROCESSES) {
      const idle = [...pool.values()].filter((e) => !e.active).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!idle) { console.error(`[mo-session] ${key} : ${MAX_PROCESSES} processus occupés — tour en one-shot`); return null; }
      idle.evict("place libérée pour une autre conversation");
    }
    entry = new Entry({ key, sessionId, signature, account });
    entry.mcpCleanup = mcpCleanup;
    pool.set(key, entry);
    try {
      entry.start({ args: [...args, ...sessionArgsFor(sessionId, transcriptPath)], spawnOptions });
    } catch (err) {
      console.error(`[mo-session] ${key} : lancement impossible — ${err.message}`);
      entry.drop();
      return null;
    }
  } else {
    try { mcpCleanup?.(); } catch { /* best effort */ }
  }
  clearTimeout(entry.idleTimer);
  const handle = new TurnHandle(entry);
  handle.warm = warm;
  entry.active = handle;
  if (warm) {
    // A warm process that says nothing is stuck: the turn moves to a one-shot
    // process over the same handle, and the stuck one goes.
    handle.watchdog = setTimeout(() => {
      if (handle.ended || handle.sawEvent) return;
      console.error(`[mo-session] ${key} : processus muet après ${FIRST_EVENT_MS} ms — repli sur un processus neuf`);
      entry.evict("processus muet");
      runOneShot(handle, { key, args: [...args, ...sessionArgsFor(sessionId, transcriptPath)], spawnOptions });
    }, FIRST_EVENT_MS);
  }
  return { child: handle, warm, account: entry.account };
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
    console.log(`[mo-session] ${key} tour de repli terminé en ${Date.now() - handle.startedAt} ms (one-shot)`);
    handle.endTurn(code, signal);
  });
  proc.stdin.write(handle.input);
  proc.stdin.end();
}

/** For /health. */
export function snapshot() {
  return { processes: pool.size, busy: [...pool.values()].filter((e) => e.active).length, max: MAX_PROCESSES };
}

/** Kills every process (relay shutdown). */
export function evictAll(reason = "arrêt du relay") {
  for (const entry of [...pool.values()]) entry.evict(reason);
}
