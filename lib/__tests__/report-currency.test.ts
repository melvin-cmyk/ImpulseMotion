import { describe, expect, it } from "vitest";
import { pickReportCurrency, type ReportData, type ReportKpi } from "@/lib/report-data";
import { renderDataForPrompt } from "@/lib/report-generate";

const kpi = (metric: string, value: number, extra: Partial<ReportKpi> = {}): ReportKpi => ({
  metric, label: metric, source: "meta", value, previous: null, deltaPct: null, ...extra,
});

function data(overrides: Partial<ReportData> = {}): ReportData {
  return {
    client: { dashboardId: "d1", name: "Client ZA", metaAccountId: "123", googleCustomerId: null, platforms: ["meta"] },
    period: { since: "2026-08-01", until: "2026-08-31" },
    compare: null,
    currency: "ZAR",
    kpis: [kpi("spend", 85_000, { currency: "ZAR" })],
    platforms: null,
    daily: {},
    funnel: null,
    demographics: [],
    devices: [],
    countries: [],
    campaigns: { meta: [{ name: "Brand", spend: 12_000, clicks: 400, conversions: 12, roas: 2.1 }], google: [] },
    keywords: [],
    searchTerms: [],
    creatives: [],
    pacing: null,
    alerts: [],
    previousReport: null,
    warnings: [],
    generatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("pickReportCurrency()", () => {
  it("takes the KPI currency, then pacing, then the CRM section", () => {
    expect(pickReportCurrency([kpi("spend", 1, { currency: "ZAR" })], null)).toBe("ZAR");
    expect(pickReportCurrency([kpi("spend", 1)], { currency: "GBP" })).toBe("GBP");
    expect(pickReportCurrency([], null, { currency: "USD" })).toBe("USD");
    expect(pickReportCurrency([], null)).toBeNull();
  });
});

describe("renderDataForPrompt()", () => {
  it("states the account currency and never hands the AI a euro", () => {
    const prompt = renderDataForPrompt(data());
    expect(prompt).toContain("DEVISE DU COMPTE : ZAR");
    expect(prompt).toContain("ZAR");
    expect(prompt).not.toContain("€");
  });

  it("omits any currency symbol when the account currency is unknown", () => {
    const prompt = renderDataForPrompt(data({ currency: null, kpis: [kpi("spend", 85_000)] }));
    expect(prompt).not.toContain("€");
    expect(prompt).toContain("DEVISE DU COMPTE : inconnue");
  });

  it("reports an unavailable KPI as n/a, not as a zero", () => {
    const prompt = renderDataForPrompt(data({ kpis: [kpi("roas", 0, { currency: "ZAR", unavailable: true })] }));
    expect(prompt).toContain("n/a (non suivi)");
    expect(prompt).not.toContain("roas : 0");
  });

  it("does not present an unknown pacing as a zero spend", () => {
    const prompt = renderDataForPrompt(data({
      pacing: {
        accountId: "123", monthlyTarget: 100_000, currency: "ZAR", mtdSpend: 0,
        daysElapsed: 12, daysInMonth: 30, daysRemaining: 18, dailyRunRate: 0,
        projectedSpend: 0, pacingPct: 0, status: "unknown", reason: "token Meta expiré",
      },
    }));
    expect(prompt).toContain("dépensé n/a");
    expect(prompt).toContain("token Meta expiré");
  });
});
