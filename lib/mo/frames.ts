/**
 * Client frames on Mo's board (pure, client-safe, unit-tested). A frame is a
 * card of type « frame » tied to a client of the registry: a named zone the
 * client's cards are laid in (they carry `frame: <frame id>`). Frames stand
 * side by side in creation order; cards flow inside in rows; a frame grows
 * to hold them. Cards without a client stay free (lib/mo/model.ts
 * layoutNewCards). Moving a frame moves its cards; « Ranger » arranges frame
 * by frame, then the free cards under them.
 */

import { CARD_SIZES, COL_GAP, ROW_GAP, layoutNewCards, newCardId, type MoCard, type MoCardSpec } from "@/lib/mo/model";

export type MoFrame = Extract<MoCard, { type: "frame" }>;

/** Inner padding, header height, gap between frames, width of the flow inside (two cards side by side), width of a row of frames before « Ranger » wraps. */
export const FRAME_PAD = 24;
export const FRAME_HEADER = 44;
export const FRAME_GAP = 80;
export const FRAME_INNER_WIDTH = 1120;
export const FRAME_ROW_WIDTH = 2600;
/** Height of a folded frame (its header). */
export const FRAME_FOLDED_H = 44;
export const FRAME_COLORS = ["#a78bfa", "#f0abfc", "#67e8f9", "#fde68a", "#86efac", "#fca5a5", "#fdba74", "#93c5fd"] as const;

export const isFrame = (c: MoCard): c is MoFrame => c.type === "frame";
export const frames = (cards: MoCard[]): MoFrame[] => cards.filter(isFrame);
export const frameOf = (cards: MoCard[], clientId: string): MoFrame | undefined => frames(cards).find((f) => f.clientId === clientId);
export const frameChildren = (cards: MoCard[], frameId: string): MoCard[] => cards.filter((c) => c.frame === frameId && !isFrame(c));

/** Colour of a client's frame: stable for the client, and not one already used on the board when another is free. */
export function frameColorFor(clientId: string, taken: string[] = []): string {
  let h = 0;
  for (let i = 0; i < clientId.length; i++) h = (h * 31 + clientId.charCodeAt(i)) >>> 0;
  const start = h % FRAME_COLORS.length;
  for (let i = 0; i < FRAME_COLORS.length; i++) { const c = FRAME_COLORS[(start + i) % FRAME_COLORS.length]; if (!taken.includes(c)) return c; }
  return FRAME_COLORS[start];
}

export interface Rect { x: number; y: number; w: number; h: number }
const heightOf = (c: MoCard) => (c.minimized ? FRAME_FOLDED_H : c.h ?? CARD_SIZES[c.type].h);

/** The zone of a frame where its cards go. */
export const frameContent = (f: Pick<MoFrame, "x" | "y" | "w" | "h">): Rect => ({ x: f.x + FRAME_PAD, y: f.y + FRAME_HEADER + FRAME_PAD, w: f.w - 2 * FRAME_PAD, h: (f.h ?? CARD_SIZES.frame.h) - FRAME_HEADER - 2 * FRAME_PAD });

/** The frame under a world point (the topmost when they overlap), or null. */
export function frameAt(cards: MoCard[], pt: { x: number; y: number }): MoFrame | null {
  let best: MoFrame | null = null;
  for (const f of frames(cards)) {
    const h = heightOf(f);
    if (pt.x >= f.x && pt.x <= f.x + f.w && pt.y >= f.y && pt.y <= f.y + h && (!best || (f.z ?? 0) >= (best.z ?? 0))) best = f;
  }
  return best;
}

/** Where a new frame goes: right of every frame (or of everything when there is none), at the top of the frames. */
export function newFramePlace(cards: MoCard[]): { x: number; y: number } {
  const fs = frames(cards);
  const pool = fs.length ? fs : cards;
  if (!pool.length) return { x: 0, y: 0 };
  return { x: Math.max(...pool.map((c) => c.x + c.w)) + FRAME_GAP, y: Math.min(...pool.map((c) => c.y)) };
}

function makeFrame(cards: MoCard[], client: { clientId: string; clientName: string }, id: string, turn: number, at: string, place = newFramePlace(cards)): MoFrame {
  const size = CARD_SIZES.frame;
  return { id, type: "frame", title: client.clientName, clientId: client.clientId, clientName: client.clientName, color: frameColorFor(client.clientId, frames(cards).map((f) => f.color)), x: place.x, y: place.y, w: size.w, h: size.h, z: 0, turn, at };
}

/** The frame grown (never shrunk) to hold its cards with the padding. */
export function grownFrame(f: MoFrame, children: MoCard[]): MoFrame {
  if (!children.length) return f;
  const right = Math.max(...children.map((c) => c.x + c.w)) + FRAME_PAD;
  const bottom = Math.max(...children.map((c) => c.y + heightOf(c))) + FRAME_PAD;
  const w = Math.max(f.w, right - f.x), h = Math.max(f.h ?? CARD_SIZES.frame.h, bottom - f.y);
  return w === f.w && h === f.h ? f : { ...f, w, h };
}

/** Something to lay: a spec, or a card moved from another board (its id and size kept when they fit). */
export type LayoutItem = MoCardSpec & { id?: string; w?: number; h?: number };

export interface FrameLayout {
  /** Every card of the board after the layout (frames updated or added, new cards appended). */
  cards: MoCard[];
  /** The content cards placed (not the frames), in order. */
  placed: MoCard[];
  /** Frames created by this layout. */
  newFrames: MoFrame[];
}

/**
 * Lays new cards on the board: those with a `clientId` flow inside their
 * client's frame (created to the right of the others when missing, unfolded
 * when folded, grown as needed); the rest go free under everything.
 */
export function layoutWithFrames(existing: MoCard[], items: LayoutItem[], turn: number, at: string, idGen: () => string = newCardId): FrameLayout {
  let cards = [...existing];
  const ids = new Set(cards.map((c) => c.id));
  const freshId = () => { let id = idGen(); while (ids.has(id)) id = idGen(); ids.add(id); return id; };
  const idFor = (item: LayoutItem) => (item.id && !ids.has(item.id) ? (ids.add(item.id), item.id) : freshId());
  let z = cards.reduce((m, c) => Math.max(m, c.z ?? 0), 0);
  const placed: MoCard[] = [];
  const newFrames: MoFrame[] = [];
  // Group by client, order of first appearance; the free ones apart.
  const byClient = new Map<string, LayoutItem[]>();
  const free: LayoutItem[] = [];
  for (const it of items) {
    if (it.clientId) { const l = byClient.get(it.clientId) ?? []; l.push(it); byClient.set(it.clientId, l); } else free.push(it);
  }
  for (const [clientId, group] of byClient) {
    let frame = frameOf(cards, clientId);
    if (!frame) {
      frame = makeFrame(cards, { clientId, clientName: group.find((g) => g.clientName)?.clientName ?? clientId }, freshId(), turn, at);
      cards.push(frame);
      newFrames.push(frame);
    } else if (frame.minimized) {
      frame = { ...frame, minimized: false };
    }
    const content = frameContent(frame);
    const children = frameChildren(cards, frame.id);
    const innerW = Math.max(FRAME_INNER_WIDTH, content.w);
    let y = children.length ? Math.max(...children.map((c) => c.y + heightOf(c))) + ROW_GAP : content.y;
    let x = content.x, rowH = 0;
    for (const it of group) {
      const def = CARD_SIZES[it.type];
      const w = it.w ?? def.w, h = it.h ?? def.h;
      if (x > content.x && x + w > content.x + innerW) { y += rowH + ROW_GAP; x = content.x; rowH = 0; }
      const { ref, id: _id, w: _w, h: _h, ...rest } = it; void [_id, _w, _h];
      z += 1;
      const card = { ...rest, ...(ref && ids.has(ref) ? { ref } : {}), id: idFor(it), x, y, w, h, z, turn, at, frame: frame.id } as MoCard;
      placed.push(card);
      cards.push(card);
      x += w + COL_GAP;
      rowH = Math.max(rowH, h);
    }
    const grown = grownFrame(frame, frameChildren(cards, frame.id));
    cards = cards.map((c) => (c.id === grown.id ? grown : c));
    if (newFrames.some((f) => f.id === grown.id)) newFrames.splice(newFrames.findIndex((f) => f.id === grown.id), 1, grown);
  }
  if (free.length) {
    const laid = layoutNewCards(cards, { cards: free.map(({ id: _i, w: _w, h: _h, ...spec }) => (void [_i, _w, _h], spec)) }, turn, at);
    placed.push(...laid);
    cards.push(...laid);
  }
  return { cards, placed, newFrames };
}

/**
 * A card put at an explicit world point (a dropped file, a publication next
 * to its visual): inside the frame under the point when there is one; else,
 * for a client's card, in the flow of its frame (created at the point when
 * missing); else free at the point. Returns the board and the card.
 */
export function placeWithFrames(existing: MoCard[], spec: MoCardSpec, pt: { x: number; y: number }, turn: number, at: string, idGen: () => string = newCardId): { cards: MoCard[]; card: MoCard; newFrame: MoFrame | null } {
  const ids = new Set(existing.map((c) => c.id));
  let id = idGen();
  while (ids.has(id)) id = idGen();
  const size = CARD_SIZES[spec.type];
  const clamp = (v: number) => Math.min(50_000, Math.max(-50_000, Math.round(Number.isFinite(v) ? v : 0)));
  const z = existing.reduce((m, c) => Math.max(m, c.z ?? 0), 0) + 1;
  const { ref, ...rest } = spec;
  const base = { ...rest, ...(ref && ids.has(ref) ? { ref } : {}), id, w: size.w, h: size.h, z, turn, at };
  const under = frameAt(existing, pt);
  if (under && !under.minimized) {
    const card = { ...base, x: clamp(pt.x), y: clamp(pt.y), frame: under.id } as MoCard;
    const cards = [...existing, card];
    const grown = grownFrame(under, frameChildren(cards, under.id));
    return { cards: cards.map((c) => (c.id === grown.id ? grown : c)), card, newFrame: null };
  }
  if (spec.clientId) {
    const existingFrame = frameOf(existing, spec.clientId);
    if (existingFrame) {
      const laid = layoutWithFrames(existing, [{ ...spec }], turn, at, () => id);
      return { cards: laid.cards, card: laid.placed[0], newFrame: null };
    }
    // No frame yet: one is opened where the person dropped the card, the card first inside.
    const frame = makeFrame(existing, { clientId: spec.clientId, clientName: spec.clientName ?? spec.clientId }, (() => { let f = idGen(); while (ids.has(f) || f === id) f = idGen(); return f; })(), turn, at, { x: clamp(pt.x - FRAME_PAD), y: clamp(pt.y - FRAME_HEADER - FRAME_PAD) });
    const card = { ...base, x: clamp(pt.x), y: clamp(pt.y), frame: frame.id } as MoCard;
    const grown = grownFrame(frame, [card]);
    return { cards: [...existing, grown, card], card, newFrame: grown };
  }
  const card = { ...base, x: clamp(pt.x), y: clamp(pt.y) } as MoCard;
  return { cards: [...existing, card], card, newFrame: null };
}

/** The frame a card moved by hand now belongs to (the one under its centre), or null when it lies outside every frame. */
export function frameForMovedCard(cards: MoCard[], card: Pick<MoCard, "id" | "x" | "y" | "w" | "h" | "type">): string | null {
  const f = frameAt(cards.filter((c) => c.id !== card.id), { x: card.x + card.w / 2, y: card.y + Math.min(40, (card.h ?? CARD_SIZES[card.type].h) / 2) });
  return f && !f.minimized ? f.id : null;
}

/** New positions of a frame's cards when the frame moves by (dx, dy). */
export function moveFrameChildren(cards: MoCard[], frameId: string, dx: number, dy: number): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const c of frameChildren(cards, frameId)) out.set(c.id, { x: Math.round(c.x + dx), y: Math.round(c.y + dy) });
  return out;
}

export type ArrangedRect = { x: number; y: number; w?: number; h?: number };

/**
 * How « Ranger » lays the board out: `grid` = the masonry (rows wrapped);
 * `row` = everything on one line, left to right, aligned on top; `column` =
 * everything in one column, top to bottom, aligned on the left.
 */
export type ArrangeLayout = "grid" | "row" | "column";
export const ARRANGE_LAYOUTS: readonly ArrangeLayout[] = ["grid", "row", "column"];
export type ArrangeFlow = (cards: MoCard[], maxWidth?: number) => Map<string, { x: number; y: number }>;

/**
 * « Ranger » with frames. `grid`: frames side by side (rows of
 * FRAME_ROW_WIDTH, in their current order left to right, top to bottom), each
 * one's cards flowing inside, the frame sized to its content; the free cards
 * under the frames. `row`: the frames on one line (never wrapped), their
 * cards in one line inside, then the free cards on the same line after them.
 * `column`: the frames stacked, their cards in one column inside, then the
 * free cards under them. `flow` lays a set of cards out (lib/mo/geometry.ts
 * arrangeFree / arrangeRow / arrangeColumn). Returns the new position (and
 * size, for frames) of every card.
 */
export function arrangeWithFrames(cards: MoCard[], flow: ArrangeFlow, maxWidth?: number, layout: ArrangeLayout = "grid"): Map<string, ArrangedRect> {
  const out = new Map<string, ArrangedRect>();
  const fs = [...frames(cards)].sort((a, b) => (Math.round(a.y / 200) - Math.round(b.y / 200)) || a.x - b.x || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let fx = 0, fy = 0, rowH = 0;
  const inFrames = new Set<string>();
  for (const f of fs) {
    const kids = frameChildren(cards, f.id);
    kids.forEach((k) => inFrames.add(k.id));
    // The flow inside, relative to the content origin; a folded frame keeps its cards tidy for when it opens.
    const rel = flow(kids, FRAME_INNER_WIDTH);
    const w = Math.max(CARD_SIZES.frame.w, ...kids.map((k) => (rel.get(k.id)?.x ?? 0) + k.w + 2 * FRAME_PAD));
    const contentH = kids.length ? Math.max(...kids.map((k) => (rel.get(k.id)?.y ?? 0) + (k.minimized ? FRAME_FOLDED_H : k.h ?? CARD_SIZES[k.type].h))) : 0;
    const h = kids.length ? FRAME_HEADER + 2 * FRAME_PAD + contentH : CARD_SIZES.frame.h;
    const shownH = f.minimized ? FRAME_FOLDED_H : h;
    // A new line of frames: when the grid's row is full, or after every frame in a column.
    if (fx > 0 && (layout === "column" || (layout === "grid" && fx + w > FRAME_ROW_WIDTH))) { fy += rowH + FRAME_GAP; fx = 0; rowH = 0; }
    out.set(f.id, { x: fx, y: fy, w, h });
    for (const k of kids) { const r = rel.get(k.id) ?? { x: 0, y: 0 }; out.set(k.id, { x: fx + FRAME_PAD + r.x, y: fy + FRAME_HEADER + FRAME_PAD + r.y }); }
    fx += w + FRAME_GAP;
    rowH = Math.max(rowH, shownH);
  }
  const free = cards.filter((c) => !isFrame(c) && !inFrames.has(c.id));
  // The free cards: after the frames on the same line (row), else under them.
  const origin = !fs.length ? { x: 0, y: 0 } : layout === "row" ? { x: fx, y: 0 } : { x: 0, y: fy + rowH + FRAME_GAP };
  for (const [id, p] of flow(free, maxWidth)) out.set(id, { x: p.x + origin.x, y: p.y + origin.y });
  return out;
}
