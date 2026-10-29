/**
 * lib/mo/last-page — back on /mo, the page opened last reopens (if it still
 * exists and is not archived) with its camera of last time.
 */

import { describe, expect, it } from "vitest";
import { MAX_SAVED_VIEWS, isValidView, lastPageKey, livePageIds, parseViews, startPageId, viewOf, viewsKey, withView } from "@/lib/mo/last-page";
import type { MoPageSummary, MoPages } from "@/lib/mo/pages";

const page = (id: string, kind: MoPageSummary["kind"] = "free"): MoPageSummary => ({ id, title: id, kind, clientId: null, updatedAt: "2026-10-29T10:00:00Z", cards: 1, archived: false, position: 0 });
const pages: MoPages = { home: page("home1", "home"), client: [page("cli1", "client")], free: [page("free1"), page("free2")] };

describe("startPageId", () => {
  it("opens the deep link first, then the last page, then « Aujourd'hui »", () => {
    expect(startPageId(pages, "free2", "cli1")).toBe("free2");
    expect(startPageId(pages, null, "cli1")).toBe("cli1");
    expect(startPageId(pages, null, "free1")).toBe("free1");
    expect(startPageId(pages, null, null)).toBe("home1");
  });
  it("falls back to « Aujourd'hui » when the last page is gone or archived (not listed)", () => {
    expect(startPageId(pages, null, "deleted")).toBe("home1");
    expect(startPageId(pages, null, "")).toBe("home1");
    expect([...livePageIds(pages)].sort()).toEqual(["cli1", "free1", "free2", "home1"]);
  });
  it("keys the storage by the person's home board", () => {
    expect(lastPageKey("home1")).toBe("mo:last-page:home1");
    expect(viewsKey("home1")).toBe("mo:views:home1");
    expect(lastPageKey("home2")).not.toBe(lastPageKey("home1"));
  });
});

describe("saved cameras", () => {
  it("validates a camera", () => {
    expect(isValidView({ x: 10, y: -20, k: 1 })).toBe(true);
    for (const bad of [null, {}, { x: 1, y: 1 }, { x: NaN, y: 0, k: 1 }, { x: 0, y: 0, k: 0 }, { x: 0, y: 0, k: 9 }, { x: "1", y: 0, k: 1 }, { x: 1e9, y: 0, k: 1 }]) expect(isValidView(bad), JSON.stringify(bad)).toBe(false);
  });
  it("parses the stored JSON, dropping what is malformed", () => {
    expect(parseViews(null)).toEqual({});
    expect(parseViews("not json")).toEqual({});
    expect(parseViews("[1,2]")).toEqual({});
    expect(parseViews(JSON.stringify({ a: { x: 1, y: 2, k: 0.5, at: 5 }, b: { x: 1 }, c: { x: 3, y: 4, k: 1 } }))).toEqual({ a: { x: 1, y: 2, k: 0.5, at: 5 }, c: { x: 3, y: 4, k: 1, at: 0 } });
  });
  it("sets a page's camera (rounded) and reads it back", () => {
    const v = withView({}, "p1", { x: 10.4, y: -3.6, k: 0.83333 }, 100);
    expect(v).toEqual({ p1: { x: 10, y: -4, k: 0.833, at: 100 } });
    expect(viewOf(v, "p1")).toEqual({ x: 10, y: -4, k: 0.833 });
    expect(viewOf(v, "p2")).toBeNull();
    expect(withView(v, "p2", { x: 0, y: 0, k: 99 }, 200)).toBe(v);
    expect(parseViews(JSON.stringify(withView(v, "p1", { x: 1, y: 1, k: 1 }, 300)))).toEqual({ p1: { x: 1, y: 1, k: 1, at: 300 } });
  });
  it("keeps only the most recently seen pages", () => {
    let v = {};
    for (let i = 0; i < MAX_SAVED_VIEWS + 5; i++) v = withView(v, `p${i}`, { x: i, y: 0, k: 1 }, i);
    expect(Object.keys(v)).toHaveLength(MAX_SAVED_VIEWS);
    expect(viewOf(v, "p0")).toBeNull();
    expect(viewOf(v, `p${MAX_SAVED_VIEWS + 4}`)).toEqual({ x: MAX_SAVED_VIEWS + 4, y: 0, k: 1 });
  });
});
