import { describe, it, expect } from "vitest";
import type { Creative } from "@/lib/creative-types";
import {
  aggregate,
  groupBy,
  byFormat,
  byAdset,
  byCampaign,
  byLandingPage,
  byCopy,
  bySegment,
  findSegmentIndex,
  normalizeLandingUrl,
  bestCreative,
  worstCreative,
  median,
  sortGroups,
  NO_URL_KEY,
  NO_COPY_KEY,
  UNCATEGORIZED_KEY,
} from "@/lib/creative-stats";
import { DEFAULT_NAMING_CONFIG } from "@/lib/naming-config";

function make(over: Partial<Creative> & { id: string }): Creative {
  return {
    name: over.id,
    platform: "Meta",
    format: "Image",
    status: "Active",
    thumbnailColor: "from-violet-500 to-purple-700",
    spend: 0,
    roas: 0,
    cpa: 0,
    ctr: 0,
    hookRate: 0,
    holdRate: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    threeSecViews: 0,
    thruplays: 0,
    trend: [],
    ...over,
  };
}

describe("aggregate", () => {
  it("returns nulls on empty input", () => {
    const s = aggregate([]);
    expect(s.count).toBe(0);
    expect(s.ctr).toBeNull();
    expect(s.cpa).toBeNull();
    expect(s.roas).toBeNull();
    expect(s.hookRate).toBeNull();
  });

  it("recomputes ratios from sums, not from averages", () => {
    const a = make({ id: "a", spend: 100, impressions: 10_000, clicks: 100, conversions: 2, revenue: 300 });
    const b = make({ id: "b", spend: 300, impressions: 30_000, clicks: 900, conversions: 6, revenue: 300 });
    const s = aggregate([a, b]);
    expect(s.spend).toBe(400);
    expect(s.ctr).toBe(2.5); // 1000 / 40000
    expect(s.cpa).toBe(50); // 400 / 8
    expect(s.roas).toBe(1.5); // 600 / 400
    expect(s.conversionRate).toBe(0.8); // 8 / 1000
  });

  it("falls back to roas × spend when revenue is absent", () => {
    const s = aggregate([make({ id: "a", spend: 200, roas: 2 })]);
    expect(s.revenue).toBe(400);
    expect(s.roas).toBe(2);
  });

  it("returns null CPA without conversions and null ROAS without spend", () => {
    const s = aggregate([make({ id: "a", spend: 50, impressions: 100, clicks: 3 })]);
    expect(s.cpa).toBeNull();
    expect(aggregate([make({ id: "b", revenue: 10 })]).roas).toBeNull();
  });

  it("weights hook rate by impressions over videos only", () => {
    const v1 = make({ id: "v1", format: "Video", impressions: 1000, hookRate: 10 });
    const v2 = make({ id: "v2", format: "Video", impressions: 3000, hookRate: 30 });
    const img = make({ id: "i", format: "Image", impressions: 100_000, hookRate: 0 });
    const s = aggregate([v1, v2, img]);
    expect(s.hookRate).toBe(25); // (10*1000 + 30*3000) / 4000
    expect(s.videoCount).toBe(2);
    expect(aggregate([img]).hookRate).toBeNull();
  });

  it("flags estimated when any creative has roasEstimated", () => {
    expect(aggregate([make({ id: "a" }), make({ id: "b", roasEstimated: true })]).estimated).toBe(true);
    expect(aggregate([make({ id: "a" })]).estimated).toBe(false);
  });

  it("computes frequency from reach and winners hit rate", () => {
    const s = aggregate([
      make({ id: "a", impressions: 300, reach: 100, status: "Winner" }),
      make({ id: "b", impressions: 100, reach: 100 }),
      make({ id: "c", impressions: 50 }), // no reach → excluded from frequency
    ]);
    expect(s.frequency).toBe(2); // 400 / 200
    expect(s.winners).toBe(1);
    expect(s.hitRate).toBeCloseTo(33.33, 1);
  });
});

describe("groupBy", () => {
  it("sorts by spend desc and pins lastKeys at the end", () => {
    const groups = groupBy(
      [
        make({ id: "a", spend: 10, format: "Image" }),
        make({ id: "b", spend: 500, format: "Carousel" }),
        make({ id: "c", spend: 100, format: "Video" }),
      ],
      (c) => c.format,
      { lastKeys: ["Carousel"] },
    );
    expect(groups.map((g) => g.key)).toEqual(["Video", "Image", "Carousel"]);
  });

  it("byFormat groups and counts", () => {
    const groups = byFormat([make({ id: "a" }), make({ id: "b" }), make({ id: "c", format: "Video" })]);
    expect(groups.find((g) => g.key === "Image")?.stats.count).toBe(2);
  });

  it("byAdset keys on adsetId with adsetName label; unknown last", () => {
    const groups = byAdset([
      make({ id: "a", adsetId: "1", adsetName: "Broad", spend: 1 }),
      make({ id: "b", adsetId: "1", adsetName: "Broad", spend: 1 }),
      make({ id: "c", spend: 999 }),
    ]);
    expect(groups[0].label).toBe("Broad");
    expect(groups[0].stats.count).toBe(2);
    expect(groups.at(-1)?.label).toBe("Adset inconnu");
  });

  it("byCampaign groups by campaignId", () => {
    const groups = byCampaign([
      make({ id: "a", campaignId: "c1", campaignName: "Acq" }),
      make({ id: "b", campaignId: "c1", campaignName: "Acq" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Acq");
  });
});

describe("landing pages", () => {
  it("normalises host/path and strips query, utm, hash, trailing slash", () => {
    const m = normalizeLandingUrl("HTTPS://WWW.Example.com/Nos-Services/?utm_source=fb&x=1#top");
    expect(m).toEqual({ url: "https://example.com/nos-services", host: "example.com", path: "/nos-services" });
    expect(normalizeLandingUrl("example.com/")?.path).toBe("/");
    expect(normalizeLandingUrl("")).toBeNull();
    expect(normalizeLandingUrl(undefined)).toBeNull();
  });

  it("groups equivalent URLs together and puts the unknown bucket last", () => {
    const groups = byLandingPage([
      make({ id: "a", spend: 10, landingUrl: "https://www.shop.fr/menus/?utm_campaign=x" }),
      make({ id: "b", spend: 20, landingUrl: "https://shop.fr/menus" }),
      make({ id: "c", spend: 1000 }),
      make({ id: "d", spend: 5, landingUrl: "https://shop.fr/" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["shop.fr/menus", "shop.fr/", NO_URL_KEY]);
    expect(groups[0].stats.count).toBe(2);
    expect(groups[0].meta.url).toBe("https://shop.fr/menus");
    expect(groups[0].label).toBe("shop.fr/menus");
    expect(groups.at(-1)?.meta.url).toBeNull();
  });
});

describe("copy", () => {
  it("groups by normalised body regardless of whitespace/case", () => {
    const groups = byCopy([
      make({ id: "a", body: "Bonjour   le monde\n\n!", headline: "H1", spend: 1 }),
      make({ id: "b", body: " bonjour le monde ! ", headline: "H1", spend: 2 }),
      make({ id: "c", body: "Autre texte", spend: 3 }),
    ]);
    expect(groups).toHaveLength(2);
    const bonjour = groups.find((g) => g.stats.count === 2)!;
    expect(bonjour.meta.headline).toBe("H1");
    expect(bonjour.meta.body).toContain("Bonjour");
  });

  it("falls back to headline, then the 'Sans texte' bucket pinned last", () => {
    const groups = byCopy([
      make({ id: "a", headline: "Only headline", spend: 1 }),
      make({ id: "b", spend: 9999 }),
    ]);
    expect(groups[0].meta.headlineOnly).toBe(true);
    expect(groups[0].meta.headline).toBe("Only headline");
    expect(groups.at(-1)?.key).toBe(NO_COPY_KEY);
  });

  it("truncates the key at 400 chars", () => {
    const long = "x".repeat(500);
    const groups = byCopy([make({ id: "a", body: long }), make({ id: "b", body: `${long}yyy` })]);
    expect(groups).toHaveLength(1);
  });

  it("picks the most frequent headline within a body group", () => {
    const groups = byCopy([
      make({ id: "a", body: "same", headline: "A" }),
      make({ id: "b", body: "same", headline: "B" }),
      make({ id: "c", body: "same", headline: "B" }),
    ]);
    expect(groups[0].meta.headline).toBe("B");
  });
});

describe("segments", () => {
  it("bySegment parses with the naming config and pins uncategorised last", () => {
    const groups = bySegment(
      [
        make({ id: "a", name: "OMEGA_VIDEO_PROMO", spend: 1 }),
        make({ id: "b", name: "OMEGA_IMAGE_PROMO", spend: 2 }),
        make({ id: "c", name: "nomatch", spend: 1000 }),
      ],
      DEFAULT_NAMING_CONFIG,
      2,
    );
    expect(groups[0].key).toBe("PROMO");
    expect(groups[0].stats.count).toBe(2);
    expect(groups.at(-1)?.key).toBe(UNCATEGORIZED_KEY);
    expect(groups.at(-1)?.label).toBe("Non catégorisé");
  });

  it("returns [] for an out-of-range segment index", () => {
    expect(bySegment([make({ id: "a" })], DEFAULT_NAMING_CONFIG, 9)).toEqual([]);
  });

  it("findSegmentIndex matches label case-insensitively, else last", () => {
    expect(findSegmentIndex(DEFAULT_NAMING_CONFIG, /angle/i)).toBe(2);
    const cfg = { separator: "_", segments: [{ label: "Produit", position: 0 }, { label: "ANGLE marketing", position: 3 }, { label: "Autre", position: 1 }] };
    expect(findSegmentIndex(cfg, /angle/i)).toBe(1);
    expect(findSegmentIndex({ separator: "_", segments: [{ label: "A", position: 0 }, { label: "B", position: 1 }] }, /angle/i)).toBe(1);
    expect(findSegmentIndex({ separator: "_", segments: [] }, /angle/i)).toBe(-1);
  });
});

describe("ranking helpers", () => {
  const a = make({ id: "a", spend: 10, roas: 3, cpa: 20, conversions: 1, ctr: 1 });
  const b = make({ id: "b", spend: 50, roas: 1, cpa: 5, conversions: 2, ctr: 4 });
  const c = make({ id: "c", spend: 5, roas: 0, cpa: 0, conversions: 0, ctr: 0.5 });

  it("bestCreative / worstCreative respect metric direction", () => {
    expect(bestCreative([a, b, c], "roas")?.id).toBe("a");
    expect(worstCreative([a, b, c], "roas")?.id).toBe("c");
    expect(bestCreative([a, b, c], "cpa")?.id).toBe("b");
    expect(worstCreative([a, b, c], "cpa")?.id).toBe("a"); // c excluded (no conversions)
    expect(bestCreative([c], "cpa")).toBeNull();
    expect(bestCreative([], "spend")).toBeNull();
  });

  it("median handles odd/even/empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("sortGroups puts null stats last and sorts CPA ascending when asked", () => {
    const groups = byFormat([
      make({ id: "a", format: "Image", spend: 100, conversions: 1 }),
      make({ id: "b", format: "Video", spend: 50, conversions: 5 }),
      make({ id: "c", format: "Carousel", spend: 200 }),
    ]);
    expect(sortGroups(groups, "cpa", true).map((g) => g.key)).toEqual(["Video", "Image", "Carousel"]);
    expect(sortGroups(groups, "count").map((g) => g.stats.count)).toEqual([1, 1, 1]);
  });
});

// ── Lot F3: account-relative status, weekly frequency, unknown revenue ───────

import {
  accountReference,
  classifyStatus,
  weeklyFrequency,
  revenueUnknown,
  FATIGUE_FREQUENCY_WEEKLY,
} from "@/lib/creative-stats";

describe("weeklyFrequency", () => {
  it("normalises the range frequency to 7 days", () => {
    expect(weeklyFrequency(6, 30)).toBe(1.4);
    expect(weeklyFrequency(2, 7)).toBe(2);
    expect(weeklyFrequency(1.2, 14)).toBe(0.6);
  });
  it("is null without a frequency or a valid range", () => {
    expect(weeklyFrequency(undefined, 30)).toBeNull();
    expect(weeklyFrequency(0, 30)).toBeNull();
    expect(weeklyFrequency(3, 0)).toBeNull();
  });
});

describe("aggregate with unknown revenue", () => {
  it("returns roas null + unavailable when no creative has a known revenue", () => {
    const s = aggregate([
      make({ id: "a", spend: 100, conversions: 2, roas: null, roasUnavailable: true }),
      make({ id: "b", spend: 50, conversions: 1, roas: null, roasUnavailable: true }),
    ]);
    expect(s.roas).toBeNull();
    expect(s.unavailable).toBe(true);
    expect(s.spend).toBe(150);
    expect(s.cpa).toBe(50);
  });
  it("computes roas over the creatives whose revenue is known only", () => {
    const s = aggregate([
      make({ id: "a", spend: 100, revenue: 300 }),
      make({ id: "b", spend: 100, roas: null, roasUnavailable: true }),
    ]);
    expect(s.roas).toBe(3);
    expect(s.unavailable).toBe(false);
  });
  it("revenueUnknown: null roas without revenue is unknown, explicit revenue is known", () => {
    expect(revenueUnknown(make({ id: "a", roas: null }))).toBe(true);
    expect(revenueUnknown(make({ id: "b", roas: null, revenue: 0 }))).toBe(false);
    expect(revenueUnknown(make({ id: "c", roas: 2 }))).toBe(false);
  });
});

describe("accountReference", () => {
  it("sums spend / conversions (Σ then ratio) and derives the significance threshold", () => {
    const rows = [
      make({ id: "a", spend: 1000, conversions: 10, roas: 3 }),
      make({ id: "b", spend: 200, conversions: 1, roas: 1 }),
      make({ id: "c", spend: 100, conversions: 0, roas: null, roasUnavailable: true }),
      make({ id: "d", spend: 0, conversions: 0, roas: null }),
    ];
    const ref = accountReference(rows);
    expect(ref.spend).toBe(1300);
    expect(ref.conversions).toBe(11);
    expect(ref.cpa).toBeCloseTo(1300 / 11, 6);
    // median spend over spend > 0 → [100, 200, 1000] → 200 ; threshold = max(39, 1000)
    expect(ref.medianSpend).toBe(200);
    expect(ref.spendThreshold).toBe(1000);
    // tracked ROAS: (3×1000 + 1×200) / 1200
    expect(ref.roas).toBeCloseTo(3200 / 1200, 6);
  });
  it("ignores estimated / unavailable ROAS in the account ROAS", () => {
    const ref = accountReference([
      make({ id: "a", spend: 100, conversions: 1, roas: 5, roasEstimated: true }),
      make({ id: "b", spend: 100, conversions: 1, roas: null, roasUnavailable: true }),
    ]);
    expect(ref.roas).toBeNull();
    expect(ref.cpa).toBe(100);
  });
});

describe("classifyStatus (relative to the account)", () => {
  // Account: 10 ads of 100 + 1 big ad → spend 2000, 40 conversions → CPA 50, median spend 100 → threshold max(60, 500) = 500
  const base = Array.from({ length: 10 }, (_, i) => make({ id: `s${i}`, spend: 100, conversions: 2, cpa: 50, roas: 2 }));
  const big = make({ id: "big", spend: 1000, conversions: 20, cpa: 50, roas: 2 });
  const rows = [...base, big];
  const ref = accountReference(rows);

  it("threshold = max(3 % of spend, 5 × median spend)", () => {
    expect(ref.spendThreshold).toBe(500);
    expect(ref.cpa).toBe(50);
  });

  it("Winner when significant spend and CPA ≤ 0.8 × account CPA", () => {
    expect(classifyStatus(make({ id: "w", spend: 600, conversions: 20, cpa: 30, roas: 2 }), ref)).toBe("Winner");
  });
  it("Winner when significant spend and tracked ROAS ≥ 1.25 × account ROAS", () => {
    expect(classifyStatus(make({ id: "w", spend: 600, conversions: 10, cpa: 60, roas: 2.6 }), ref)).toBe("Winner");
  });
  it("never uses an estimated or unavailable ROAS", () => {
    expect(classifyStatus(make({ id: "e", spend: 600, conversions: 10, cpa: 60, roas: 9, roasEstimated: true }), ref)).toBe("Active");
    expect(classifyStatus(make({ id: "u", spend: 600, conversions: 10, cpa: 60, roas: null, roasUnavailable: true }), ref)).toBe("Active");
  });
  it("Loser when significant spend and CPA ≥ 1.5 × account CPA", () => {
    expect(classifyStatus(make({ id: "l", spend: 600, conversions: 8, cpa: 75, roas: 1 }), ref)).toBe("Loser");
  });
  it("Loser when no conversion and spend > 3 × account CPA (and significant)", () => {
    expect(classifyStatus(make({ id: "l", spend: 600, conversions: 0, cpa: 0, roas: 0 }), ref)).toBe("Loser");
  });
  it("small spend is never Winner / Loser", () => {
    expect(classifyStatus(make({ id: "t", spend: 100, conversions: 10, cpa: 10, roas: 8 }), ref)).toBe("Active");
    expect(classifyStatus(make({ id: "t", spend: 400, conversions: 0, cpa: 0, roas: 0 }), ref)).toBe("Active");
  });
  it("no Winner / Loser at all when the account has no conversion", () => {
    const noConv = accountReference([make({ id: "a", spend: 1000, conversions: 0 }), make({ id: "b", spend: 10, conversions: 0 })]);
    expect(classifyStatus(make({ id: "a", spend: 1000, conversions: 0, cpa: 0, roas: 0 }), noConv)).toBe("Active");
  });
  it("Fatigued on a low video hook or a high weekly frequency", () => {
    expect(classifyStatus(make({ id: "v", spend: 100, format: "Video", hookRate: 12 }), ref)).toBe("Fatigued");
    expect(classifyStatus(make({ id: "i", spend: 100, format: "Image", hookRate: 0, frequencyWeekly: FATIGUE_FREQUENCY_WEEKLY }), ref)).toBe("Fatigued");
    expect(classifyStatus(make({ id: "ok", spend: 100, format: "Video", hookRate: 30, frequencyWeekly: 1.2 }), ref)).toBe("Active");
  });
  it("Winner beats Fatigued", () => {
    expect(classifyStatus(make({ id: "w", spend: 600, conversions: 20, cpa: 30, roas: 2, format: "Video", hookRate: 10 }), ref)).toBe("Winner");
  });
});
