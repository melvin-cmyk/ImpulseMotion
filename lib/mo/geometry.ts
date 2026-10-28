/**
 * Geometry of Mo's board (pure, client-safe, unit-tested): grid snapping,
 * alignment guides against neighbouring cards, resize with minimum sizes,
 * "Ranger" (masonry by turn, rows wrapped), fit-to-rects, and the anchors of
 * the compare links. World units = CSS px at zoom 1.
 */

import { CARD_SIZES, COL_GAP, ROW_GAP, type MoCard, type MoCardType } from "@/lib/mo/model";

export interface Rect { x: number; y: number; w: number; h: number }
export interface Guide { axis: "x" | "y"; pos: number; from: number; to: number }
export type HandleDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** Snap grid in world px; held Alt disables it. */
export const GRID = 20;
/** Distance (screen px) within which a card edge snaps to a neighbour's. */
export const SNAP_SCREEN_PX = 8;
/** Width of a row before "Ranger" and new turns wrap to the next one. */
export const MAX_ROW_WIDTH = 1400;

export const MIN_SIZES: Record<MoCardType, { w: number; h: number }> = {
  kpis: { w: 280, h: 140 },
  table: { w: 360, h: 200 },
  chart: { w: 320, h: 220 },
  creatives: { w: 320, h: 240 },
  note: { w: 260, h: 160 },
};
export const MAX_SIZE = { w: 1600, h: 1400 };

/** Header height of a minimised card (what stays visible). */
export const MIN_HEADER_H = 56;

export const rectOf = (c: MoCard): Rect => ({ x: c.x, y: c.y, w: c.w, h: c.minimized ? MIN_HEADER_H : c.h ?? CARD_SIZES[c.type].h });

export const snapToGrid = (v: number, grid = GRID) => Math.round(v / grid) * grid;

function nearest(candidates: number[], value: number, tol: number): number | null {
  let best: number | null = null;
  let bestD = tol;
  for (const c of candidates) {
    const d = Math.abs(c - value);
    if (d <= bestD) { best = c; bestD = d; }
  }
  return best;
}

/**
 * Where a moving rect should land: aligned with a neighbour's edge or centre
 * when one is within `tol` (world px), else on the grid (when `grid` is set).
 * Returns the position and the guides to draw.
 */
export function snapMove(moving: Rect, others: Rect[], tol: number, grid: number | null = GRID): { x: number; y: number; guides: Guide[] } {
  const xs: Array<{ at: number; to: number; from: number; span: Rect }> = [];
  const ys: Array<{ at: number; to: number; from: number; span: Rect }> = [];
  for (const o of others) {
    for (const edge of [o.x, o.x + o.w / 2, o.x + o.w]) {
      // The moving rect's left, centre or right can land on this edge.
      xs.push({ at: edge, to: edge, from: 0, span: o });
      xs.push({ at: edge - moving.w / 2, to: edge, from: 1, span: o });
      xs.push({ at: edge - moving.w, to: edge, from: 2, span: o });
    }
    for (const edge of [o.y, o.y + o.h / 2, o.y + o.h]) {
      ys.push({ at: edge, to: edge, from: 0, span: o });
      ys.push({ at: edge - moving.h / 2, to: edge, from: 1, span: o });
      ys.push({ at: edge - moving.h, to: edge, from: 2, span: o });
    }
  }
  const guides: Guide[] = [];
  let x = moving.x, y = moving.y;
  const bx = nearest(xs.map((c) => c.at), moving.x, tol);
  if (bx !== null) {
    x = bx;
    const c = xs.find((c) => c.at === bx)!;
    const top = Math.min(c.span.y, y), bottom = Math.max(c.span.y + c.span.h, y + moving.h);
    guides.push({ axis: "x", pos: c.to, from: top - 12, to: bottom + 12 });
  } else if (grid) x = snapToGrid(x, grid);
  const by = nearest(ys.map((c) => c.at), moving.y, tol);
  if (by !== null) {
    y = by;
    const c = ys.find((c) => c.at === by)!;
    const left = Math.min(c.span.x, x), right = Math.max(c.span.x + c.span.w, x + moving.w);
    guides.push({ axis: "y", pos: c.to, from: left - 12, to: right + 12 });
  } else if (grid) y = snapToGrid(y, grid);
  return { x: Math.round(x), y: Math.round(y), guides };
}

/** The rect after dragging one handle by (dx, dy), clamped to the type's minimum and the board maximum. */
export function resizeRect(start: Rect, dir: HandleDir, dx: number, dy: number, type: MoCardType, grid: number | null = GRID): Rect {
  const min = MIN_SIZES[type];
  let { x, y, w, h } = start;
  if (dir.includes("e")) w = start.w + dx;
  if (dir.includes("s")) h = start.h + dy;
  if (dir.includes("w")) { w = start.w - dx; x = start.x + dx; }
  if (dir.includes("n")) { h = start.h - dy; y = start.y + dy; }
  if (grid) {
    if (dir.includes("e") || dir.includes("w")) w = snapToGrid(w, grid);
    if (dir.includes("s") || dir.includes("n")) h = snapToGrid(h, grid);
  }
  w = Math.min(MAX_SIZE.w, Math.max(min.w, w));
  h = Math.min(MAX_SIZE.h, Math.max(min.h, h));
  // Western / northern handles keep the opposite edge where it was.
  if (dir.includes("w")) x = start.x + start.w - w;
  if (dir.includes("n")) y = start.y + start.h - h;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * "Ranger": cards grouped by turn (oldest first), each turn flowing left to
 * right in rows no wider than `maxWidth`, rows stacked with ROW_GAP; a new
 * turn always starts a new row. Returns the new position of every card.
 */
export function arrangeCards(cards: MoCard[], maxWidth = MAX_ROW_WIDTH): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const byTurn = new Map<number, MoCard[]>();
  for (const c of cards) { const t = c.turn ?? 0; if (!byTurn.has(t)) byTurn.set(t, []); byTurn.get(t)!.push(c); }
  const turns = [...byTurn.keys()].sort((a, b) => a - b);
  let y = 0;
  for (const t of turns) {
    const group = byTurn.get(t)!;
    let x = 0, rowH = 0;
    for (const c of group) {
      const r = rectOf(c);
      if (x > 0 && x + r.w > maxWidth) { y += rowH + ROW_GAP; x = 0; rowH = 0; }
      out.set(c.id, { x, y });
      x += r.w + COL_GAP;
      rowH = Math.max(rowH, r.h);
    }
    y += rowH + ROW_GAP;
  }
  return out;
}

/** The view (translate + scale) that shows every rect with `padding` screen px around, k clamped. */
export function fitView(rects: Rect[], W: number, H: number, padding: number, kMin: number, kMax: number): { x: number; y: number; k: number } | null {
  const valid = rects.filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0 && r.h > 0);
  if (!valid.length || W <= 0 || H <= 0) return null;
  const minX = Math.min(...valid.map((r) => r.x)), minY = Math.min(...valid.map((r) => r.y));
  const maxX = Math.max(...valid.map((r) => r.x + r.w)), maxY = Math.max(...valid.map((r) => r.y + r.h));
  const cw = Math.max(1, maxX - minX), ch = Math.max(1, maxY - minY);
  const k = Math.min(kMax, Math.max(kMin, Math.min((W - padding * 2) / cw, (H - padding * 2) / ch)));
  return { k, x: (W - cw * k) / 2 - minX * k, y: (H - ch * k) / 2 - minY * k };
}

/** Anchors of a compare link: the closest facing edges (centre of the edge) of the two rects. */
export function linkAnchors(a: Rect, b: Rect): { a: { x: number; y: number }; b: { x: number; y: number }; horizontal: boolean } {
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  const dx = bcx - acx, dy = bcy - acy;
  const gapX = Math.max(0, Math.abs(dx) - (a.w + b.w) / 2), gapY = Math.max(0, Math.abs(dy) - (a.h + b.h) / 2);
  if (gapX >= gapY) {
    return dx >= 0
      ? { a: { x: a.x + a.w, y: acy }, b: { x: b.x, y: bcy }, horizontal: true }
      : { a: { x: a.x, y: acy }, b: { x: b.x + b.w, y: bcy }, horizontal: true };
  }
  return dy >= 0
    ? { a: { x: acx, y: a.y + a.h }, b: { x: bcx, y: b.y }, horizontal: false }
    : { a: { x: acx, y: a.y }, b: { x: bcx, y: b.y + b.h }, horizontal: false };
}

/** SVG path of a link between two anchors (a cubic curve leaving the edge straight). */
export function linkPath(p: { a: { x: number; y: number }; b: { x: number; y: number }; horizontal: boolean }): string {
  const { a, b } = p;
  if (p.horizontal) { const mx = (a.x + b.x) / 2; return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`; }
  const my = (a.y + b.y) / 2; return `M ${a.x} ${a.y} C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${b.y}`;
}

/** Highest z on the board (0 when none). */
export const topZ = (cards: Array<{ z?: number }>) => cards.reduce((m, c) => Math.max(m, c.z ?? 0), 0);
