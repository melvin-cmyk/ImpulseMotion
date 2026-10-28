/**
 * Mo's measures (spec §6), the pure parts: was a turn understood (the person
 * says the same thing again within 60 s, says « non / pas ça », removes the
 * card), the percentiles of the time to the first card, the summary by path
 * shown on /admin/usage. Client-safe; the rows come from the MoTurn table.
 */

import { fold } from "@/lib/mo/intents";

export type MoTurnPath = "nav" | "quick" | "act" | "model" | "ask";
export const MO_TURN_PATHS: readonly MoTurnPath[] = ["nav", "quick", "act", "model", "ask"];

/** Within this delay, saying the same thing again means Mo had not understood. */
export const REFORMULATION_MS = 60_000;
/** Removing the card Mo just produced within this delay means it was not what was wanted. */
export const CARD_REMOVED_MS = 30_000;
export const SIMILARITY_THRESHOLD = 0.6;

const STOP = new Set(["le", "la", "les", "de", "du", "des", "un", "une", "et", "a", "au", "aux", "en", "sur", "pour", "moi", "me", "m", "mo", "hello", "salut", "stp", "s", "il", "te", "plait", "ca", "ce", "cette", "ces", "mes", "ma", "mon"]);
const tokens = (s: string) => new Set(fold(s).split(" ").filter((w) => w && !STOP.has(w)));

/** Jaccard similarity of the meaningful words of two sentences (0..1), after `fold`. */
export function foldSimilarity(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return fold(a) === fold(b) && fold(a) ? 1 : 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const NEGATION = /^(non|nan|nope|pas ca|pas celle (la|ci)|pas celui (la|ci)|pas du tout|mais non|c est pas ca|ce n est pas ca|non pas ca|non non)\b|\b(je voulais|je parlais de|je te demandais|j ai dit|pas ce que je|tu n as pas compris|t as pas compris|tu as mal compris|rien a voir|je ne t ai pas demande|c est pas ce que)\b/;

/** « Non », « pas ça », « je voulais… » : the person corrects Mo. */
export function isNegation(text: string): boolean {
  const t = fold(text);
  return !!t && NEGATION.test(t);
}

/**
 * Why the previous turn counts as misunderstood when this sentence arrives,
 * or null: a correction, or the same intent said again within 60 s.
 */
export function misunderstoodBy(prev: { text: string; at: number } | null, next: { text: string; at: number }): "negation" | "reformulation" | null {
  if (isNegation(next.text)) return prev ? "negation" : null;
  if (!prev) return null;
  if (next.at - prev.at > REFORMULATION_MS || next.at < prev.at) return null;
  return foldSimilarity(prev.text, next.text) > SIMILARITY_THRESHOLD ? "reformulation" : null;
}

/** The card produced by the last turn removed within 30 s: not what was wanted. */
export function cardRemovedTooSoon(turn: { at: number; cardIds: string[] } | null, cardId: string, now: number): boolean {
  return !!turn && turn.cardIds.includes(cardId) && now - turn.at <= CARD_REMOVED_MS;
}

/** The p-th percentile (0..100) of a list, nearest rank; null when empty. */
export function percentile(values: number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[rank];
}

export interface MoTurnRow { userId: string; path: string; kind?: string | null; firstCardMs: number | null; totalMs: number; clarified: boolean; retried: boolean; misunderstood: boolean; at: Date | string }

export interface MoPathStats { path: MoTurnPath; turns: number; p50FirstCardMs: number | null; p90FirstCardMs: number | null; p50TotalMs: number | null; misunderstood: number }
export interface MoActionsByDay { day: string; userId: string; actions: number; kinds: Record<string, number> }
export interface MoTurnSummary {
  turns: number;
  byPath: MoPathStats[];
  /** Share of the turns resolved without the model (nav + quick + act, and asks answered with a chip). */
  withoutModelPct: number | null;
  misunderstoodPct: number | null;
  /** Asks abandoned (no chip clicked): counted misunderstood. */
  asksAbandoned: number;
  actionsByDay: MoActionsByDay[];
}

/** « Work done » : what counts as an action of the consultant (verdicts, publications, files, visuals generated, comparisons…). */
const WORK_KINDS = new Set(["verdict", "publish_prepare", "publish_confirm", "upload", "drive", "open_editor", "generate_creatives", "more_like_this", "keep_template"]);

export function summarizeMoTurns(rows: MoTurnRow[]): MoTurnSummary {
  const byPath: MoPathStats[] = MO_TURN_PATHS.map((path) => {
    const list = rows.filter((r) => r.path === path);
    const first = list.map((r) => r.firstCardMs ?? (path === "quick" || path === "act" ? r.totalMs : NaN)).filter((v) => Number.isFinite(v) && v > 0);
    return { path, turns: list.length, p50FirstCardMs: percentile(first, 50), p90FirstCardMs: percentile(first, 90), p50TotalMs: percentile(list.map((r) => r.totalMs).filter((v) => v > 0), 50), misunderstood: list.filter((r) => r.misunderstood).length };
  });
  const asks = rows.filter((r) => r.path === "ask");
  const asksAbandoned = asks.filter((r) => !r.clarified).length;
  const requests = rows.filter((r) => r.path !== "ask");
  const direct = requests.filter((r) => r.path === "nav" || r.path === "quick" || r.path === "act").length;
  const misunderstood = rows.filter((r) => r.misunderstood).length + asks.filter((r) => !r.clarified && !r.misunderstood).length;
  const days = new Map<string, MoActionsByDay>();
  for (const r of rows) {
    if (!(r.path === "act" || (r.path === "quick" && r.kind && WORK_KINDS.has(r.kind)))) continue;
    if (r.path === "act" && r.kind && !WORK_KINDS.has(r.kind)) continue;
    const day = (typeof r.at === "string" ? r.at : r.at.toISOString()).slice(0, 10);
    const key = `${day}|${r.userId}`;
    const e = days.get(key) ?? { day, userId: r.userId, actions: 0, kinds: {} };
    e.actions += 1;
    const k = r.kind ?? r.path;
    e.kinds[k] = (e.kinds[k] ?? 0) + 1;
    days.set(key, e);
  }
  return {
    turns: rows.length,
    byPath,
    withoutModelPct: requests.length ? Math.round((direct / requests.length) * 100) : null,
    misunderstoodPct: rows.length ? Math.round((misunderstood / rows.length) * 1000) / 10 : null,
    asksAbandoned,
    actionsByDay: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0) || a.userId.localeCompare(b.userId)),
  };
}
