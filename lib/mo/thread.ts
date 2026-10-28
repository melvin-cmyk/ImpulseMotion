/**
 * Storage of a Mo board (MoBoard row): cards and messages as JSON, parsing
 * with caps, appends. Server only.
 */

import { prisma } from "@/lib/prisma";
import { applyCardUpdates, boardTitleFrom, layoutNewCards, modelHistory, parseMoAnswer, parseMoEntries, newCardId, CARD_SIZES, MO_MAX_CARDS, MO_MAX_MESSAGES, type MoActionMeta, type MoBoardData, type MoCard, type MoCardPatch, type MoCardSpec, type MoChatMessage, type MoMessage } from "@/lib/mo/model";
import { MAX_SIZE, MIN_SIZES } from "@/lib/mo/geometry";

export const BOARD_ID_RE = /^[a-z0-9]{10,40}$/i;

export function parseMoCards(json: string | null | undefined): MoCard[] {
  if (!json) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is MoCard => !!c && typeof c === "object" && typeof (c as MoCard).id === "string" && typeof (c as MoCard).type === "string").slice(-MO_MAX_CARDS);
}

/**
 * What the model may read of the thread: what was said and what Mo answered.
 * The journal's « action » lines (verdicts, publications, files — lib/mo/act.ts)
 * are left out here; `parseMoEntries` (lib/mo/model.ts) reads everything.
 */
export function parseMoMessages(json: string | null | undefined): MoChatMessage[] {
  return modelHistory(parseMoEntries(json));
}

export { parseMoEntries };

export function toBoardData(row: { id: string; title: string; cardsJson: string; messagesJson: string; updatedAt: Date }): MoBoardData {
  return { id: row.id, title: row.title, cards: parseMoCards(row.cardsJson), messages: parseMoEntries(row.messagesJson), updatedAt: row.updatedAt.toISOString() };
}

export async function loadBoard(id: string, userId: string) {
  if (!BOARD_ID_RE.test(id)) return null;
  return prisma.moBoard.findFirst({ where: { id, userId } });
}

export async function appendMoUserMessage(boardId: string, content: string, at: string): Promise<void> {
  const row = await prisma.moBoard.findUnique({ where: { id: boardId }, select: { messagesJson: true, title: true } });
  if (!row) return;
  const all: MoMessage[] = [...parseMoEntries(row.messagesJson), { role: "user" as const, content, at }];
  await prisma.moBoard.update({ where: { id: boardId }, data: { messagesJson: JSON.stringify(all.slice(-MO_MAX_MESSAGES)), ...(row.title ? {} : { title: boardTitleFrom(all) }) } });
}

/** Ends a turn: parses the answer, rewrites / removes the cards it names, lays the new ones on the board, stores the message with what to say. */
export async function appendMoAnswer(boardId: string, text: string, at: string): Promise<{ say: string; cardIds: string[]; open?: string } | null> {
  const row = await prisma.moBoard.findUnique({ where: { id: boardId }, select: { cardsJson: true, messagesJson: true } });
  if (!row) return null;
  const messages = parseMoEntries(row.messagesJson);
  const answer = parseMoAnswer(text);
  const turn = messages.filter((m) => m.role === "assistant").length;
  const updated = applyCardUpdates(parseMoCards(row.cardsJson), answer, turn, at);
  const cards = updated.cards;
  // A question from Mo lands as an « ask » card (its chips send the answer); what is said is the question.
  const specs: MoCardSpec[] = answer.ask ? [...answer.cards, { type: "ask", title: "Mo te demande", question: answer.ask.question, options: answer.ask.options }] : answer.cards;
  const placed = layoutNewCards(cards, { ...answer, cards: specs }, turn, at);
  // The cards the person should look at: the ones the tools posted during this turn, the rewritten ones, the new ones (a removed id is not on the board any more).
  const postedByTools = cards.filter((c) => c.turn === turn && !messages.some((m) => m.cardIds?.includes(c.id))).map((c) => c.id);
  const cardIds = [...new Set([...postedByTools, ...updated.touched.filter((id) => cards.some((c) => c.id === id)), ...placed.map((c) => c.id)])];
  const all = [...cards, ...placed].slice(-MO_MAX_CARDS);
  const msgs: MoMessage[] = [...messages, { role: "assistant" as const, content: text, at, say: answer.say, cardIds, ...(answer.open ? { open: answer.open } : {}) }].slice(-MO_MAX_MESSAGES);
  await prisma.moBoard.update({ where: { id: boardId }, data: { cardsJson: JSON.stringify(all), messagesJson: JSON.stringify(msgs) } });
  return { say: answer.say, cardIds, ...(answer.open ? { open: answer.open } : {}) };
}

/** The « Mo partout » board of a consultant (the orb on every page): one per user, created on first use. */
export async function getOrCreateDockBoard(userId: string) {
  const existing = await prisma.moBoard.findFirst({ where: { userId, dock: true }, orderBy: { updatedAt: "desc" } });
  if (existing) return existing;
  return prisma.moBoard.create({ data: { userId, dock: true, title: "Mo partout" } });
}

/** Geometry only: the consultant moved, resized, folded or removed cards. */
export async function updateMoCards(boardId: string, patch: Array<MoCardPatch & { id: string }>): Promise<MoCard[]> {
  const row = await prisma.moBoard.findUnique({ where: { id: boardId }, select: { cardsJson: true } });
  if (!row) return [];
  const byId = new Map(patch.map((p) => [p.id, p]));
  const num = (v: unknown, fallback: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback);
  const cards = parseMoCards(row.cardsJson).flatMap((c): MoCard[] => {
    const p = byId.get(c.id);
    if (!p) return [c];
    if (p.removed) return [];
    const min = MIN_SIZES[c.type] ?? { w: 240, h: 120 };
    return [{ ...c, x: num(p.x, c.x, -50_000, 50_000), y: num(p.y, c.y, -50_000, 50_000), w: num(p.w, c.w, min.w, MAX_SIZE.w), h: num(p.h, c.h ?? 300, min.h, MAX_SIZE.h), ...(typeof p.z === "number" ? { z: num(p.z, c.z ?? 0, 0, 1_000_000_000) } : {}), ...(typeof p.minimized === "boolean" ? { minimized: p.minimized } : {}) } as MoCard];
  });
  await prisma.moBoard.update({ where: { id: boardId }, data: { cardsJson: JSON.stringify(cards) } });
  return cards;
}

/**
 * A tool of Mo puts cards on the board itself, while the turn is still running
 * (the model then only has the sentence to say). Laid out like a turn's cards,
 * marked with the turn in progress. Returns the ids.
 */
export async function postMoCards(boardId: string, specs: MoCardSpec[], at = new Date().toISOString()): Promise<string[]> {
  if (!specs.length) return [];
  const row = await prisma.moBoard.findUnique({ where: { id: boardId }, select: { cardsJson: true, messagesJson: true } });
  if (!row) return [];
  const cards = parseMoCards(row.cardsJson);
  const turn = parseMoEntries(row.messagesJson).filter((m) => m.role === "assistant").length;
  const placed = layoutNewCards(cards, { cards: specs }, turn, at);
  await prisma.moBoard.update({ where: { id: boardId }, data: { cardsJson: JSON.stringify([...cards, ...placed].slice(-MO_MAX_CARDS)) } });
  return placed.map((c) => c.id);
}

/**
 * A card put exactly where the person wants it (a dropped file, a publication
 * next to its visual): world coordinates given, default size of its type, on
 * top of the stack. Returns the card.
 */
export async function placeMoCard(boardId: string, spec: MoCardSpec, at: { x: number; y: number }, now = new Date().toISOString()): Promise<MoCard | null> {
  const row = await prisma.moBoard.findUnique({ where: { id: boardId }, select: { cardsJson: true, messagesJson: true } });
  if (!row) return null;
  const cards = parseMoCards(row.cardsJson);
  const turn = parseMoEntries(row.messagesJson).filter((m) => m.role === "assistant").length;
  const ids = new Set(cards.map((c) => c.id));
  let id = newCardId();
  while (ids.has(id)) id = newCardId();
  const size = CARD_SIZES[spec.type];
  const z = cards.reduce((m, c) => Math.max(m, c.z ?? 0), 0) + 1;
  const clamp = (v: number) => Math.min(50_000, Math.max(-50_000, Math.round(Number.isFinite(v) ? v : 0)));
  const { ref, ...rest } = spec;
  const card = { ...rest, ...(ref && ids.has(ref) ? { ref } : {}), id, x: clamp(at.x), y: clamp(at.y), w: size.w, h: size.h, z, turn, at: now } as MoCard;
  await prisma.moBoard.update({ where: { id: boardId }, data: { cardsJson: JSON.stringify([...cards, card].slice(-MO_MAX_CARDS)) } });
  return card;
}

/** Rewrites one card of the board in place (same id, place and size): the function returns the new card, or null to leave it. */
export async function rewriteMoCard(boardId: string, cardId: string, fn: (card: MoCard) => MoCard | null): Promise<MoCard | null> {
  const row = await prisma.moBoard.findUnique({ where: { id: boardId }, select: { cardsJson: true } });
  if (!row) return null;
  let out: MoCard | null = null;
  const cards = parseMoCards(row.cardsJson).map((c) => {
    if (c.id !== cardId) return c;
    const next = fn(c);
    if (!next) return c;
    out = { ...next, id: c.id, x: c.x, y: c.y, w: c.w, ...(c.h ? { h: c.h } : {}), ...(c.z !== undefined ? { z: c.z } : {}) } as MoCard;
    return out;
  });
  if (out) await prisma.moBoard.update({ where: { id: boardId }, data: { cardsJson: JSON.stringify(cards) } });
  return out;
}

/** A line of the journal: what the consultant did on the board without the model (never shown to the model). */
export async function appendMoAction(boardId: string, action: Omit<MoActionMeta, "at"> & { at?: string }, content?: string): Promise<void> {
  const row = await prisma.moBoard.findUnique({ where: { id: boardId }, select: { messagesJson: true } });
  if (!row) return;
  const at = action.at ?? new Date().toISOString();
  const all: MoMessage[] = [...parseMoEntries(row.messagesJson), { role: "action", content: content ?? action.label, at, action: { ...action, at } }];
  await prisma.moBoard.update({ where: { id: boardId }, data: { messagesJson: JSON.stringify(all.slice(-MO_MAX_MESSAGES)) } });
}

/**
 * Metrics put under visuals already on the board: every creatives card holding
 * one of these adIds / assetIds gets its items' metrics replaced (names and
 * pictures kept). Returns the ids of the cards touched.
 */
export async function mergeCreativeMetrics(boardId: string, metrics: Map<string, Record<string, string>>, subtitle?: string): Promise<string[]> {
  const row = await prisma.moBoard.findUnique({ where: { id: boardId }, select: { cardsJson: true } });
  if (!row) return [];
  const touched: string[] = [];
  const at = new Date().toISOString();
  const cards = parseMoCards(row.cardsJson).map((c): MoCard => {
    if (c.type !== "creatives") return c;
    let hit = false;
    const items = c.items.map((it) => {
      const m = (it.adId && metrics.get(it.adId)) || (it.assetId && metrics.get(it.assetId));
      if (!m) return it;
      hit = true;
      return { ...it, metrics: m };
    });
    if (!hit) return c;
    touched.push(c.id);
    return { ...c, items, at, minimized: false, ...(subtitle ? { subtitle } : {}) };
  });
  if (touched.length) await prisma.moBoard.update({ where: { id: boardId }, data: { cardsJson: JSON.stringify(cards) } });
  return touched;
}
