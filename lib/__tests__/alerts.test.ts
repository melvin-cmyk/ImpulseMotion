import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { computeFromInsight, evaluateRule, prevWindowRange, windowToRange, type ComputedMetrics } from "@/lib/alerts";
import type { MetaAccountInsight } from "@/lib/meta-api";

const NOW = new Date("2026-08-31T10:00:00Z");

describe("alert windows (full days only)", () => {
  it("7d = the 7 full days ending yesterday; previous = the 7 before", () => {
    expect(windowToRange("7d", { now: NOW })).toEqual({ since: "2026-08-24", until: "2026-08-30" });
    expect(prevWindowRange("7d", { now: NOW })).toEqual({ since: "2026-08-17", until: "2026-08-23" });
  });
  it("1d = yesterday only; 30d honours the account timezone", () => {
    expect(windowToRange("1d", { now: NOW })).toEqual({ since: "2026-08-30", until: "2026-08-30" });
    // 23:30 UTC on Aug 31 is already Sept 1 in Johannesburg → yesterday = Aug 31
    expect(windowToRange("30d", { now: new Date("2026-08-31T23:30:00Z"), tz: "Africa/Johannesburg" }).until).toBe("2026-08-31");
  });
});

function insight(over: Partial<MetaAccountInsight>): MetaAccountInsight {
  return {
    account_id: "act_1", spend: "1000", impressions: "10000", clicks: "500", ctr: "5", cpm: "10", frequency: "2",
    actions: [{ action_type: "purchase", value: "20" }], action_values: [], purchase_roas: [], date_start: "", date_stop: "", hasData: true,
    ...over,
  };
}

describe("computeFromInsight", () => {
  it("uses the account conversion event for CPA and flags ROAS unavailable without tracked value / AOV", () => {
    const m = computeFromInsight(insight({ actions: [{ action_type: "lead", value: "40" }, { action_type: "purchase", value: "2" }] }), { conversionEvent: "lead" });
    expect(m.conversions).toBe(40);
    expect(m.cpa).toBe(25);
    expect(m.roasAvailable).toBe(false);
    expect(m.roas).toBe(0);
  });
  it("ROAS from tracked value, or estimated from AOV", () => {
    expect(computeFromInsight(insight({ action_values: [{ action_type: "purchase", value: "3000" }] })).roas).toBe(3);
    const est = computeFromInsight(insight({}), { aov: 50 });
    expect(est.roasAvailable).toBe(true);
    expect(est.roasEstimated).toBe(true);
    expect(est.roas).toBe(1);
  });
});

const metrics = (over: Partial<ComputedMetrics>): ComputedMetrics => ({
  spend: 1000, roas: 2, cpa: 50, ctr: 1, frequency: 2, roasAvailable: true, roasEstimated: false, conversions: 20, ...over,
});

describe("evaluateRule", () => {
  it("skips ROAS rules when revenue is unavailable instead of triggering on 0", () => {
    const r = evaluateRule("roas", "below", 1.5, metrics({ roas: 0, roasAvailable: false }), metrics({}));
    expect(r.triggered).toBe(false);
    expect(r.skipped).toMatch(/ROAS indisponible/);
    const drop = evaluateRule("roas", "drop_pct", 20, metrics({ roas: 1 }), metrics({ roas: 0, roasAvailable: false }));
    expect(drop.triggered).toBe(false);
    expect(drop.skipped).toBeTruthy();
  });
  it("still triggers normal rules", () => {
    expect(evaluateRule("roas", "below", 1.5, metrics({ roas: 1.2 }), metrics({})).triggered).toBe(true);
    expect(evaluateRule("cpa", "above", 40, metrics({ cpa: 50 }), metrics({})).triggered).toBe(true);
    const d = evaluateRule("spend", "drop_pct", 30, metrics({ spend: 500 }), metrics({ spend: 1000 }));
    expect(d.triggered).toBe(true);
    expect(d.value).toBe(-50);
  });
});
