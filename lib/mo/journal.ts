/**
 * The journal of a consultant's day in Mo (pure, client-safe): what Mo did,
 * across every page — the « action » lines (verdicts, publications, files…)
 * and the turns that put cards on a board. Read by GET /api/mo/journal?day=.
 */

import type { MoActionKind, MoCard, MoMessage } from "@/lib/mo/model";

export type JournalKind = MoActionKind | "cards";

export interface JournalEntry {
  /** `<boardId>:<index>` — stable within a day. */
  id: string;
  at: string;
  kind: JournalKind;
  label: string;
  boardId: string;
  boardTitle: string;
  boardKind: "home" | "client" | "free";
  clientId: string | null;
  clientName: string | null;
  cardIds: string[];
}

export interface JournalBoard {
  id: string;
  title: string;
  kind: "home" | "client" | "free";
  clientId: string | null;
  cards: MoCard[];
  messages: MoMessage[];
}

export interface DayRange { start: string; end: string }

/** The [start, end) ISO range of a calendar day (YYYY-MM-DD) in a timezone given by its offset in minutes (as `Date.getTimezoneOffset()` returns it). */
export function dayRange(day: string, offsetMinutes = 0): DayRange | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const off = Number.isFinite(offsetMinutes) ? Math.max(-840, Math.min(840, Math.round(offsetMinutes))) : 0;
  const startMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + off * 60_000;
  if (!Number.isFinite(startMs)) return null;
  return { start: new Date(startMs).toISOString(), end: new Date(startMs + 86_400_000).toISOString() };
}

/** Today's YYYY-MM-DD in the browser's timezone. */
export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const MAX_LABEL = 120;
const shorten = (s: string) => (s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1).trimEnd() + "…" : s);

/**
 * The entries of the day across boards, newest first. An action line is one
 * entry; an assistant turn with cards is one entry labelled with what Mo said
 * (or the first card's title). The client comes from the action, else from
 * the cards, else from the board when it is a client page.
 */
export function journalForDay(boards: JournalBoard[], range: DayRange, clientNames: Map<string, string> = new Map()): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const b of boards) {
    const cardById = new Map(b.cards.map((c) => [c.id, c]));
    b.messages.forEach((m, i) => {
      if (m.at < range.start || m.at >= range.end) return;
      let entry: Omit<JournalEntry, "id" | "boardId" | "boardTitle" | "boardKind"> | null = null;
      if (m.role === "action" && m.action) {
        const cards = m.action.cardIds.map((id) => cardById.get(id)).filter((c): c is MoCard => !!c);
        const clientId = m.action.clientId ?? cards.find((c) => c.clientId)?.clientId ?? b.clientId;
        entry = { at: m.at, kind: m.action.kind, label: shorten(m.action.label || m.content), clientId: clientId ?? null, clientName: nameOf(clientId, cards, clientNames), cardIds: m.action.cardIds };
      } else if (m.role === "assistant" && m.cardIds?.length) {
        const cards = m.cardIds.map((id) => cardById.get(id)).filter((c): c is MoCard => !!c && c.type !== "frame");
        const clientId = cards.find((c) => c.clientId)?.clientId ?? b.clientId;
        const label = (m.say ?? "").trim() || cards[0]?.title || `${m.cardIds.length} carte${m.cardIds.length > 1 ? "s" : ""}`;
        entry = { at: m.at, kind: "cards", label: shorten(label), clientId: clientId ?? null, clientName: nameOf(clientId, cards, clientNames), cardIds: m.cardIds };
      }
      if (entry) out.push({ id: `${b.id}:${i}`, boardId: b.id, boardTitle: b.title, boardKind: b.kind, ...entry });
    });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

function nameOf(clientId: string | null | undefined, cards: MoCard[], names: Map<string, string>): string | null {
  if (!clientId) return null;
  return names.get(clientId) ?? cards.find((c) => c.clientId === clientId && c.clientName)?.clientName ?? null;
}
