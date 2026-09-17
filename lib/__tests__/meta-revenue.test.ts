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

  it("an account with no conversions and no AOV is unavailable, not a real zero", () => {
    // Reporting a plain 0 here is what showed "0,00x" in red on the client
    // dashboard while Analyse Ads showed "—" for the very same account.
    const r = computeRevenue({ ...base, actions: [] });
    expect(r).toEqual({ revenue: 0, estimated: true, unavailable: true });
  });

  it("0 conversions under a configured AOV is a real zero", () => {
    expect(computeRevenue({ ...base, actions: [] }, 50)).toEqual({ revenue: 0, estimated: true });
  });

  it("honours the account conversion event instead of assuming purchase", () => {
    // Lead-gen account: AOV 50, 100 leads, zero purchases.
    const leadGen = { ...base, actions: [{ action_type: "lead", value: "100" }] };
    expect(computeRevenue(leadGen, 50, "lead")).toEqual({ revenue: 5000, estimated: true });
    // Default (purchase) sees nothing to estimate from.
    expect(computeRevenue(leadGen, 50)).toEqual({ revenue: 0, estimated: true });
    expect(computeRevenue(leadGen, 50, "custom:signup")).toEqual({ revenue: 0, estimated: true });
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
