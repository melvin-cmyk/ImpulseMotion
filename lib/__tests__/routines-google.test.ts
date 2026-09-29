/**
 * Routines — google.insights: the GAQL is built from closed lists, the account
 * comes from the routine, micros become units. The relay is a stand-in.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const relayDirectTool = vi.hoisted(() => vi.fn());
vi.mock("@/lib/relay-tool", () => ({ relayDirectTool }));
// lib/dashboard-widgets.ts (extractRows, costFrom) opens the database on import.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  GOOGLE_LEVELS, GOOGLE_METRICS, GOOGLE_WINDOWS, buildGaql, cleanCustomerId, googleInsightsHandler, toInsightRow, windowRange,
} from "@/lib/routines/steps/google-insights";
import type { GoogleInsightsStep, StepContext } from "@/lib/routines/types";

const routine: StepContext["routine"] = { id: "r1", name: "Test", metaAccountId: null, googleCustomerId: "601-046-9196", timezone: "Europe/Paris", maxItemsPerRun: 20 };
const NOW = new Date("2026-09-29T08:00:00Z");
function context(over: Partial<StepContext["routine"]> = {}): StepContext {
  return {
    mode: "dry_run", routine: { ...routine, ...over }, runId: "run1", now: NOW, deadlineAt: Date.now() + 60_000,
    input: null, outputs: {}, write: null,
    claimItem: async () => { throw new Error("une lecture ne réserve pas d'élément"); },
    settleItem: async () => { throw new Error("une lecture ne solde pas d'élément"); },
  };
}
const step: GoogleInsightsStep = { id: "gads", type: "google.insights", level: "campaign", window: "7d", metrics: ["spend", "conversions", "cpa", "roas", "ctr"] };
const sentQuery = (call = 0) => JSON.parse((relayDirectTool.mock.calls[call][1] as { input: string }).input) as { customer_id: string; gaql_query: string };

// Everything a query may be made of: fixed words, fields of the closed lists, two dates, one limit.
const GAQL_SHAPE = /^SELECT (?:(?:customer|campaign|metrics)\.[a-z_]+(?:, )?)+ FROM (?:customer|campaign) WHERE segments\.date BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'(?: AND metrics\.impressions > 0 ORDER BY metrics\.cost_micros DESC LIMIT 500)?$/;

beforeEach(() => { relayDirectTool.mockReset(); });

describe("google.insights — GAQL", () => {
  it("never filters on the campaign status: a paused campaign that spent must appear", () => {
    for (const level of GOOGLE_LEVELS) for (const window of GOOGLE_WINDOWS) {
      const gaql = buildGaql(level, [...GOOGLE_METRICS], windowRange(window, "Europe/Paris", NOW));
      expect(gaql).toMatch(GAQL_SHAPE);
      expect(gaql).not.toMatch(/status\s*(=|IN|!=)/i);
      expect(gaql).not.toMatch(/ENABLED|PAUSED|REMOVED/);
      expect(gaql.split(" WHERE ")[1]).not.toContain("campaign.");
    }
    const campaign = buildGaql("campaign", ["spend"], { since: "2026-09-22", until: "2026-09-28" });
    expect(campaign).toBe("SELECT campaign.id, campaign.name, campaign.status, customer.currency_code, metrics.cost_micros, metrics.impressions FROM campaign WHERE segments.date BETWEEN '2026-09-22' AND '2026-09-28' AND metrics.impressions > 0 ORDER BY metrics.cost_micros DESC LIMIT 500");
  });

  it("selects the fields the metrics need, and nothing else", () => {
    expect(buildGaql("account", ["roas"], { since: "2026-09-01", until: "2026-09-28" }))
      .toBe("SELECT customer.id, customer.descriptive_name, customer.currency_code, metrics.cost_micros, metrics.impressions, metrics.conversions_value FROM customer WHERE segments.date BETWEEN '2026-09-01' AND '2026-09-28'");
    expect(buildGaql("account", ["ctr", "cpa"], { since: "2026-09-01", until: "2026-09-28" })).toContain("metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM");
  });

  it("refuses anything outside the closed lists", () => {
    const range = { since: "2026-09-22", until: "2026-09-28" };
    const free = "spend FROM campaign WHERE campaign.status = 'ENABLED' --";
    expect(() => buildGaql("campaign", [free as "spend"], range)).toThrow();
    expect(() => buildGaql("ad_group; DROP" as "campaign", ["spend"], range)).toThrow();
    expect(() => buildGaql("campaign", ["spend"], { since: "2026-09-22' OR '1'='1", until: "2026-09-28" })).toThrow();
    expect(() => buildGaql("campaign", ["spend"], { since: "2026-09-22", until: "hier" })).toThrow();
  });

  it("reads full days ending yesterday, in the routine's timezone", () => {
    expect(windowRange("yesterday", "Europe/Paris", NOW)).toEqual({ since: "2026-09-28", until: "2026-09-28" });
    expect(windowRange("7d", "Europe/Paris", NOW)).toEqual({ since: "2026-09-22", until: "2026-09-28" });
    expect(windowRange("30d", "Europe/Paris", NOW)).toEqual({ since: "2026-08-30", until: "2026-09-28" });
    expect(windowRange("month_to_date", "Europe/Paris", NOW)).toEqual({ since: "2026-09-01", until: "2026-09-28" });
    // 23:30 UTC on the 28th is already the 29th in Paris.
    expect(windowRange("yesterday", "Europe/Paris", new Date("2026-09-28T23:30:00Z")).until).toBe("2026-09-28");
    expect(windowRange("yesterday", "America/New_York", new Date("2026-09-29T02:00:00Z")).until).toBe("2026-09-27");
  });
});

describe("google.insights — validation", () => {
  it("accepts the closed lists and rebuilds the step", () => {
    expect(googleInsightsHandler.validate({ ...step, metrics: ["spend", "spend", "cpa"] })).toEqual({ ok: true, step: { ...step, metrics: ["spend", "cpa"] } });
  });

  it("refuses free text, an account and any unknown field", () => {
    for (const bad of [
      { ...step, level: "ad_group" }, { ...step, level: "campaign WHERE 1=1" }, { ...step, window: "90d" }, { ...step, window: "2026-01-01..2026-02-01" },
      { ...step, metrics: [] }, { ...step, metrics: ["cpm"] }, { ...step, metrics: ["metrics.cost_micros"] }, { ...step, metrics: "spend" },
      { ...step, gaql: "SELECT campaign.id FROM campaign" }, { ...step, query: "x" }, { ...step, where: "campaign.status = 'ENABLED'" },
      { ...step, customerId: "1234567890" }, { ...step, googleCustomerId: "1234567890" }, { ...step, nameContains: "promo" },
    ]) expect(googleInsightsHandler.validate(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it("reads a customer id with or without dashes", () => {
    expect(cleanCustomerId("601-046-9196")).toBe("6010469196");
    expect(cleanCustomerId(" 6010469196 ")).toBe("6010469196");
    for (const bad of [null, undefined, "", "abc", "123", "6010469196 OR 1=1", "601_046_9196", 6010469196]) expect(cleanCustomerId(bad)).toBeNull();
  });
});

describe("google.insights — run", () => {
  it("queries the routine's account and converts micros into units", async () => {
    relayDirectTool.mockResolvedValue([{ results: [
      { campaign: { id: "11", name: "Marque", status: "PAUSED" }, customer: { currencyCode: "EUR" }, metrics: { costMicros: "123456789", impressions: "2000", clicks: "47", conversions: 4, conversionsValue: 617.28 } },
      { campaign: { id: "12", name: "Générique", status: "ENABLED" }, customer: { currencyCode: "EUR" }, metrics: { cost_micros: 5_000_000, impressions: 10, clicks: 0, conversions: 0, conversions_value: 0 } },
    ] }]);
    const out = await googleInsightsHandler.run(step, context());
    expect(relayDirectTool).toHaveBeenCalledTimes(1);
    expect(relayDirectTool.mock.calls[0][0]).toBe("mcp-google-ads.Custom_GAQL_Query");
    expect(sentQuery().customer_id).toBe("6010469196");
    expect(sentQuery().gaql_query).toMatch(GAQL_SHAPE);
    expect(sentQuery().gaql_query).toContain("BETWEEN '2026-09-22' AND '2026-09-28'");

    expect(out).toMatchObject({ status: "ok", rowsOut: 2, planned: [], written: [] });
    expect(out.output.rows).toEqual({
      columns: ["campaign_id", "campaign_name", "campaign_status", "currency", "spend", "conversions", "cpa", "roas", "ctr"],
      truncated: false,
      rows: [
        { campaign_id: "11", campaign_name: "Marque", campaign_status: "PAUSED", currency: "EUR", spend: 123.46, conversions: 4, cpa: 30.86, roas: 5, ctr: 2.35 },
        { campaign_id: "12", campaign_name: "Générique", campaign_status: "ENABLED", currency: "EUR", spend: 5, conversions: 0, cpa: null, roas: 0, ctr: 0 },
      ],
    });
  });

  it("gives null rather than a division by zero", () => {
    expect(toInsightRow({ customer: { id: "1", descriptiveName: "Compte" }, metrics: {} }, "account", ["ctr", "cpa", "roas", "spend"]))
      .toEqual({ account_id: "1", account_name: "Compte", currency: null, ctr: null, cpa: null, roas: null, spend: 0 });
  });

  it("fails functionally without an account, and never takes one from elsewhere", async () => {
    for (const googleCustomerId of [null, "", "abc"]) {
      const out = await googleInsightsHandler.run(step, context({ googleCustomerId }));
      expect(out).toMatchObject({ status: "failed", error: { class: "functional", message: expect.stringContaining("aucun compte Google Ads") } });
      expect(await googleInsightsHandler.preflight(step, { ...routine, googleCustomerId })).toMatchObject([{ severity: "error" }]);
    }
    expect(relayDirectTool).not.toHaveBeenCalled();
  });

  it("tells an account that cannot be read from a relay that is down", async () => {
    relayDirectTool.mockRejectedValue(new Error("tool error: USER_PERMISSION_DENIED for customer"));
    expect(await googleInsightsHandler.run(step, context())).toMatchObject({ status: "failed", error: { class: "functional" } });
    expect(await googleInsightsHandler.preflight(step, routine)).toMatchObject([{ severity: "error", message: expect.stringContaining("inaccessible") }]);
    relayDirectTool.mockRejectedValue(new Error("Relay unreachable"));
    expect(await googleInsightsHandler.run(step, context())).toMatchObject({ status: "failed", error: { class: "infra" } });
    expect(await googleInsightsHandler.preflight(step, routine)).toMatchObject([{ severity: "error", message: expect.stringContaining("vérification impossible") }]);
  });

  it("checks the account at preflight with a fixed query", async () => {
    relayDirectTool.mockResolvedValue([{ results: [{ customer: { id: "6010469196" } }] }]);
    expect(await googleInsightsHandler.preflight(step, routine)).toEqual([]);
    expect(sentQuery()).toEqual({ customer_id: "6010469196", gaql_query: "SELECT customer.id FROM customer LIMIT 1" });
  });

  it("says when nothing was delivered, and when the list was cut", async () => {
    relayDirectTool.mockResolvedValue([]);
    const none = await googleInsightsHandler.run(step, context());
    expect(none).toMatchObject({ status: "ok", rowsOut: 0 });
    expect(none.warnings[0]).toContain("Aucune diffusion");
    relayDirectTool.mockResolvedValue([{ results: Array.from({ length: 500 }, (_, i) => ({ campaign: { id: String(i) }, metrics: { costMicros: 1 } })) }]);
    expect((await googleInsightsHandler.run(step, context())).output.rows?.truncated).toBe(true);
  });
});
