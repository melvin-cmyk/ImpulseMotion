/**
 * What a detached AI turn (relay job) produced, rebuilt from its SSE events —
 * the same reading on both paths that end a job in the app: the stream a
 * browser followed through /api/ai/jobs/[id]/events, and the relay's
 * completion webhook (which sends the relay's own summary, same shape).
 */

import { parseUsageEvent, type RelayUsage } from "@/lib/ai-usage";

export interface AiJobSummary {
  text: string;
  sawDone: boolean;
  usage: RelayUsage | null;
  toolCalls: Array<{ name: string; id: string }>;
  error: string | null;
  /** The turn was cut by the time budget; its session can be resumed. */
  resumable: boolean;
}

export function emptySummary(): AiJobSummary {
  return { text: "", sawDone: false, usage: null, toolCalls: [], error: null, resumable: false };
}

/** Folds the SSE events of a job into a summary; feed it line by line or event by event. */
export class AiJobSummarizer {
  private summary = emptySummary();
  private sawDelta = false;
  private partialUsage: RelayUsage | null = null;
  private finalUsage: RelayUsage | null = null;

  line(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    let evt: unknown;
    try { evt = JSON.parse(payload); } catch { return; }
    this.event(evt);
  }

  event(evt: unknown): void {
    if (!evt || typeof evt !== "object") return;
    const e = evt as Record<string, unknown>;
    switch (e.type) {
      case "delta":
        if (typeof e.text === "string") { this.summary.text += e.text; this.sawDelta = true; }
        break;
      case "content":
        if (typeof e.text === "string" && !this.sawDelta && !this.summary.text) this.summary.text = e.text;
        break;
      case "tool_call":
        if (this.summary.toolCalls.length < 500) this.summary.toolCalls.push({ name: String(e.name ?? ""), id: String(e.id ?? "") });
        break;
      case "usage": {
        const u = parseUsageEvent(e);
        if (!u) break;
        if (e.partial) this.partialUsage = u; else this.finalUsage = u;
        break;
      }
      case "error":
        this.summary.error = String(e.message ?? "Erreur");
        if (e.resumable === true) this.summary.resumable = true;
        break;
      case "done":
        this.summary.sawDone = true;
        break;
      default:
        break;
    }
  }

  result(): AiJobSummary {
    return { ...this.summary, toolCalls: [...this.summary.toolCalls], usage: this.finalUsage ?? this.partialUsage };
  }
}

/** The relay's own summary (GET /api/jobs/:id/state, completion webhook) → the app's. */
export function summaryFromRelayState(state: unknown): AiJobSummary {
  const s = (state && typeof state === "object" ? state : {}) as Record<string, unknown>;
  const toolCalls = Array.isArray(s.toolCalls)
    ? s.toolCalls.filter((t): t is Record<string, unknown> => !!t && typeof t === "object").slice(0, 500).map((t) => ({ name: String(t.name ?? ""), id: String(t.id ?? "") }))
    : [];
  return {
    text: typeof s.text === "string" ? s.text : "",
    sawDone: s.sawDone === true,
    usage: parseUsageEvent(s.usage),
    toolCalls,
    error: typeof s.error === "string" && s.error ? s.error : null,
    resumable: s.resumable === true,
  };
}

const TRUNCATED_NOTE = "\n\n_(réponse possiblement tronquée)_";

/** The assistant text to store: nothing usable → null (the turn is recorded as failed). */
export function answerText(summary: AiJobSummary, status: "done" | "stopped" | "failed"): string | null {
  const text = summary.text.trim();
  if (!text) return null;
  if (status === "stopped") return `${text}\n\n_(réponse arrêtée)_`;
  if (summary.resumable) return `${text}\n\n_(réponse interrompue par la limite de temps — écrivez « continue » pour la poursuivre)_`;
  return summary.sawDone && !summary.error ? text : text + TRUNCATED_NOTE;
}
