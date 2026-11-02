import { describe, expect, it } from "vitest";
import { classifyTrend, computeScores, spendThreshold } from "@/lib/ads-warehouse/trends";
import { deriveMetrics, type Metrics } from "@/lib/ads-warehouse/query";
import { funnelRows, meetsGoal } from "@/components/analyse-v2/launch-funnel";

const sums = (o: Partial<Record<string, number>>) => ({ spend: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, conversions: 0, conversionValue: 0, purchases: 0, purchaseValue: 0, leads: 0, videoPlays: 0, video3s: 0, thruPlays: 0, p25: 0, p50: 0, p75: 0, p100: 0, ...o });
const m = (o: Partial<Record<string, number>>): Metrics => deriveMetrics(sums(o) as never, null);

describe("classifyTrend", () => {
  const until = "2026-11-01";
  it("detects paused, new, scaling, declining, testing, stable", () => {
    expect(classifyTrend(0, 200, "2026-09-01", until, 100).state).toBe("paused");
    expect(classifyTrend(80, 0, "2026-10-29", until, 100).state).toBe("new");
    expect(classifyTrend(300, 100, "2026-09-01", until, 100).state).toBe("scaling");
    expect(classifyTrend(50, 200, "2026-09-01", until, 100).state).toBe("declining");
    expect(classifyTrend(5, 5, "2026-09-01", until, 100).state).toBe("testing");
    expect(classifyTrend(100, 100, "2026-09-01", until, 100).state).toBe("stable");
  });
  it("reports the week-over-week spend change", () => {
    expect(classifyTrend(150, 100, null, until, 100).wow).toBe(50);
    expect(classifyTrend(150, 0, null, until, 100).wow).toBeNull();
  });
});

describe("spendThreshold", () => {
  it("is two conversions' worth, bounded", () => {
    expect(spendThreshold(m({ spend: 1000, conversions: 10 }))).toBe(200);
    expect(spendThreshold(m({ spend: 100, conversions: 50 }))).toBe(30);
    expect(spendThreshold(m({ spend: 50_000 }))).toBe(500);
  });
});

describe("computeScores", () => {
  it("ranks creatives above the threshold, best = 100, CPA inverted, no conversion = last", () => {
    const entries = [
      { key: "a", metrics: m({ spend: 100, impressions: 10_000, linkClicks: 300, conversions: 10 }) },
      { key: "b", metrics: m({ spend: 100, impressions: 10_000, linkClicks: 100, conversions: 2 }) },
      { key: "c", metrics: m({ spend: 100, impressions: 10_000, linkClicks: 200, conversions: 0 }) },
      { key: "tiny", metrics: m({ spend: 1, impressions: 100, linkClicks: 50, conversions: 1 }) },
    ];
    const bench = m({ spend: 301, impressions: 30_100, linkClicks: 650, conversions: 13 });
    const { scores, goal } = computeScores(entries, 50, bench);
    expect(goal).toBe("cpa");
    expect(scores.get("a")!.clickScore).toBe(100);
    expect(scores.get("b")!.clickScore).toBe(1);
    expect(scores.get("a")!.convertScore).toBe(100);
    expect(scores.get("c")!.convertScore).toBe(1);
    expect(scores.get("tiny")!.clickScore).toBe(0);
    expect(scores.get("a")!.hookScore).toBe(0); // not a video
  });
});

describe("launch funnel", () => {
  const row = (key: string, metrics: Metrics) => ({ key, label: key, adCount: 1, sample: null, ads: [], launch: null, metrics, previous: null, trend: null });
  const rows = [row("a", m({ spend: 500, conversions: 10 })), row("b", m({ spend: 500, conversions: 1 })), row("c", m({ spend: 20, conversions: 2 }))];
  const goal = { metric: "cpa" as const, value: 100, spend: 100 };
  it("filters scaled then winners", () => {
    expect(funnelRows(rows, goal, "launched").map((r) => r.key)).toEqual(["a", "b", "c"]);
    expect(funnelRows(rows, goal, "scaled").map((r) => r.key)).toEqual(["a", "b"]);
    expect(funnelRows(rows, goal, "winners").map((r) => r.key)).toEqual(["a"]);
    expect(meetsGoal(m({ spend: 100 }), goal)).toBe(false);
  });
});

import { detectOpportunity } from "@/lib/ads-warehouse/opportunities";

describe("detectOpportunity (Motion's 4 types)", () => {
  const sc = (hookScore: number, watchScore: number, clickScore: number, convertScore: number) => ({ ...m({ spend: 500 }), hookScore, watchScore, clickScore, convertScore });
  it("picks the earliest weak stage while others hold", () => {
    expect(detectOpportunity(sc(15, 70, 50, 60), { video: true, scaled: true })?.type).toBe("ImproveFirstFrame");
    expect(detectOpportunity(sc(30, 70, 50, 60), { video: true, scaled: true })?.type).toBe("IterateOnHook");
    expect(detectOpportunity(sc(70, 20, 50, 50), { video: true, scaled: true })?.type).toBe("IterateOnBody");
    expect(detectOpportunity(sc(0, 0, 20, 70), { video: false, scaled: true })?.type).toBe("ImproveCTA");
  });
  it("needs budget and at least one strength", () => {
    expect(detectOpportunity(sc(30, 70, 50, 60), { video: true, scaled: false })).toBeNull();
    expect(detectOpportunity(sc(30, 30, 30, 30), { video: true, scaled: true })).toBeNull();
    expect(detectOpportunity(sc(70, 70, 70, 70), { video: true, scaled: true })).toBeNull();
  });
});
