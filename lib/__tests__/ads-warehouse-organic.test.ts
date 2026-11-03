import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/meta-api", () => ({ getMetaSystemToken: () => "t", metaGraphGet: vi.fn() }));
vi.mock("@/lib/meta-comments", () => ({ pageToken: vi.fn() }));
import { igKind, kindOf, median, shapeIgPosts, shapePosts } from "@/lib/ads-warehouse/organic";

const post = (id: string, reach: number, eng: number, extra: Record<string, unknown> = {}) => ({
  id, created_time: "2026-10-01T00:00:00+0000", reactions: { summary: { total_count: eng } }, comments: { summary: { total_count: 0 } }, shares: { count: 0 },
  insights: { data: [
    { name: "post_total_media_view_unique", period: "lifetime", values: [{ value: reach }] },
    { name: "post_total_media_view_unique", period: "day", values: [{ value: 0 }, { value: 0 }] },
  ] },
  ...extra,
});

describe("organic", () => {
  it("median", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("kindOf", () => {
    expect(kindOf({ attachments: { data: [{ media_type: "video" }] } })).toBe("video");
    expect(kindOf({ status_type: "added_photos" })).toBe("photo");
    expect(kindOf({ status_type: "mobile_status_update" })).toBe("text");
  });
  it("keeps the lifetime metric over the per-day duplicate", () => {
    expect(shapePosts([post("a", 1000, 10)], { id: "p", name: "P" })[0].reach).toBe(1000);
  });
  it("flags posts ≥ 1.5× the median, not promoted, reach not marginal", () => {
    const out = shapePosts([
      post("a", 1000, 10), post("b", 1000, 10), post("c", 1000, 10),
      post("hot", 1000, 30), post("promo", 1000, 30, { promotion_status: "active" }), post("tiny", 50, 20),
    ], { id: "p", name: "P" });
    const by = Object.fromEntries(out.map((p) => [p.id, p]));
    expect(by.hot.suggest).toBe(true);
    expect(by.promo.suggest).toBe(false);
    expect(by.promo.promoted).toBe(true);
    expect(by.tiny.suggest).toBe(false);
    expect(by.tiny.vsMedian).toBeNull();
    expect(by.a.suggest).toBe(false);
  });
});

describe("organic instagram", () => {
  it("igKind", () => {
    expect(igKind({ media_type: "VIDEO" })).toBe("video");
    expect(igKind({ media_type: "CAROUSEL_ALBUM" })).toBe("carousel");
    expect(igKind({ media_type: "IMAGE" })).toBe("photo");
  });
  it("shapeIgPosts: engagement = likes + comments + shares + saves, thumbnail for videos", () => {
    const [p] = shapeIgPosts([{ id: "m", media_type: "VIDEO", like_count: 10, comments_count: 2, thumbnail_url: "https://t", media_url: "https://v", insights: { data: [
      { name: "reach", values: [{ value: 200 }] }, { name: "views", values: [{ value: 300 }] }, { name: "shares", values: [{ value: 3 }] }, { name: "saved", values: [{ value: 5 }] },
    ] } }], { id: "ig", name: "@x" });
    expect(p.platform).toBe("instagram");
    expect(p.engagement).toBe(20);
    expect(p.engagementRate).toBeCloseTo(0.1);
    expect(p.picture).toBe("https://t");
    expect(p.views).toBe(300);
  });
});
