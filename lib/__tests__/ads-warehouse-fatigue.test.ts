import { describe, expect, it } from "vitest";
import { detectFatigue, fatigueSignals } from "@/lib/ads-warehouse/fatigue";
import { deriveMetrics, type AdsGroupRow, type Metrics } from "@/lib/ads-warehouse/query";

const sums = (o: Partial<Record<string, number>>) => ({ spend: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, conversions: 0, conversionValue: 0, purchases: 0, purchaseValue: 0, leads: 0, videoPlays: 0, video3s: 0, thruPlays: 0, p25: 0, p50: 0, p75: 0, p100: 0, ...o });
const m = (o: Partial<Record<string, number>>): Metrics => deriveMetrics(sums(o) as never, null);
const money = (v: number) => `${Math.round(v)} €`;
const row = (key: string, cur: Metrics, prev: Metrics | null, state: string = "stable"): AdsGroupRow =>
  ({ key, label: key, adCount: 1, sample: null, ads: [], launch: null, metrics: cur, previous: prev, trend: { state, last7: cur.spend, prev7: prev?.spend ?? 0, wow: null } }) as AdsGroupRow;

// Healthy week: CTR 2 %, hook 30 %, CPA 20, frequency 1.25/day.
const healthy = m({ spend: 400, impressions: 20_000, reach: 16_000, linkClicks: 400, video3s: 6000, conversions: 20 });

describe("fatigueSignals", () => {
  it("nothing when the creative holds", () => {
    expect(fatigueSignals(healthy, healthy, { money })).toEqual([]);
  });
  it("CTR, hook, CPA and repetition degradations", () => {
    const tired = m({ spend: 400, impressions: 20_000, reach: 12_000, linkClicks: 240, video3s: 3600, conversions: 12 });
    const ids = fatigueSignals(tired, healthy, { money }).map((s) => s.id);
    expect(ids).toEqual(["ctr", "hook", "cpa", "frequency"]);
  });
  it("ignores small volumes", () => {
    const tiny = m({ spend: 10, impressions: 500, linkClicks: 1 });
    expect(fatigueSignals(tiny, healthy, { money })).toEqual([]);
  });
  it("CPA alone is not fatigue", () => {
    const worse = m({ spend: 400, impressions: 20_000, reach: 16_000, linkClicks: 400, video3s: 6000, conversions: 8 });
    expect(detectFatigue([row("cpa", worse, healthy)], { minSpend: 50, money })).toEqual([]);
  });
  it("no conversion after a converting week is severe", () => {
    const dead = m({ spend: 400, impressions: 20_000, reach: 16_000, linkClicks: 400, video3s: 6000, conversions: 0 });
    const s = fatigueSignals(dead, healthy, { money });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: "cpa", severe: true });
  });
});

describe("detectFatigue", () => {
  const tired = m({ spend: 400, impressions: 20_000, reach: 12_000, linkClicks: 240, video3s: 3600, conversions: 12 });
  const mild = m({ spend: 900, impressions: 20_000, reach: 16_000, linkClicks: 300, video3s: 6000, conversions: 40 }); // CTR -25 % only
  it("keeps 2+ signals or a severe one, ranks by budget at stake, skips paused / small / no history", () => {
    const hits = detectFatigue([
      row("a", tired, healthy),
      row("mild", mild, healthy),
      row("paused", tired, healthy, "paused"),
      row("small", m({ ...{ spend: 10, impressions: 20_000, reach: 12_000, linkClicks: 240 } }), healthy),
      row("new", tired, null),
    ], { minSpend: 50, money });
    expect(hits.map((h) => h.row.key)).toEqual(["a"]);
    expect(hits[0].verdict).toBe("replace");
  });
  it("limits to 3", () => {
    const rows = ["a", "b", "c", "d"].map((k) => row(k, tired, healthy));
    expect(detectFatigue(rows, { minSpend: 50, money })).toHaveLength(3);
  });
});
