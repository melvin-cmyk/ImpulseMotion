import { describe, expect, it } from "vitest";
import { CARD_SIZES, COL_GAP, ROW_GAP, type MoCard, type MoCardSpec } from "@/lib/mo/model";
import { FRAME_GAP, FRAME_HEADER, FRAME_PAD, FRAME_INNER_WIDTH, frameChildren, frameColorFor, frameForMovedCard, frameOf, frames, layoutWithFrames, moveFrameChildren, placeWithFrames, type MoFrame } from "@/lib/mo/frames";
import { arrangeCards } from "@/lib/mo/geometry";

const kpis = (clientId?: string, clientName?: string, title = "KPI"): MoCardSpec => ({ type: "kpis", title, items: [{ label: "CPA", value: "12 €" }], ...(clientId ? { clientId, clientName } : {}) });
const creatives = (clientId: string, clientName: string): MoCardSpec => ({ type: "creatives", title: `Créas ${clientName}`, items: [{ name: "A", metrics: {} }], clientId, clientName });
let n = 0;
const ids = () => `id${String(++n).padStart(3, "0")}`;

describe("frames — a client's card opens its frame and goes inside", () => {
  it("creates the frame at the origin of an empty board, the card in its content zone", () => {
    const r = layoutWithFrames([], [kpis("nat", "Naturalia")], 0, "t", ids);
    expect(r.newFrames).toHaveLength(1);
    const f = r.newFrames[0];
    expect(f).toMatchObject({ type: "frame", clientId: "nat", clientName: "Naturalia", title: "Naturalia", x: 0, y: 0, w: CARD_SIZES.frame.w });
    expect(r.placed).toHaveLength(1);
    expect(r.placed[0]).toMatchObject({ frame: f.id, x: FRAME_PAD, y: FRAME_HEADER + FRAME_PAD, clientId: "nat" });
    // The frame holds the card with its padding.
    expect(f.h).toBeGreaterThanOrEqual(FRAME_HEADER + FRAME_PAD + CARD_SIZES.kpis.h + FRAME_PAD);
    expect(r.cards).toHaveLength(2);
    expect(frames(r.cards)).toHaveLength(1);
  });
  it("reuses the client's frame: the next card flows on a new row, the frame grows", () => {
    const first = layoutWithFrames([], [kpis("nat", "Naturalia")], 0, "t", ids);
    const f0 = frameOf(first.cards, "nat")!;
    const second = layoutWithFrames(first.cards, [creatives("nat", "Naturalia")], 1, "t2", ids);
    expect(second.newFrames).toHaveLength(0);
    const f1 = frameOf(second.cards, "nat")!;
    expect(f1.id).toBe(f0.id);
    const c = second.placed[0];
    expect(c.frame).toBe(f0.id);
    expect(c.x).toBe(FRAME_PAD);
    expect(c.y).toBe(FRAME_HEADER + FRAME_PAD + CARD_SIZES.kpis.h + ROW_GAP);
    expect(f1.h!).toBeGreaterThan(f0.h!);
    expect(f1.y + f1.h!).toBeGreaterThanOrEqual(c.y + CARD_SIZES.creatives.h + FRAME_PAD);
  });
  it("two cards of one turn sit side by side inside, wrapping at the inner width", () => {
    const r = layoutWithFrames([], [kpis("nat", "Naturalia", "a"), kpis("nat", "Naturalia", "b"), creatives("nat", "Naturalia")], 0, "t", ids);
    const [a, b, c] = r.placed;
    expect(b.x).toBe(a.x + CARD_SIZES.kpis.w + COL_GAP);
    expect(b.y).toBe(a.y);
    // 440 + 40 + 440 + 40 + 660 > 1120 → the creatives card wraps.
    expect(a.x + CARD_SIZES.kpis.w + COL_GAP + CARD_SIZES.kpis.w + COL_GAP + CARD_SIZES.creatives.w).toBeGreaterThan(FRAME_PAD + FRAME_INNER_WIDTH);
    expect(c.x).toBe(FRAME_PAD);
    expect(c.y).toBe(a.y + CARD_SIZES.kpis.h + ROW_GAP);
  });
  it("frames of different clients stand side by side in creation order, with their own colours", () => {
    const r1 = layoutWithFrames([], [kpis("nat", "Naturalia")], 0, "t", ids);
    const r2 = layoutWithFrames(r1.cards, [kpis("cl", "Cours Legendre")], 1, "t", ids);
    const [fa, fb] = frames(r2.cards);
    expect(fb.x).toBe(fa.x + fa.w + FRAME_GAP);
    expect(fb.y).toBe(fa.y);
    expect(fa.color).not.toBe(fb.color);
  });
  it("cards without a client stay free, under everything (frames included)", () => {
    const r1 = layoutWithFrames([], [kpis("nat", "Naturalia")], 0, "t", ids);
    const r2 = layoutWithFrames(r1.cards, [kpis()], 1, "t", ids);
    expect(r2.newFrames).toHaveLength(0);
    const free = r2.placed[0];
    expect(free.frame).toBeUndefined();
    const f = frameOf(r2.cards, "nat")!;
    expect(free.y).toBeGreaterThanOrEqual(f.y + f.h! + ROW_GAP);
  });
  it("a folded frame unfolds when a card arrives", () => {
    const r1 = layoutWithFrames([], [kpis("nat", "Naturalia")], 0, "t", ids);
    const folded = r1.cards.map((c) => (c.type === "frame" ? { ...c, minimized: true } : c)) as MoCard[];
    const r2 = layoutWithFrames(folded, [kpis("nat", "Naturalia")], 1, "t", ids);
    expect(frameOf(r2.cards, "nat")!.minimized).toBe(false);
  });
  it("a card moved from another board keeps its id and size", () => {
    const r = layoutWithFrames([], [{ ...kpis("nat", "Naturalia"), id: "keepme", w: 600, h: 300 }], 0, "t", ids);
    expect(r.placed[0]).toMatchObject({ id: "keepme", w: 600, h: 300 });
    // A colliding id gets a fresh one.
    const r2 = layoutWithFrames(r.cards, [{ ...kpis("nat", "Naturalia"), id: "keepme" }], 1, "t", ids);
    expect(r2.placed[0].id).not.toBe("keepme");
  });
  it("the colour is stable for a client and avoids the ones already used", () => {
    const a = frameColorFor("nat");
    expect(frameColorFor("nat")).toBe(a);
    expect(frameColorFor("nat", [a])).not.toBe(a);
  });
});

describe("frames — a card put at a point", () => {
  it("inside a frame joins it and the frame grows to hold it", () => {
    const r = layoutWithFrames([], [kpis("nat", "Naturalia")], 0, "t", ids);
    const f = frameOf(r.cards, "nat")!;
    const pt = { x: f.x + 600, y: f.y + FRAME_HEADER + 10 };
    const p = placeWithFrames(r.cards, { type: "file", title: "a.png", name: "a.png", mime: "image/png" }, pt, 0, "t", ids);
    expect(p.card).toMatchObject({ x: pt.x, y: pt.y, frame: f.id });
    const grown = frameOf(p.cards, "nat")!;
    expect(grown.y + grown.h!).toBeGreaterThanOrEqual(pt.y + CARD_SIZES.file.h + FRAME_PAD);
    expect(p.newFrame).toBeNull();
  });
  it("outside every frame, a client's card flows into its client's frame", () => {
    const r = layoutWithFrames([], [kpis("nat", "Naturalia")], 0, "t", ids);
    const f = frameOf(r.cards, "nat")!;
    const p = placeWithFrames(r.cards, kpis("nat", "Naturalia"), { x: 5000, y: 5000 }, 1, "t", ids);
    expect(p.card.frame).toBe(f.id);
    expect(p.card.y).toBe(FRAME_HEADER + FRAME_PAD + CARD_SIZES.kpis.h + ROW_GAP);
  });
  it("a client without a frame yet gets one opened at the point, the card first inside", () => {
    const p = placeWithFrames([], { type: "file", title: "a.png", name: "a.png", mime: "image/png", clientId: "cl", clientName: "Cours Legendre" }, { x: 300, y: 200 }, 0, "t", ids);
    expect(p.newFrame).not.toBeNull();
    expect(p.newFrame).toMatchObject({ clientId: "cl", x: 300 - FRAME_PAD, y: 200 - FRAME_HEADER - FRAME_PAD });
    expect(p.card).toMatchObject({ x: 300, y: 200, frame: p.newFrame!.id });
    expect(p.cards).toHaveLength(2);
  });
  it("a card without a client lands free at the point", () => {
    const p = placeWithFrames([], { type: "note", title: "n", markdown: "x" }, { x: 10, y: 20 }, 0, "t", ids);
    expect(p.card).toMatchObject({ x: 10, y: 20 });
    expect(p.card.frame).toBeUndefined();
    expect(p.newFrame).toBeNull();
  });
});

describe("frames — moving and arranging", () => {
  it("moving a frame moves its cards by the same delta; a card dragged over a frame joins it", () => {
    const r = layoutWithFrames([], [kpis("nat", "Naturalia"), kpis("nat", "Naturalia")], 0, "t", ids);
    const f = frameOf(r.cards, "nat")!;
    const kids = frameChildren(r.cards, f.id);
    const moved = moveFrameChildren(r.cards, f.id, 100, -50);
    expect(moved.size).toBe(2);
    for (const k of kids) expect(moved.get(k.id)).toEqual({ x: k.x + 100, y: k.y - 50 });
    const free: MoCard = { id: "free1", type: "note", title: "n", markdown: "x", x: 9000, y: 9000, w: 400, h: 300, turn: 0, at: "t" };
    expect(frameForMovedCard([...r.cards, free], free)).toBeNull();
    expect(frameForMovedCard([...r.cards, free], { ...free, x: f.x + 50, y: f.y + FRAME_HEADER + 10 })).toBe(f.id);
    // Not into a folded frame.
    const folded = r.cards.map((c) => (c.id === f.id ? { ...c, minimized: true } : c)) as MoCard[];
    expect(frameForMovedCard([...folded, free], { ...free, x: f.x + 50, y: f.y + 10 })).toBeNull();
  });
  it("« Ranger » lays the frames side by side, each sized to its cards, and the free cards under them", () => {
    let cards = layoutWithFrames([], [kpis("nat", "Naturalia")], 0, "t", ids).cards;
    cards = layoutWithFrames(cards, [creatives("cl", "Cours Legendre"), kpis()], 1, "t", ids).cards;
    // Mess the positions up.
    cards = cards.map((c) => ({ ...c, x: c.x + 777, y: c.y + 333 })) as MoCard[];
    const pos = arrangeCards(cards);
    const [fa, fb] = frames(cards);
    const pa = pos.get(fa.id)!, pb = pos.get(fb.id)!;
    expect(pa).toMatchObject({ x: 0, y: 0 });
    expect(pb.x).toBe(pa.w! + FRAME_GAP);
    expect(pb.y).toBe(0);
    expect(pa.h).toBe(FRAME_HEADER + 2 * FRAME_PAD + CARD_SIZES.kpis.h);
    const kidA = frameChildren(cards, fa.id)[0];
    expect(pos.get(kidA.id)).toEqual({ x: FRAME_PAD, y: FRAME_HEADER + FRAME_PAD });
    const kidB = frameChildren(cards, fb.id)[0];
    expect(pos.get(kidB.id)).toEqual({ x: pb.x + FRAME_PAD, y: FRAME_HEADER + FRAME_PAD });
    const free = cards.find((c) => c.type === "kpis" && !c.frame)!;
    const freePos = pos.get(free.id)!;
    expect(freePos.x).toBe(0);
    expect(freePos.y).toBe(Math.max(pa.h!, pb.h!) + FRAME_GAP);
  });
  it("a frame alone keeps its default size when empty, and the free cards start at 0 without frames", () => {
    const f: MoFrame = { id: "f", type: "frame", title: "X", clientId: "x", clientName: "X", color: "#fff", x: 50, y: 50, w: 1168, h: 320, turn: 0, at: "t" };
    const pos = arrangeCards([f]);
    expect(pos.get("f")).toMatchObject({ x: 0, y: 0, w: CARD_SIZES.frame.w, h: CARD_SIZES.frame.h });
    const note: MoCard = { id: "n", type: "note", title: "n", markdown: "x", x: 40, y: 40, w: 400, h: 300, turn: 0, at: "t" };
    expect(arrangeCards([note]).get("n")).toEqual({ x: 0, y: 0 });
  });
});

describe("« Ranger » en ligne / en colonne", () => {
  const note = (id: string, w: number, h: number, turn = 0): MoCard => ({ id, type: "note", title: id, markdown: "x", x: 900 - w, y: 700 - h, w, h, turn, at: "t" });
  it("puts the free cards on one line, by turn, aligned on top — never wrapped", () => {
    const cards = [note("b", 400, 300, 1), note("a", 600, 200, 0), note("c", 900, 500, 1), note("d", 900, 200, 1)];
    const pos = arrangeCards(cards, 1400, "row");
    expect(pos.get("a")).toEqual({ x: 0, y: 0 });
    expect(pos.get("b")).toEqual({ x: 600 + COL_GAP, y: 0 });
    expect(pos.get("c")).toEqual({ x: 1000 + 2 * COL_GAP, y: 0 });
    expect(pos.get("d")).toEqual({ x: 1900 + 3 * COL_GAP, y: 0 });
  });
  it("puts the free cards in one column, by turn, aligned on the left; a minimised card takes its header's height", () => {
    const cards = [note("b", 400, 300, 1), note("a", 600, 200, 0), { ...note("c", 900, 500, 1), minimized: true } as MoCard, note("d", 300, 100, 2)];
    const pos = arrangeCards(cards, 1400, "column");
    expect(pos.get("a")).toEqual({ x: 0, y: 0 });
    expect(pos.get("b")).toEqual({ x: 0, y: 200 + ROW_GAP });
    expect(pos.get("c")).toEqual({ x: 0, y: 500 + 2 * ROW_GAP });
    expect(pos.get("d")).toEqual({ x: 0, y: 556 + 3 * ROW_GAP });
  });
  it("keeps the frames: in line, each frame's cards in line and the free cards after them", () => {
    let cards = layoutWithFrames([], [kpis("nat", "Naturalia"), kpis("nat", "Naturalia")], 0, "t", ids).cards;
    cards = layoutWithFrames(cards, [creatives("cl", "Cours Legendre"), kpis()], 1, "t", ids).cards;
    cards = cards.map((c) => ({ ...c, x: c.x + 555, y: c.y + 222 })) as MoCard[];
    const pos = arrangeCards(cards, 1400, "row");
    const [fa, fb] = frames(cards);
    const pa = pos.get(fa.id)!, pb = pos.get(fb.id)!;
    const [k1, k2] = frameChildren(cards, fa.id);
    expect(pos.get(k1.id)).toEqual({ x: FRAME_PAD, y: FRAME_HEADER + FRAME_PAD });
    expect(pos.get(k2.id)).toEqual({ x: FRAME_PAD + k1.w + COL_GAP, y: FRAME_HEADER + FRAME_PAD });
    expect(pa).toMatchObject({ x: 0, y: 0, w: Math.max(CARD_SIZES.frame.w, k1.w + COL_GAP + k2.w + 2 * FRAME_PAD), h: FRAME_HEADER + 2 * FRAME_PAD + CARD_SIZES.kpis.h });
    expect(pb).toMatchObject({ x: pa.w! + FRAME_GAP, y: 0 });
    const free = cards.find((c) => c.type === "kpis" && !c.frame)!;
    expect(pos.get(free.id)).toEqual({ x: pa.w! + FRAME_GAP + pb.w! + FRAME_GAP, y: 0 });
  });
  it("keeps the frames: in column, frames stacked, their cards stacked, the free cards under", () => {
    let cards = layoutWithFrames([], [kpis("nat", "Naturalia"), kpis("nat", "Naturalia")], 0, "t", ids).cards;
    cards = layoutWithFrames(cards, [creatives("cl", "Cours Legendre"), kpis()], 1, "t", ids).cards;
    const pos = arrangeCards(cards, 1400, "column");
    const [fa, fb] = frames(cards);
    const pa = pos.get(fa.id)!, pb = pos.get(fb.id)!;
    const [k1, k2] = frameChildren(cards, fa.id);
    expect(pos.get(k2.id)).toEqual({ x: FRAME_PAD, y: FRAME_HEADER + FRAME_PAD + CARD_SIZES.kpis.h + ROW_GAP });
    expect(pa).toMatchObject({ x: 0, y: 0, w: Math.max(CARD_SIZES.frame.w, k1.w + 2 * FRAME_PAD), h: FRAME_HEADER + 2 * FRAME_PAD + 2 * CARD_SIZES.kpis.h + ROW_GAP });
    expect(pb).toMatchObject({ x: 0, y: pa.h! + FRAME_GAP });
    const free = cards.find((c) => c.type === "kpis" && !c.frame)!;
    expect(pos.get(free.id)).toEqual({ x: 0, y: pb.y + pb.h! + FRAME_GAP });
  });
  it("the default stays the masonry", () => {
    const cards = [note("a", 800, 200), note("b", 800, 200)];
    expect(arrangeCards(cards).get("b")).toEqual({ x: 0, y: 200 + ROW_GAP });
    expect(arrangeCards(cards, 1400, "grid").get("b")).toEqual({ x: 0, y: 200 + ROW_GAP });
  });
});
