import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { aggregateInsights, describeFilter, filterEntities, parseFilter, validateFilter, validateRuleInput } from "@/lib/alert-entities";
import { parseProposal, parseVerdict, renderSnapshot } from "@/lib/alert-ai";
import { metricsFromGoogle, sumMetrics } from "@/lib/alert-google";
import type { ComputedMetrics } from "@/lib/alerts";

const cm = (o: Partial<ComputedMetrics>): ComputedMetrics => ({ spend: 0, roas: 0, cpa: 0, ctr: 0, frequency: 0, roasAvailable: false, roasEstimated: false, conversions: 0, ...o });

describe("alert filters", () => {
  it("validates and parses filters", () => {
    expect(validateFilter({ nameContains: " UGC ", minSpend: "50" })).toEqual({ ok: true, value: { nameContains: "UGC", minSpend: 50 } });
    expect(validateFilter({ minSpend: -1 }).ok).toBe(false);
    expect(parseFilter("{bad")).toEqual({});
    expect(describeFilter({ nameContains: "UGC", minSpend: 50 })).toBe("nom contient « UGC » · dépense ≥ 50");
  });
  it("filters entities by name and minimum spend", () => {
    const ents = [
      { name: "UGC v1", current: { spend: 120 } },
      { name: "Static A", current: { spend: 300 } },
      { name: "ugc v2", current: { spend: 10 } },
    ];
    expect(filterEntities(ents, { nameContains: "ugc" }).map((e) => e.name)).toEqual(["UGC v1", "ugc v2"]);
    expect(filterEntities(ents, { minSpend: 100 }).map((e) => e.name)).toEqual(["UGC v1", "Static A"]);
  });
});

describe("validateRuleInput", () => {
  it("accepts a classic rule with level and filter", () => {
    const r = validateRuleInput({ metric: "cpa", condition: "above", threshold: 30, window: "7d", level: "ad", filter: { minSpend: 200 }, label: "CPA créas" });
    expect(r).toMatchObject({ ok: true, data: { metric: "cpa", condition: "above", threshold: 30, level: "ad", filterJson: '{"minSpend":200}', label: "CPA créas" } });
  });
  it("turns an ai rule into placeholders and requires a prompt", () => {
    const ok = validateRuleInput({ mode: "ai", prompt: "Une créa prend plus de 40 % du budget", window: "7d" });
    expect(ok).toMatchObject({ ok: true, data: { mode: "ai", metric: "ai", condition: "ai", threshold: 0, level: "ad" } });
    expect(validateRuleInput({ mode: "ai" }).ok).toBe(false);
  });
  it("rejects unknown levels/metrics and allows partial patches", () => {
    expect(validateRuleInput({ level: "creative", metric: "cpa", condition: "above", threshold: 1 }).ok).toBe(false);
    expect(validateRuleInput({ metric: "nope", condition: "above", threshold: 1 }).ok).toBe(false);
    expect(validateRuleInput({ threshold: 5 }, { partial: true })).toEqual({ ok: true, data: { threshold: 5 } });
  });
});

describe("aggregateInsights", () => {
  it("sums ad rows into an adset-level insight", () => {
    const agg = aggregateInsights([
      { ad_id: "1", ad_name: "a", adset_id: "s", campaign_id: "c", spend: "10", impressions: "1000", clicks: "20", reach: "500", ctr: "2", cpc: "0.5", cpm: "10", actions: [{ action_type: "purchase", value: "1" }], date_start: "d", date_stop: "d" },
      { ad_id: "2", ad_name: "b", adset_id: "s", campaign_id: "c", spend: "30", impressions: "3000", clicks: "30", reach: "1000", ctr: "1", cpc: "1", cpm: "10", actions: [{ action_type: "purchase", value: "2" }], date_start: "d", date_stop: "d" },
    ]);
    expect(agg.spend).toBe("40");
    expect(agg.impressions).toBe("4000");
    expect(Number(agg.ctr)).toBeCloseTo(1.25);
    expect(Number(agg.frequency)).toBeCloseTo(4000 / 1500);
    expect(agg.actions).toEqual([{ action_type: "purchase", value: "3" }]);
  });
});

describe("alert AI parsing", () => {
  it("parses a classic proposal and an ai proposal", () => {
    const rule = parseProposal('```json\n{"mode":"rule","label":"CPA créas","level":"ad","metric":"cpa","condition":"above","threshold":30,"window":"7d","filter":{"minSpend":200},"explanation":"ok"}\n```');
    expect(rule).toMatchObject({ mode: "rule", level: "ad", metric: "cpa", condition: "above", threshold: 30, filter: { minSpend: 200 } });
    const ai = parseProposal('{"mode":"ai","label":"Part de budget","prompt":"Une créa dépasse 40 % de la dépense du compte","level":"account","window":"7d"}');
    expect(ai).toMatchObject({ mode: "ai", level: "ad", window: "7d" });
    expect(() => parseProposal('{"mode":"rule","metric":"vues","condition":"above","threshold":1}')).toThrow(/métrique/);
  });
  it("parses a verdict and renders a snapshot", () => {
    const v = parseVerdict('```json\n{"triggered":true,"message":"La créa X dépense 210 € pour 2 conversions","entities":[{"name":"X","level":"ad","value":210}]}\n```');
    expect(v.triggered).toBe(true);
    expect(v.entities[0]).toEqual({ name: "X", level: "ad", value: 210 });
    expect(() => parseVerdict("rien")).toThrow();
    const text = renderSnapshot({
      accountLabel: "LPEV", platform: "meta", window: "7d", range: { since: "2026-09-15", until: "2026-09-21" }, compare: { since: "2026-09-08", until: "2026-09-14" },
      account: { current: cm({ spend: 1000, conversions: 20, cpa: 50 }), previous: cm({ spend: 900 }) },
      groups: [
        { title: "Campagnes", limit: 15, entities: [{ id: "c", name: "Brand", level: "campaign", current: cm({ spend: 600 }), previous: cm({ spend: 500 }) }] },
        { title: "Créas", limit: 25, entities: [{ id: "a", name: "UGC v3", level: "ad", current: cm({ spend: 210, conversions: 2, cpa: 105 }), previous: cm({}) }] },
      ],
    });
    expect(text).toContain("COMPTE META ADS : LPEV");
    expect(text).toContain("TOTAL COMPTE : dép 1000");
    expect(text).toContain("CRÉAS (1, top 1 par dépense)");
    expect(text).toContain("- UGC v3 : dép 210 · conv 2 · CPA 105");
  });
});

describe("google metrics", () => {
  it("converts a GAQL metrics row (micros, ratio ctr, conversion value) into ComputedMetrics", () => {
    const m = metricsFromGoogle({ costMicros: "545019246", clicks: "432", impressions: "3676", conversions: 12, conversionsValue: 1500, ctr: 0.117519 });
    expect(m).toMatchObject({ spend: 545, conversions: 12, cpa: 45.42, ctr: 11.75, roasAvailable: true, roas: 2.75, frequency: 0 });
    expect(metricsFromGoogle({ costMicros: "1000000", conversions: 0 }).roasAvailable).toBe(false);
  });
  it("sums segment rows and recomputes ctr", () => {
    const s = sumMetrics([{ costMicros: "1000000", clicks: 10, impressions: 100, conversions: 1, conversionsValue: 0 }, { costMicros: "3000000", clicks: 30, impressions: 300, conversions: 2, conversionsValue: 50 }]);
    expect(s).toMatchObject({ costMicros: 4000000, clicks: 40, impressions: 400, conversions: 3, conversionsValue: 50, ctr: 0.1 });
    expect(sumMetrics([])).toBeNull();
  });
  it("rejects a Meta-only level or metric on google and picks platform levels in proposals", () => {
    expect(validateRuleInput({ platform: "google", level: "ad", metric: "spend", condition: "above", threshold: 1 }).ok).toBe(false);
    expect(validateRuleInput({ platform: "google", metric: "frequency", condition: "above", threshold: 1 }).ok).toBe(false);
    expect(validateRuleInput({ platform: "google", level: "keyword", metric: "cpa", condition: "above", threshold: 20 }).ok).toBe(true);
    const p = parseProposal('{"mode":"rule","platform":"google","level":"keyword","metric":"spend","condition":"above","threshold":100,"window":"7d","label":"Mots-clés > 100"}');
    expect(p).toMatchObject({ platform: "google", level: "keyword" });
    const ai = parseProposal('{"mode":"ai","prompt":"x y z","level":"account","window":"7d"}', "google");
    expect(ai).toMatchObject({ platform: "google", level: "keyword" });
  });
});
