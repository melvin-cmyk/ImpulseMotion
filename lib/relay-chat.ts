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

export interface RelayMessage { role: "user" | "assistant"; content: string }

export interface RelayChatBody {
  messages: RelayMessage[];
  systemPrompt?: string;
  allowedServers?: string[];
  accountScope?: { meta?: string[]; google?: string[]; tiktok?: string[] };
  /** Session budget requested from the relay (ms). Capped server-side. */
  budgetMs?: number;
}

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
  opts: { maxMs?: number } = {},
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
      }
    }
  } finally {
    clearTimeout(killer);
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
