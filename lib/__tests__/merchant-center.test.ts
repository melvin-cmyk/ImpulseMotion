import { describe, expect, it } from "vitest";
import {
  normalizeMerchantId, parseMerchantAccounts, parsePerformanceTotals, parseTopProducts, parseProductStatuses,
  parseAccountIssues, performanceQuery, topProductsQuery, PRODUCT_STATUS_QUERY, renderMerchantForPrompt, type MerchantReport,
} from "@/lib/merchant-center";

const ACCOUNTS = [{ accounts: [
  { name: "accounts/9173317", accountId: "9173317", accountName: "L'Homme Moderne", timeZone: { id: "Europe/Paris" }, languageCode: "fr-FR", homePageUri: "https://www.lhommemoderne.fr/" },
  { name: "accounts/101273841", accountId: "101273841", accountName: "Jours Heureux", timeZone: { id: "Europe/Brussels" }, languageCode: "fr-FR" },
  { name: "accounts/x", accountId: "" },
] }];

const PERF = [{ results: [
  { productPerformanceView: { clicks: "50664", impressions: "6379738", clickThroughRate: 0.0079, conversions: 3, conversionValue: { amountMicros: "0", currencyCode: "" } } },
  { productPerformanceView: { clicks: "0", impressions: "0", clickThroughRate: "NaN", conversions: 0, conversionValue: { amountMicros: "151050000", currencyCode: "EUR" } } },
] }];

describe("normalizeMerchantId", () => {
  it("keeps digits, strips the accounts/ prefix", () => {
    expect(normalizeMerchantId("accounts/9173317")).toBe("9173317");
    expect(normalizeMerchantId(" 101 273 841 ")).toBe("101273841");
    expect(normalizeMerchantId("abc")).toBeNull();
    expect(normalizeMerchantId(null)).toBeNull();
  });
});

describe("parseMerchantAccounts", () => {
  it("reads id, name, site and zone, sorted by name, dropping rows without an id", () => {
    const a = parseMerchantAccounts(ACCOUNTS);
    expect(a.map((x) => x.name)).toEqual(["Jours Heureux", "L'Homme Moderne"]);
    expect(a[1]).toMatchObject({ id: "9173317", homePage: "https://www.lhommemoderne.fr/", timeZone: "Europe/Paris", language: "fr-FR" });
  });
});

describe("report parsers", () => {
  it("sums the rows of an aggregated performance query and reads micros", () => {
    const p = parsePerformanceTotals(PERF)!;
    expect(p).toMatchObject({ clicks: 50664, impressions: 6379738, conversions: 3, conversionValue: 151.05, currency: "EUR" });
    expect(p.ctr).toBe(0.79);
    expect(parsePerformanceTotals([{ results: [] }])).toBeNull();
  });
  it("lists top products by clicks", () => {
    const rows = [{ results: [
      { productPerformanceView: { offerId: "1", title: "B", clicks: "10", impressions: "100", conversions: 1, conversionValue: { amountMicros: "2500000", currencyCode: "EUR" } } },
      { productPerformanceView: { offerId: "2", title: "A", clicks: "20", impressions: "50", conversions: 0, conversionValue: {} } },
    ] }];
    expect(parseTopProducts(rows).map((p) => [p.title, p.clicks, p.conversionValue])).toEqual([["A", 20, null], ["B", 10, 2.5]]);
  });
  it("counts product statuses and flags a truncated page", () => {
    const rows = [{ nextPageToken: "abc", results: [
      { productView: { id: "a", aggregatedReportingContextStatus: "ELIGIBLE", availability: "in stock" } },
      { productView: { id: "b", aggregatedReportingContextStatus: "ELIGIBLE_LIMITED", availability: "out of stock" } },
      { productView: { id: "c", aggregatedReportingContextStatus: "NOT_ELIGIBLE_OR_DISAPPROVED", availability: "IN_STOCK" } },
      { productView: { id: "d", aggregatedReportingContextStatus: "PENDING" } },
    ] }];
    expect(parseProductStatuses(rows)).toEqual({ total: 4, approved: 1, limited: 1, disapproved: 1, pending: 1, other: 0, inStock: 2, truncated: true });
    expect(parseProductStatuses([{}])).toBeNull();
  });
  it("reads account issues, errors first, and treats [{}] as no issue", () => {
    expect(parseAccountIssues([{}])).toEqual([]);
    const issues = parseAccountIssues([{ alerts: [
      { title: "Avertissement prix", impact: { severity: "WARNING", breakdowns: [{ details: ["Prix différent du site"] }] }, numProducts: 12 },
      { title: "Flux en erreur", impact: { severity: "ERROR", message: "Le flux n'a pas été récupéré" } },
    ] }]);
    expect(issues.map((i) => i.title)).toEqual(["Flux en erreur", "Avertissement prix"]);
    expect(issues[1]).toMatchObject({ products: 12, detail: "Prix différent du site" });
  });
});

describe("queries and prompt", () => {
  it("builds the MCQL the n8n tool expects", () => {
    expect(performanceQuery("2026-09-01", "2026-09-30")).toContain("FROM product_performance_view WHERE date BETWEEN '2026-09-01' AND '2026-09-30'");
    expect(topProductsQuery("2026-09-01", "2026-09-30", 5)).toMatch(/ORDER BY clicks DESC LIMIT 5$/);
    expect(PRODUCT_STATUS_QUERY).toMatch(/^SELECT id, /);
  });
  it("renders a readable block, with the attribution warning", () => {
    const block: MerchantReport = {
      accountId: "9173317", accountName: "L'Homme Moderne", period: { since: "2026-09-01", until: "2026-09-30" },
      issues: [{ title: "Flux en erreur", severity: "ERROR", products: 40, detail: null }],
      products: { total: 1000, approved: 900, limited: 50, disapproved: 40, pending: 10, other: 0, inStock: 800, truncated: true },
      performance: { clicks: 50664, impressions: 6379738, ctr: 0.79, conversions: 3, conversionValue: 151.05, currency: "EUR" },
      topProducts: [{ offerId: "1", title: "La porteuse de lettres", clicks: 2321, impressions: 51488, conversions: 0, conversionValue: null }],
      warnings: [],
    };
    const text = renderMerchantForPrompt([block]).join("\n");
    expect(text).toContain("MERCHANT CENTER (compte « L'Homme Moderne » 9173317");
    expect(text).toContain("sur les 1 000 premiers");
    expect(text).toContain("[ERROR] Flux en erreur — 40 produits");
    expect(text).toContain("ne pas additionner à Google Ads");
    expect(text).toContain("La porteuse de lettres (1) : 2321 clics");
  });
});
