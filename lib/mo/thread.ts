/**
 * Storage of a Mo board (MoBoard row): cards and messages as JSON, parsing
 * with caps, appends. Server only.
 */

import { prisma } from "@/lib/prisma";
import { boardTitleFrom, layoutNewCards, parseMoAnswer, MO_MAX_CARDS, MO_MAX_MESSAGES, type MoBoardData, type MoCard, type MoCardPatch, type MoMessage } from "@/lib/mo/model";

export const BOARD_ID_RE = /^[a-z0-9]{10,40}$/i;

export function parseMoCards(json: string | null | undefined): MoCard[] {
  if (!json) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is MoCard => !!c && typeof c === "object" && typeof (c as MoCard).id === "string" && typeof (c as MoCard).type === "string").slice(-MO_MAX_CARDS);
}

export function parseMoMessages(json: string | null | undefined): MoMessage[] {
  if (!json) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: MoMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    if ((r.role !== "user" && r.role !== "assistant") || typeof r.content !== "string") continue;
    out.push({
      role: r.role,
      content: r.content,
      at: typeof r.at === "string" ? r.at : new Date(0).toISOString(),
      ...(typeof r.say === "string" ? { say: r.say } : {}),
      ...(Array.isArray(r.cardIds) ? { cardIds: r.cardIds.filter((x): x is string => typeof x === "string") } : {}),
    });
  }
  return out.slice(-MO_MAX_MESSAGES);
}

export function toBoardData(row: { id: string; title: string; cardsJson: string; messagesJson: string; updatedAt: Date }): MoBoardData {
  return { id: row.id, title: row.title, cards: parseMoCards(row.cardsJson), messages: parseMoMessages(row.messagesJson), updatedAt: row.updatedAt.toISOString() };
}

export async function loadBoard(id: string, userId: string) {
  if (!BOARD_ID_RE.test(id)) return null;
  return prisma.moBoard.findFirst({ where: { id, userId } });
}

export async function appendMoUserMessage(boardId: string, content: string, at: string): Promise<void> {
  const row = await prisma.moBoard.findUnique({ where: { id: boardId }, select: { messagesJson: true, title: true } });
  if (!row) return;
  const all = [...parseMoMessages(row.messagesJson), { role: "user" as const, content, at }];
  await prisma.moBoard.update({ where: { id: boardId }, data: { messagesJson: JSON.stringify(all.slice(-MO_MAX_MESSAGES)), ...(row.title ? {} : { title: boardTitleFrom(all) }) } });
}

/** Ends a turn: parses the answer, lays the new cards on the board, stores the message with what to say. */
export async function appendMoAnswer(boardId: string, text: string, at: string): Promise<{ say: string; cardIds: string[] } | null> {
  const row = await prisma.moBoard.findUnique({ where: { id: boardId }, select: { cardsJson: true, messagesJson: true } });
  if (!row) return null;
  const cards = parseMoCards(row.cardsJson);
  const messages = parseMoMessages(row.messagesJson);
  const answer = parseMoAnswer(text);
  const turn = messages.filter((m) => m.role === "assistant").length;
  const placed = layoutNewCards(cards, answer, turn, at);
  const cardIds = placed.map((c) => c.id);
  const all = [...cards, ...placed].slice(-MO_MAX_CARDS);
  const msgs = [...messages, { role: "assistant" as const, content: text, at, say: answer.say, cardIds }].slice(-MO_MAX_MESSAGES);
  await prisma.moBoard.update({ where: { id: boardId }, data: { cardsJson: JSON.stringify(all), messagesJson: JSON.stringify(msgs) } });
  return { say: answer.say, cardIds };
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
    return [{ ...c, x: num(p.x, c.x, -50_000, 50_000), y: num(p.y, c.y, -50_000, 50_000), w: num(p.w, c.w, 240, 1600), h: num(p.h, c.h ?? 300, 120, 1400), ...(typeof p.minimized === "boolean" ? { minimized: p.minimized } : {}) } as MoCard];
  });
  await prisma.moBoard.update({ where: { id: boardId }, data: { cardsJson: JSON.stringify(cards) } });
  return cards;
}
