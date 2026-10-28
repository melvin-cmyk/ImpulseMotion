/**
 * Storage of a Mo board (MoBoard row): cards and messages as JSON, parsing
 * with caps, appends. Server only.
 */

import { prisma } from "@/lib/prisma";
import { applyCardUpdates, boardTitleFrom, modelHistory, parseMoAnswer, parseMoEntries, MO_MAX_CARDS, MO_MAX_MESSAGES, type MoActionMeta, type MoBoardData, type MoCard, type MoCardPatch, type MoCardSpec, type MoChatMessage, type MoMessage } from "@/lib/mo/model";
import { MAX_FRAME_SIZE, MAX_SIZE, MIN_SIZES } from "@/lib/mo/geometry";
import { frameChildren, isFrame, layoutWithFrames, placeWithFrames, type LayoutItem } from "@/lib/mo/frames";
import { HOME_TITLE, type MoPageKind } from "@/lib/mo/pages";

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

export function toBoardData(row: { id: string; title: string; cardsJson: string; messagesJson: string; updatedAt: Date; kind?: string; clientId?: string | null; archivedAt?: Date | null }): MoBoardData {
  const kind: MoPageKind = row.kind === "home" || row.kind === "client" ? row.kind : "free";
  return { id: row.id, title: kind === "home" ? HOME_TITLE : row.title, kind, clientId: row.clientId ?? null, archived: !!row.archivedAt, cards: parseMoCards(row.cardsJson), messages: parseMoEntries(row.messagesJson), updatedAt: row.updatedAt.toISOString() };
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
  // A client's card goes in its frame (created if missing), the rest free under everything.
  const laid = layoutWithFrames(cards, specs, turn, at);
  const placed = laid.placed;
  // The cards the person should look at: the ones the tools posted during this turn, the rewritten ones, the new ones (a removed id is not on the board any more).
  const postedByTools = cards.filter((c) => c.turn === turn && !isFrame(c) && !messages.some((m) => m.cardIds?.includes(c.id))).map((c) => c.id);
  const cardIds = [...new Set([...postedByTools, ...updated.touched.filter((id) => cards.some((c) => c.id === id)), ...placed.map((c) => c.id)])];
  const all = capCards(laid.cards);
  const msgs: MoMessage[] = [...messages, { role: "assistant" as const, content: text, at, say: answer.say, cardIds, ...(answer.open ? { open: answer.open } : {}) }].slice(-MO_MAX_MESSAGES);
  await prisma.moBoard.update({ where: { id: boardId }, data: { cardsJson: JSON.stringify(all), messagesJson: JSON.stringify(msgs) } });
  return { say: answer.say, cardIds, ...(answer.open ? { open: answer.open } : {}) };
}

/** The board capped at MO_MAX_CARDS: the oldest free cards leave first, frames and their cards last. */
function capCards(cards: MoCard[]): MoCard[] {
  if (cards.length <= MO_MAX_CARDS) return cards;
  let extra = cards.length - MO_MAX_CARDS;
  const out: MoCard[] = [];
  for (const c of cards) { if (extra > 0 && !isFrame(c) && !c.frame) { extra -= 1; continue; } out.push(c); }
  return out.slice(-MO_MAX_CARDS);
}

/**
 * The home page « Aujourd'hui » of a consultant: one per user, created on first
 * use; the orb on every page posts there. The « Mo partout » board of before is
 * that page (`dock` kept for compatibility).
 */
export async function getOrCreateHomeBoard(userId: string) {
  const existing = await prisma.moBoard.findFirst({ where: { userId, kind: "home" }, orderBy: { createdAt: "asc" } })
    ?? await prisma.moBoard.findFirst({ where: { userId, dock: true }, orderBy: { updatedAt: "desc" } });
  if (existing) {
    if (existing.kind !== "home" || existing.archivedAt || existing.title !== HOME_TITLE) return prisma.moBoard.update({ where: { id: existing.id }, data: { kind: "home", dock: true, archivedAt: null, title: HOME_TITLE } });
    return existing;
  }
  return prisma.moBoard.create({ data: { userId, dock: true, kind: "home", title: HOME_TITLE } });
}
/** @deprecated name of before: the home page. */
export const getOrCreateDockBoard = getOrCreateHomeBoard;

/** The page of a client (kind « client »), created on demand with the client's name. */
export async function getOrCreateClientBoard(userId: string, client: { id: string; name: string }): Promise<{ board: Awaited<ReturnType<typeof prisma.moBoard.create>>; created: boolean }> {
  const existing = await prisma.moBoard.findFirst({ where: { userId, kind: "client", clientId: client.id, archivedAt: null }, orderBy: { createdAt: "asc" } });
  if (existing) return { board: existing, created: false };
  const last = await prisma.moBoard.aggregate({ where: { userId, kind: "client" }, _max: { position: true } });
  return { board: await prisma.moBoard.create({ data: { userId, kind: "client", clientId: client.id, title: client.name, position: (last._max.position ?? 0) + 1 } }), created: true };
}

/** Title, archive, order of a page (the home page is never archived). */
export async function updateMoBoardMeta(boardId: string, patch: { title?: string; archived?: boolean; position?: number }) {
  const row = await prisma.moBoard.findUnique({ where: { id: boardId }, select: { kind: true } });
  if (!row) return null;
  const data: { title?: string; archivedAt?: Date | null; position?: number } = {};
  if (typeof patch.title === "string" && row.kind !== "home") data.title = patch.title.trim().slice(0, 80);
  if (typeof patch.archived === "boolean" && row.kind !== "home") data.archivedAt = patch.archived ? new Date() : null;
  if (typeof patch.position === "number" && Number.isFinite(patch.position)) data.position = Math.max(0, Math.min(10_000, Math.round(patch.position)));
  return prisma.moBoard.update({ where: { id: boardId }, data });
}

/**
 * « Détacher en page » : the frame of a client and its cards leave this board
 * for the client's page (created if missing), laid in that page's frame; the
 * journal lines about those cards follow. Returns the page id and the ids moved.
 */
export async function detachFrameToPage(userId: string, boardId: string, frameId: string, client: { id: string; name: string }): Promise<{ pageId: string; moved: string[] } | null> {
  const src = await prisma.moBoard.findFirst({ where: { id: boardId, userId }, select: { id: true, cardsJson: true, messagesJson: true } });
  if (!src) return null;
  const cards = parseMoCards(src.cardsJson);
  const frame = cards.find((c): c is Extract<MoCard, { type: "frame" }> => isFrame(c) && c.id === frameId);
  if (!frame) return null;
  const { board: page } = await getOrCreateClientBoard(userId, client);
  if (page.id === src.id) return { pageId: page.id, moved: [] };
  const kids = frameChildren(cards, frame.id);
  const target = parseMoCards(page.cardsJson);
  const targetMessages = parseMoEntries(page.messagesJson);
  const turn = targetMessages.filter((m) => m.role === "assistant").length;
  const at = new Date().toISOString();
  const items: LayoutItem[] = kids.map((k) => { const { x: _x, y: _y, z: _z, frame: _f, turn: _t, at: _a, minimized: _m, ...rest } = k; void [_x, _y, _z, _f, _t, _a, _m]; return { ...rest, clientId: client.id, clientName: client.name } as LayoutItem; });
  const laid = layoutWithFrames(target, items, turn, at);
  const movedIds = new Set(kids.map((k) => k.id));
  const gone = new Set([frame.id, ...movedIds]);
  // What was said about those cards follows them: the journal lines (verdicts, files…) and the turns whose cards all left, with the question that led to each.
  const srcMessages = parseMoEntries(src.messagesJson);
  const movingIdx = new Set<number>();
  srcMessages.forEach((m, i) => {
    if (!m.cardIds?.length || !m.cardIds.every((id) => movedIds.has(id))) return;
    if (m.role === "action") movingIdx.add(i);
    else if (m.role === "assistant") { movingIdx.add(i); if (i > 0 && srcMessages[i - 1].role === "user") movingIdx.add(i - 1); }
  });
  const moving = srcMessages.filter((_, i) => movingIdx.has(i));
  const keep = srcMessages.filter((_, i) => !movingIdx.has(i));
  const merged = [...targetMessages, ...moving].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-MO_MAX_MESSAGES);
  await prisma.$transaction([
    prisma.moBoard.update({ where: { id: src.id }, data: { cardsJson: JSON.stringify(cards.filter((c) => !gone.has(c.id))), messagesJson: JSON.stringify(keep) } }),
    prisma.moBoard.update({ where: { id: page.id }, data: { cardsJson: JSON.stringify(capCards(laid.cards)), messagesJson: JSON.stringify(merged) } }),
  ]);
  return { pageId: page.id, moved: laid.placed.map((c) => c.id) };
}

/** Geometry only: the consultant moved, resized, folded or removed cards. */
export async function updateMoCards(boardId: string, patch: Array<MoCardPatch & { id: string }>): Promise<MoCard[]> {
  const row = await prisma.moBoard.findUnique({ where: { id: boardId }, select: { cardsJson: true } });
  if (!row) return [];
  const byId = new Map(patch.map((p) => [p.id, p]));
  const num = (v: unknown, fallback: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback);
  const before = parseMoCards(row.cardsJson);
  const frameIds = new Set(before.filter(isFrame).map((f) => f.id));
  const removedFrames = new Set(before.filter((c) => isFrame(c) && byId.get(c.id)?.removed).map((c) => c.id));
  const cards = before.flatMap((c): MoCard[] => {
    const p = byId.get(c.id);
    // A frame removed: its cards stay, free.
    const freed = c.frame && removedFrames.has(c.frame) ? { frame: undefined } : {};
    if (!p) return [{ ...c, ...freed } as MoCard];
    if (p.removed) return [];
    const min = MIN_SIZES[c.type] ?? { w: 240, h: 120 };
    const max = isFrame(c) ? MAX_FRAME_SIZE : MAX_SIZE;
    const frame = p.frame === null ? { frame: undefined } : typeof p.frame === "string" && frameIds.has(p.frame) && !removedFrames.has(p.frame) && p.frame !== c.id && !isFrame(c) ? { frame: p.frame } : freed;
    return [{ ...c, x: num(p.x, c.x, -50_000, 50_000), y: num(p.y, c.y, -50_000, 50_000), w: num(p.w, c.w, min.w, max.w), h: num(p.h, c.h ?? 300, min.h, max.h), ...(typeof p.z === "number" ? { z: num(p.z, c.z ?? 0, 0, 1_000_000_000) } : {}), ...(typeof p.minimized === "boolean" ? { minimized: p.minimized } : {}), ...frame } as MoCard];
  }).map((c) => { if (c.frame === undefined) { const { frame: _f, ...rest } = c; void _f; return rest as MoCard; } return c; });
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
  // A client's card lands in its frame (opened on the fly when missing); the rest free.
  const laid = layoutWithFrames(cards, specs, turn, at);
  await prisma.moBoard.update({ where: { id: boardId }, data: { cardsJson: JSON.stringify(capCards(laid.cards)) } });
  return laid.placed.map((c) => c.id);
}

/**
 * A card put where the person wants it (a dropped file, a publication next
 * to its visual): inside the frame under the point, else in the flow of its
 * client's frame (opened at the point when missing), else free at the point
 * (lib/mo/frames.ts placeWithFrames). Default size of its type, on top of the
 * stack. Returns the card.
 */
export async function placeMoCard(boardId: string, spec: MoCardSpec, at: { x: number; y: number }, now = new Date().toISOString()): Promise<MoCard | null> {
  const row = await prisma.moBoard.findUnique({ where: { id: boardId }, select: { cardsJson: true, messagesJson: true } });
  if (!row) return null;
  const cards = parseMoCards(row.cardsJson);
  const turn = parseMoEntries(row.messagesJson).filter((m) => m.role === "assistant").length;
  const placed = placeWithFrames(cards, spec, at, turn, now);
  await prisma.moBoard.update({ where: { id: boardId }, data: { cardsJson: JSON.stringify(capCards(placed.cards)) } });
  return placed.card;
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
