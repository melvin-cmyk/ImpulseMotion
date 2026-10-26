/**
 * Server-side helpers for talking to the AI relay (server/relay.mjs).
 *
 * Every AI feature goes through the relay — never the Anthropic SDK directly.
 * Two shapes are needed by the app:
 *   - relayComplete(): one-shot, collects the streamed text into a string
 *     (reports, recommendations, creative analysis — data provided inline,
 *     usually with no MCP tools so it stays fast).
 *   - relayStream(): returns the relay's SSE body untouched for chat UIs.
 *
 * Both do a /health preflight per URL so a dead tunnel fails fast, and put the
 * timeout on the *headers* only: the streamed body is governed by the relay's
 * own session budget (it ends cleanly with error+done events).
 */

import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { parseUsageEvent, type RelayUsage } from "@/lib/ai-usage";

/** Image attached to a user message — base64 without the data: prefix. The
 *  relay hands it to the CLI as an image content block. */
export interface RelayImage { mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string; name?: string }

export interface RelayMessage { role: "user" | "assistant"; content: string; images?: RelayImage[] }

export interface RelayChatBody {
  messages: RelayMessage[];
  systemPrompt?: string;
  allowedServers?: string[];
  /** Accounts the relay may query. The relay pins these in the environment of
   *  scoped stdio MCP proxies; `unrestricted` (admins only) keeps direct
   *  business-manager access. An absent or empty list drops the server. */
  accountScope?: { meta?: string[]; google?: string[]; tiktok?: string[]; unrestricted?: boolean };
  /**
   * Périmètre données du bot client. `clientKey` scope le serveur MCP
   * "client-data" côté relay (le LLM ne choisit jamais le client_key) ;
   * `ga4PropertyId` est ajouté aux restrictions de périmètre du prompt.
   */
  dataScope?:
    | { clientKey: string; ga4PropertyId?: string; tools?: Array<"orders" | "datasets"> }
    // Staff chat: the warehouses of several clients (lib/staff-data-scope.ts);
    // the relay keeps HQ, Notion, Magento and the web for these.
    | { staff: true; clientKeys: string[]; tools?: Array<"orders" | "datasets"> };
  /** Session budget requested from the relay (ms). Capped server-side. */
  budgetMs?: number;
  /** Inference backend. "bedrock" = the agency's AWS account (EU region),
   *  reserved to the private client bots. Absent = the relay's default. */
  provider?: "bedrock";
  /** Client-bot restrictions (no HQ, no web) regardless of the backend. */
  clientBot?: boolean;
  /** Model alias resolved by the relay (see lib/ai-profiles.ts). Ignored on Bedrock. */
  model?: RelayModel;
  /** Preferred Claude Max account of the pool ("host" or an id from /api/relay/accounts);
   *  the relay falls back to the account with the most room, then Bedrock. */
  account?: string;
  /** "caller" = the system prompt already says how to use HQ: the relay
   *  leaves its own HQ block out. */
  hqGuidance?: "caller";
  /** Reasoning effort passed to the CLI — "low" spends the fewest thinking tokens. */
  effort?: RelayEffort;
  /** Cap on the agentic loop (1–15); short tool lookups should not run the default 15. */
  maxTurns?: number;
  /**
   * Names the conversation ("copilot:<dashboardId>:<userId>", "bot:<conversationId>"…).
   * The relay keeps one CLI session per key and resumes it with only the new
   * user message, so earlier turns and their tool results are a cached prefix
   * instead of being re-sent (and re-fetched) every turn. A single-message
   * thread restarts the session.
   */
  sessionKey?: string;
  /**
   * Design conversation (lib/design): the edit link of its FigCraft file. The
   * relay's "figcraft" MCP server joins that file so the model edits it live
   * with the consultant; the server is dropped without a link.
   */
  figcraft?: { link: string };
}

export type RelayModel = "sonnet" | "opus" | "fable";
export type RelayEffort = "low" | "medium" | "high";

interface RelayEvent { type: string; text?: string; message?: string }

async function openRelayStream(
  body: RelayChatBody,
  headersTimeoutMs: number,
): Promise<{ res: Response; url: string } | { error: string }> {
  let lastError = "relay unreachable";
  for (const url of RELAY_URLS) {
    try {
      const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
      if (!health.ok) { lastError = `relay health ${health.status}`; continue; }

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), headersTimeoutMs);
      let res: Response;
      try {
        res = await fetch(`${url}/api/chat`, {
          method: "POST",
          headers: relayHeaders(),
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok || !res.body) {
        lastError = `relay ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
        continue;
      }
      return { res, url };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { error: lastError };
}

/**
 * Wraps a relay SSE body: forwards every byte untouched and accumulates the
 * text deltas plus the relay's `usage` events — a running total after each
 * model call (`partial`), replaced by the final one — so a turn that is cut
 * (time budget, Stop, closed tab) is still billed for what it consumed.
 * `onFinish(text, sawDone, usage)` runs once when the stream ends (or is
 * cancelled). Chat routes use it
 * to persist the answer and to write the usage ledger.
 */
export function teeRelayStream(
  source: ReadableStream<Uint8Array>,
  onFinish: (text: string, sawDone: boolean, usage: RelayUsage | null) => Promise<void> | void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let sawDone = false;
  let usage: RelayUsage | null = null;
  let finished = false;

  const finish = async () => {
    if (finished) return;
    finished = true;
    try { await onFinish(text, sawDone, usage); } catch (e) { console.error("[relay] onFinish failed", e); }
  };

  const parseLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    let evt: { type?: string; text?: string };
    try { evt = JSON.parse(payload); } catch { return; }
    if (evt.type === "delta" && typeof evt.text === "string") text += evt.text;
    else if (evt.type === "content" && typeof evt.text === "string" && !text) text = evt.text;
    else if (evt.type === "done") sawDone = true;
    else if (evt.type === "usage") usage = parseUsageEvent(evt) ?? usage;
  };

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) parseLine(line);
      },
      async flush() {
        if (buffer) parseLine(buffer);
        await finish();
      },
      // The browser went away (Stop, closed tab): what was consumed so far
      // still goes to the ledger.
      async cancel() {
        await finish();
      },
    } as Transformer<Uint8Array, Uint8Array>),
  );
}

/** Streams a relay chat as-is (SSE passthrough) for chat routes. */
export async function relayStream(body: RelayChatBody): Promise<Response> {
  const opened = await openRelayStream(body, 15000);
  if ("error" in opened) {
    return Response.json({ error: `IA indisponible (${opened.error})` }, { status: 502 });
  }
  return new Response(opened.res.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * One-shot completion: collects the relay's text deltas into a string.
 * `maxMs` bounds the whole read (default 170 s) — pick it under the calling
 * route's maxDuration.
 */
export async function relayComplete(
  body: RelayChatBody,
  opts: { maxMs?: number; onUsage?: (usage: RelayUsage) => void } = {},
): Promise<string> {
  const maxMs = opts.maxMs ?? 170_000;
  const opened = await openRelayStream(
    { allowedServers: [], accountScope: {}, ...body, budgetMs: body.budgetMs ?? maxMs },
    15000,
  );
  if ("error" in opened) throw new Error(`Relay inaccessible — ${opened.error}`);

  const reader = opened.res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let lastError: string | null = null;
  // Running totals (`partial`) then the final one: only the last is recorded.
  let lastUsage: RelayUsage | null = null;
  const killer = setTimeout(() => reader.cancel().catch(() => undefined), maxMs);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        let evt: RelayEvent;
        try { evt = JSON.parse(payload) as RelayEvent; } catch { continue; }
        if (evt.type === "delta" && evt.text) fullText += evt.text;
        else if (evt.type === "content" && evt.text && !fullText) fullText = evt.text;
        else if (evt.type === "error" && evt.message) lastError = evt.message;
        else if (evt.type === "usage") lastUsage = parseUsageEvent(evt) ?? lastUsage;
      }
    }
  } finally {
    clearTimeout(killer);
    if (lastUsage && opts.onUsage) { try { opts.onUsage(lastUsage); } catch { /* ledger is best effort */ } }
  }

  const result = fullText.trim();
  if (result) return result;
  throw new Error(lastError ? `Relay: ${lastError}` : "Réponse vide du relay");
}

/** Extracts the first fenced block tagged `lang` (```lang ... ```). */
export function extractFence(text: string, lang: string): { inner: string; rest: string } | null {
  const re = new RegExp("```" + lang + "[ \\t]*\\r?\\n([\\s\\S]*?)```", "i");
  const m = text.match(re);
  if (!m) return null;
  return { inner: m[1], rest: (text.slice(0, m.index) + text.slice((m.index ?? 0) + m[0].length)).trim() };
}

/** Lenient JSON extraction: tolerates prose around a single object/array. */
export function parseLooseJson<T>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(cleaned) as T; } catch { /* fall through */ }
  const start = Math.min(
    ...["{", "["].map((c) => cleaned.indexOf(c)).filter((i) => i >= 0),
  );
  if (!Number.isFinite(start)) return null;
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)) as T; } catch { return null; }
}

// ── Detached turns (relay jobs) ─────────────────────────────────────────────
// A turn started with `detach: true` runs in the relay whatever the browser
// does; the app reads it back by job id (lib/ai-jobs.ts).

export interface RelayJobState {
  id: string;
  status: "running" | "done" | "stopped";
  createdAt: number;
  finishedAt: number | null;
  seq: number;
  text: string;
  sawDone: boolean;
  usage: unknown;
  toolCalls: Array<{ name: string; id: string }>;
  error: string | null;
  resumable: boolean;
}

async function relayJson<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ ok: true; status: number; json: T } | { ok: false; status: number; error: string }> {
  let lastError = "relay unreachable";
  let lastStatus = 502;
  for (const url of RELAY_URLS) {
    const isLocalhost = url.includes("localhost");
    try {
      const res = await fetch(`${url}${path}`, {
        ...init,
        headers: relayHeaders(),
        signal: AbortSignal.timeout(isLocalhost ? Math.min(init.timeoutMs ?? 15000, 3000) : init.timeoutMs ?? 15000),
      });
      const json = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (res.ok) return { ok: true, status: res.status, json };
      // The relay answered: a 404 (job unknown) is an answer, not an outage.
      if (res.status === 404 || res.status === 400) return { ok: false, status: res.status, error: json.error ?? `relay ${res.status}` };
      lastStatus = res.status;
      lastError = json.error ?? `relay ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, status: lastStatus, error: lastError };
}

/** Starts a detached turn; the relay answers its job id at once. */
export async function relayDetach(body: RelayChatBody, jobMeta?: Record<string, unknown>): Promise<{ jobId: string } | { error: string }> {
  const r = await relayJson<{ jobId?: string }>("/api/chat", {
    method: "POST",
    body: JSON.stringify({ ...body, detach: true, ...(jobMeta ? { jobMeta } : {}) }),
    timeoutMs: 20000,
  });
  if (!r.ok) return { error: `IA indisponible (${r.error})` };
  return typeof r.json.jobId === "string" && /^[a-f0-9]{32}$/.test(r.json.jobId) ? { jobId: r.json.jobId } : { error: "IA indisponible (réponse du relay sans identifiant)" };
}

/** The relay's summary of a job; `missing` when the relay no longer knows it (restart, TTL). */
export async function relayJobState(jobId: string): Promise<{ state: RelayJobState } | { missing: true } | { error: string }> {
  const r = await relayJson<{ job?: RelayJobState }>(`/api/jobs/${jobId}/state`, { method: "GET", timeoutMs: 10000 });
  if (r.ok) return r.json.job ? { state: r.json.job } : { error: "réponse du relay sans état" };
  return r.status === 404 ? { missing: true } : { error: r.error };
}

export async function relayJobStop(jobId: string): Promise<{ stopped: boolean; status?: string } | { missing: true } | { error: string }> {
  const r = await relayJson<{ stopped?: boolean; status?: string }>(`/api/jobs/${jobId}/stop`, { method: "POST", timeoutMs: 10000 });
  if (r.ok) return { stopped: r.json.stopped === true, status: r.json.status };
  return r.status === 404 ? { missing: true } : { error: r.error };
}

/**
 * The job's SSE (replay past `after`, then live), as the relay sends it, or
 * null when the relay does not know the job. The body ends when the job does.
 */
export async function relayJobEvents(jobId: string, after: number): Promise<Response | null> {
  for (const url of RELAY_URLS) {
    const isLocalhost = url.includes("localhost");
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), isLocalhost ? 3000 : 15000);
      let res: Response;
      try {
        res = await fetch(`${url}/api/jobs/${jobId}?after=${Math.max(0, Math.floor(after))}`, { headers: relayHeaders(), signal: ctl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 404) return null;
      if (!res.ok || !res.body) continue;
      return res;
    } catch { /* next url */ }
  }
  throw new Error("relay unreachable");
}
