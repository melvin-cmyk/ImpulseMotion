import { describe, it, expect } from "vitest";
import { computeRevenue, computeRoas, DEFAULT_AOV } from "@/lib/meta-api";

const base = { spend: "100" };

describe("computeRevenue", () => {
  it("prefers tracked action_values over everything", () => {
    const r = computeRevenue({
      ...base,
      actions: [{ action_type: "purchase", value: "10" }],
      action_values: [{ action_type: "omni_purchase", value: "543.21" }],
      purchase_roas: [{ action_type: "omni_purchase", value: "9" }],
    });
    expect(r).toEqual({ revenue: 543.21, estimated: false });
  });

  it("falls back to purchase_roas × spend when no action_values", () => {
    const r = computeRevenue({
      ...base,
      actions: [{ action_type: "purchase", value: "10" }],
      purchase_roas: [{ action_type: "omni_purchase", value: "3.5" }],
    });
    expect(r).toEqual({ revenue: 350, estimated: false });
  });

  it("never invents revenue with a default AOV: no value + no AOV → unavailable", () => {
    const r = computeRevenue({
      ...base,
      actions: [{ action_type: "purchase", value: "10" }],
    });
    expect(r).toEqual({ revenue: 0, estimated: true, unavailable: true });
    expect(computeRevenue({ ...base, actions: [{ action_type: "purchase", value: "10" }] }, 0)).toMatchObject({ unavailable: true });
    expect(computeRevenue({ ...base, actions: [{ action_type: "purchase", value: "10" }] }, null)).toMatchObject({ unavailable: true });
    expect(DEFAULT_AOV).toBe(20); // constant kept for compat, no longer applied implicitly
  });

  it("estimates purchases × AOV only when an AOV is explicitly configured, flagged", () => {
    const r = computeRevenue({ ...base, actions: [{ action_type: "purchase", value: "10" }] }, DEFAULT_AOV);
    expect(r).toEqual({ revenue: 200, estimated: true });
  });

  it("uses a custom AOV when provided", () => {
    const r = computeRevenue({ ...base, actions: [{ action_type: "purchase", value: "4" }] }, 55);
    expect(r).toEqual({ revenue: 220, estimated: true });
  });

  it("returns zero, non-estimated semantics for accounts with no purchases", () => {
    const r = computeRevenue({ ...base, actions: [] });
    expect(r.revenue).toBe(0);
  });
});

describe("computeRoas", () => {
  const insight = {
    ad_id: "1", ad_name: "a", adset_id: "1", campaign_id: "1",
    spend: "200", impressions: "1000", clicks: "10", ctr: "1", cpc: "1", cpm: "1",
    date_start: "2026-01-01", date_stop: "2026-01-31",
    action_values: [{ action_type: "purchase", value: "600" }],
  };
  it("computes revenue/spend from tracked value", () => {
    expect(computeRoas(insight)).toBe(3);
  });
  it("returns 0 on zero spend", () => {
    expect(computeRoas({ ...insight, spend: "0" })).toBe(0);
  });
});
