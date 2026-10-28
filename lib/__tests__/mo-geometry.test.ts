import { describe, expect, it } from "vitest";
import { arrangeCards, fitView, linkAnchors, linkPath, resizeRect, snapMove, snapToGrid, topZ } from "@/lib/mo/geometry";
import { layoutNewCards, type MoCard } from "@/lib/mo/model";

const note = (id: string, x: number, y: number, w = 400, h = 300, turn = 0, extra: Partial<MoCard> = {}): MoCard =>
  ({ id, type: "note", title: id, markdown: "x", x, y, w, h, turn, at: "t", ...extra } as MoCard);

describe("geometry — snapping", () => {
  it("snaps to the grid when no neighbour is close", () => {
    expect(snapToGrid(27)).toBe(20);
    expect(snapToGrid(31)).toBe(40);
    const r = snapMove({ x: 27, y: 33, w: 100, h: 100 }, [], 8);
    expect(r).toEqual({ x: 20, y: 40, guides: [] });
  });
  it("aligns with a neighbour's edge and reports the guide", () => {
    const other = { x: 500, y: 0, w: 200, h: 100 };
    // Moving rect's right edge 6 px from the neighbour's left edge → snaps, one vertical guide at x = 500.
    const r = snapMove({ x: 294, y: 300, w: 200, h: 100 }, [other], 8);
    expect(r.x).toBe(300);
    expect(r.guides.find((g) => g.axis === "x")?.pos).toBe(500);
    // Top aligned with the neighbour's top when within tolerance.
    const t = snapMove({ x: 1000, y: 5, w: 200, h: 100 }, [other], 8);
    expect(t.y).toBe(0);
    expect(t.guides.find((g) => g.axis === "y")?.pos).toBe(0);
  });
  it("grid can be disabled (Alt held)", () => {
    expect(snapMove({ x: 27, y: 33, w: 10, h: 10 }, [], 8, null)).toEqual({ x: 27, y: 33, guides: [] });
  });
});

describe("geometry — resize", () => {
  const start = { x: 100, y: 100, w: 400, h: 300 };
  it("grows from the south-east and keeps the origin", () => {
    expect(resizeRect(start, "se", 37, 23, "note")).toEqual({ x: 100, y: 100, w: 440, h: 320 });
  });
  it("shrinks from the north-west, keeps the far edges, respects the minimum", () => {
    expect(resizeRect(start, "nw", 50, 50, "note")).toEqual({ x: 140, y: 140, w: 360, h: 260 });
    const tiny = resizeRect(start, "nw", 1000, 1000, "note");
    expect(tiny.w).toBe(260); expect(tiny.h).toBe(160);
    expect(tiny.x + tiny.w).toBe(500); expect(tiny.y + tiny.h).toBe(400);
  });
});

describe("geometry — arrange and layout", () => {
  it("wraps a turn's cards into rows and stacks turns", () => {
    const cards = [note("a", 0, 0, 640, 300, 0), note("b", 0, 0, 640, 200, 0), note("c", 0, 0, 640, 300, 0), note("d", 0, 0, 400, 100, 1)];
    const pos = arrangeCards(cards, 1400);
    expect(pos.get("a")).toEqual({ x: 0, y: 0 });
    expect(pos.get("b")).toEqual({ x: 680, y: 0 });
    expect(pos.get("c")?.x).toBe(0);
    expect(pos.get("c")!.y).toBeGreaterThan(300);
    expect(pos.get("d")!.y).toBeGreaterThan(pos.get("c")!.y + 300);
  });
  it("new turns wrap at 1400 px and land on top of the stack", () => {
    const existing = [note("old", 0, 0, 400, 300, 0, { z: 5 })];
    const out = layoutNewCards(existing, { say: "", cards: [
      { type: "table", title: "t1", columns: ["a"], rows: [] }, { type: "table", title: "t2", columns: ["a"], rows: [] }, { type: "table", title: "t3", columns: ["a"], rows: [] },
    ] }, 1, "t");
    expect(out[0].z).toBe(6); expect(out[2].z).toBe(8);
    expect(out[2].x).toBe(0);
    expect(out[2].y).toBeGreaterThan(out[0].y);
  });
});

describe("geometry — fit and links", () => {
  it("fits with clamped zoom and refuses empty rects", () => {
    expect(fitView([], 800, 600, 40, 0.5, 1)).toBeNull();
    expect(fitView([{ x: 0, y: 0, w: 0, h: 0 }], 800, 600, 40, 0.5, 1)).toBeNull();
    const v = fitView([{ x: 0, y: 0, w: 4000, h: 300 }], 800, 600, 40, 0.5, 1)!;
    expect(v.k).toBe(0.5);
    const small = fitView([{ x: 100, y: 100, w: 200, h: 100 }], 800, 600, 40, 0.5, 1)!;
    expect(small.k).toBe(1);
    expect(small.x).toBe((800 - 200) / 2 - 100);
  });
  it("links leave from the facing edges", () => {
    const l = linkAnchors({ x: 0, y: 0, w: 100, h: 100 }, { x: 300, y: 20, w: 100, h: 100 });
    expect(l.horizontal).toBe(true);
    expect(l.a).toEqual({ x: 100, y: 50 }); expect(l.b).toEqual({ x: 300, y: 70 });
    const v = linkAnchors({ x: 0, y: 0, w: 100, h: 100 }, { x: 10, y: 400, w: 100, h: 100 });
    expect(v.horizontal).toBe(false);
    expect(v.a).toEqual({ x: 50, y: 100 });
    expect(linkPath(l)).toMatch(/^M 100 50 C 200 50, 200 70, 300 70$/);
  });
  it("topZ", () => { expect(topZ([{ z: 2 }, {}, { z: 9 }])).toBe(9); expect(topZ([])).toBe(0); });
});
