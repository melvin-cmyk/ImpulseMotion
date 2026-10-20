/**
 * Detached chat turns ("jobs") of the relay.
 *
 * A chat started with `detach: true` is not tied to the HTTP response that
 * asked for it: the CLI writes its SSE events into a per-job log kept here,
 * and the caller gets a job id at once. Any number of readers can then replay
 * the log from a sequence number and follow it live (`subscribe`), leave, and
 * come back — closing a reader never stops the CLI. The app persists the
 * answer when the job ends, from the completion webhook (`notifyFinished`) or
 * from its own reader of the stream (both idempotent on its side).
 *
 * The sink handed to the chat code imitates the `http.ServerResponse` it
 * writes to: `write`, `end`, `on("close")`, `headersSent`, `writableEnded`.
 * `stop()` plays the client disconnect (the chat code kills the CLI on it).
 *
 * Memory: the log keeps every `data:` line (tool results trimmed), capped per
 * job; finished jobs stay JOB_TTL_MS so a late reader still finds them.
 */

import crypto from "node:crypto";

const JOB_TTL_MS = Number(process.env.RELAY_JOB_TTL_MS || 2 * 3600 * 1000);
const RUNNING_MAX_MS = Number(process.env.RELAY_JOB_RUNNING_MAX_MS || 60 * 60 * 1000);
const LOG_MAX_BYTES = 6 * 1024 * 1024;
const TOOL_RESULT_MAX_CHARS = 4000;
const JOB_ID_RE = /^[a-f0-9]{32}$/;
const MAX_JOBS = 500;

/** @type {Map<string, Job>} */
const jobs = new Map();

export function isJobId(id) {
  return typeof id === "string" && JOB_ID_RE.test(id);
}

/** Trims what would bloat the log without changing what the readers need. */
function compactEvent(event) {
  if (event.type === "tool_result" && typeof event.content === "string" && event.content.length > TOOL_RESULT_MAX_CHARS) {
    return { ...event, content: event.content.slice(0, TOOL_RESULT_MAX_CHARS) + "… [tronqué]" };
  }
  if (event.type === "tool_call" && event.input && JSON.stringify(event.input).length > TOOL_RESULT_MAX_CHARS) {
    return { ...event, input: { _truncated: true } };
  }
  return event;
}

class Job {
  constructor({ meta }) {
    this.id = crypto.randomBytes(16).toString("hex");
    this.meta = meta ?? {};
    this.createdAt = Date.now();
    this.finishedAt = null;
    this.status = "running"; // running | done | stopped
    /** @type {Array<{seq:number, line:string}>} */
    this.events = [];
    this.bytes = 0;
    this.dropped = 0;
    this.seq = 0;
    this.listeners = new Set();
    this.closeHandlers = [];
    this.stopRequested = false;
    // What the readers rebuild; kept here too so `state()` is O(1).
    this.text = "";
    this.sawDelta = false;
    this.sawDone = false;
    this.usage = null;
    this.partialUsage = null;
    this.toolCalls = [];
    this.error = null;
    this.resumable = false;
    this.buffer = "";
    this.sink = this.makeSink();
  }

  makeSink() {
    const job = this;
    return {
      headersSent: true,
      writableEnded: false,
      flushHeaders() {},
      writeHead() {},
      write(chunk) {
        if (this.writableEnded) return false;
        job.ingest(String(chunk));
        return true;
      },
      end(chunk) {
        if (this.writableEnded) return;
        if (chunk) job.ingest(String(chunk));
        this.writableEnded = true;
        job.finish();
      },
      on(event, fn) {
        if (event === "close") job.closeHandlers.push(fn);
        return this;
      },
      once(event, fn) { return this.on(event, fn); },
      destroy() { this.end(); },
    };
  }

  ingest(text) {
    this.buffer += text;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue; // comments, blank separators
      let event;
      try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (!event || typeof event !== "object") continue;
      this.record(compactEvent(event));
    }
  }

  record(event) {
    switch (event.type) {
      case "delta":
        if (typeof event.text === "string") { this.text += event.text; this.sawDelta = true; }
        break;
      case "content":
        if (typeof event.text === "string" && !this.sawDelta && !this.text) this.text = event.text;
        break;
      case "tool_call":
        if (this.toolCalls.length < 500) this.toolCalls.push({ name: String(event.name ?? ""), id: String(event.id ?? "") });
        break;
      case "usage":
        if (event.partial) this.partialUsage = event; else this.usage = event;
        break;
      case "error":
        this.error = String(event.message ?? "Erreur");
        if (event.resumable) this.resumable = true;
        break;
      case "done":
        this.sawDone = true;
        break;
      default:
        break;
    }
    const seq = ++this.seq;
    const line = JSON.stringify({ ...event, seq });
    this.bytes += line.length;
    this.events.push({ seq, line });
    // Oldest entries go first when the log outgrows its cap: a reader that
    // comes late sees the tail; the text and usage above are kept whole.
    while (this.bytes > LOG_MAX_BYTES && this.events.length > 1) {
      const gone = this.events.shift();
      this.bytes -= gone.line.length;
      this.dropped++;
    }
    for (const fn of this.listeners) {
      try { fn(seq, line); } catch { /* reader gone */ }
    }
  }

  finish() {
    if (this.status !== "running") return;
    this.finishedAt = Date.now();
    this.status = this.stopRequested ? "stopped" : "done";
    for (const fn of this.listeners) {
      try { fn(null, null); } catch { /* reader gone */ }
    }
    this.listeners.clear();
    this.onFinished?.(this);
  }

  /** Plays the client disconnect for the chat code (which kills the CLI). */
  stop() {
    if (this.status !== "running") return false;
    this.stopRequested = true;
    const handlers = this.closeHandlers.splice(0);
    for (const fn of handlers) {
      try { fn(); } catch (e) { console.error(`[jobs] ${this.id} close handler failed`, e?.message || e); }
    }
    // A chat that had not registered its handler yet (still starting) ends
    // here; the one that did ends its sink itself once the CLI is gone.
    if (!handlers.length) this.sink.end();
    return true;
  }

  state() {
    return {
      id: this.id,
      status: this.status,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
      seq: this.seq,
      text: this.text,
      sawDone: this.sawDone,
      usage: this.usage ?? this.partialUsage,
      usageIsPartial: !this.usage && !!this.partialUsage,
      toolCalls: this.toolCalls,
      error: this.error,
      resumable: this.resumable,
      meta: this.meta,
    };
  }

  /**
   * Replays the log after `after`, then follows it live. `onLine(seq, line)`
   * for each event, `onLine(null, null)` once the job is over. Returns an
   * unsubscribe function.
   */
  subscribe(after, onLine) {
    const from = Number.isFinite(after) && after > 0 ? after : 0;
    for (const e of this.events) if (e.seq > from) onLine(e.seq, e.line);
    if (this.status !== "running") { onLine(null, null); return () => {}; }
    this.listeners.add(onLine);
    return () => { this.listeners.delete(onLine); };
  }
}

export function createJob({ meta, onFinished } = {}) {
  sweep();
  const job = new Job({ meta });
  job.onFinished = onFinished;
  jobs.set(job.id, job);
  return job;
}

export function getJob(id) {
  return isJobId(id) ? jobs.get(id) ?? null : null;
}

/** Jobs still running (for /health and the stop-before-restart check). */
export function runningJobs() {
  return [...jobs.values()].filter((j) => j.status === "running");
}

/** Drops finished jobs past their TTL, stops the ones that ran for too long. */
export function sweep(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (job.status === "running") {
      if (now - job.createdAt > RUNNING_MAX_MS) { console.error(`[jobs] ${id} : arrêt après ${Math.round((now - job.createdAt) / 60000)} min`); job.stop(); }
      continue;
    }
    if (now - (job.finishedAt ?? job.createdAt) > JOB_TTL_MS) jobs.delete(id);
  }
  // Hard cap, oldest finished first.
  if (jobs.size > MAX_JOBS) {
    const finished = [...jobs.values()].filter((j) => j.status !== "running").sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const j of finished.slice(0, jobs.size - MAX_JOBS)) jobs.delete(j.id);
  }
}

/** Test hook. */
export function _reset() { jobs.clear(); }

/**
 * Tells the app a job is over: POST { job state } to RELAY_APP_URL +
 * /api/ai/jobs/complete, bearer = the shared secret. Three tries, then the
 * app's own reconciliation (its readers, its polling) takes over.
 */
export function makeFinishedNotifier({ appUrl, secret, fetchImpl = fetch, delaysMs = [0, 5000, 30000] }) {
  const base = (appUrl || "").replace(/\/+$/, "");
  if (!base || !secret) return null;
  return async (job) => {
    const body = JSON.stringify({ job: job.state() });
    for (let i = 0; i < delaysMs.length; i++) {
      if (delaysMs[i]) await new Promise((r) => setTimeout(r, delaysMs[i]));
      try {
        const res = await fetchImpl(`${base}/api/ai/jobs/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
          body,
          signal: AbortSignal.timeout(20000),
        });
        if (res.ok) return true;
        // The app does not know the job (or refused it): retrying will not help.
        if (res.status === 404 || res.status === 401 || res.status === 403) {
          console.error(`[jobs] ${job.id} : fin signalée, app ${res.status}`);
          return false;
        }
        console.error(`[jobs] ${job.id} : fin signalée, app ${res.status} (essai ${i + 1})`);
      } catch (e) {
        console.error(`[jobs] ${job.id} : fin non signalée (essai ${i + 1}) : ${e?.message || e}`);
      }
    }
    return false;
  };
}
