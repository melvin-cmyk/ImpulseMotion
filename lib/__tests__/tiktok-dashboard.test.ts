/**
 * TikTok on the dashboards (lib/tiktok-dashboard): accounts read from the
 * DashboardSource rows, one currency summed, metrics mapping; binding an
 * advertiser (lib/tiktok-binding: id, scope, TikTok's answer); pacing with
 * TikTok's spend (lib/budgets).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/kpi-cache", () => ({
  cached: async (_key: string, fn: () => Promise<unknown>) => fn(),
  ttlForRange: () => 1000,
}));
vi.mock("@/lib/relay-tool", () => ({ relayDirectTool: vi.fn() }));
const totals: Record<string, Record<string, number>> = {};
vi.mock("@/lib/tiktok-data", async (orig) => {
  const actual = await orig<typeof import("@/lib/tiktok-data")>();
  return { ...actual, fetchTikTokTotals: vi.fn(async (id: string) => ({ ...actual.emptyTikTokStats(), ...(totals[id] ?? {}) })) };
});
const checkAdvertiser = vi.fn();
vi.mock("@/lib/tiktok-accounts", async (orig) => ({
  ...(await orig<typeof import("@/lib/tiktok-accounts")>()),
  checkAdvertiser: (...a: unknown[]) => checkAdvertiser(...a),
}));
const metaInsight = vi.fn();
vi.mock("@/lib/insights", () => ({ getAccountInsightsCachedWithMeta: (...a: unknown[]) => metaInsight(...a) }));
vi.mock("@/lib/meta-api", () => ({ getMetaSystemToken: () => "token" }));
vi.mock("@/lib/account-settings", () => ({ getAccountProfileSettings: vi.fn(async () => ({ timezone: null })) }));
vi.mock("@/lib/dashboard-widgets", () => ({ grantDashboardAccess: vi.fn() }));

import { sameCurrencyAccounts, tiktokAccountsFromSources, tiktokMetric, tiktokRevenueUnavailable, tiktokTotals } from "@/lib/tiktok-dashboard";
import { emptyTikTokStats } from "@/lib/tiktok-data";
import { checkTikTokBinding } from "@/lib/tiktok-binding";
import { computePacing } from "@/lib/budgets";
import { ALL_ACCOUNTS } from "@/lib/scope";

const A = "7000000000000000001";
const B = "7000000000000000002";

beforeEach(() => {
  for (const k of Object.keys(totals)) delete totals[k];
  checkAdvertiser.mockReset();
  metaInsight.mockReset();
});

describe("tiktokAccountsFromSources", () => {
  it("garde les comptes TikTok en service, une fois chacun, avec devise et fuseau", () => {
    const accounts = tiktokAccountsFromSources([
      { kind: "tiktok", externalId: A, status: "active", label: "Jow FR", config: JSON.stringify({ currency: "eur", timezone: "Europe/Paris" }) },
      { kind: "tiktok", externalId: ` ${A} `, status: "active", label: "doublon", config: "{}" },
      { kind: "tiktok", externalId: B, status: "disabled", label: "coupé", config: "{}" },
      { kind: "tiktok", externalId: "act_123", status: "active", label: "mauvais id", config: "{}" },
      { kind: "hubspot", externalId: "123456", status: "active", label: "CRM", config: "{}" },
      { kind: "tiktok", externalId: "7000000000000000009", status: "error", label: null, config: "pas du json" },
    ]);
    expect(accounts).toEqual([
      { id: A, name: "Jow FR", currency: "EUR", timezone: "Europe/Paris" },
      { id: "7000000000000000009", name: null, currency: null, timezone: null },
    ]);
    expect(tiktokAccountsFromSources(undefined)).toEqual([]);
  });
});

describe("sameCurrencyAccounts", () => {
  it("la première devise connue décide ; devise inconnue gardée, autre devise écartée", () => {
    const r = sameCurrencyAccounts([
      { id: A, name: null, currency: null, timezone: null },
      { id: B, name: "BE", currency: "EUR", timezone: null },
      { id: "3", name: "US", currency: "USD", timezone: null },
    ]);
    expect(r.currency).toBe("EUR");
    expect(r.accounts.map((a) => a.id)).toEqual([A, B]);
    expect(r.warnings).toEqual(["Devises différentes : compte TikTok US (USD) écarté, les comptes TikTok additionnés sont en EUR"]);
    expect(sameCurrencyAccounts([])).toEqual({ accounts: [], currency: null, warnings: [] });
  });
});

describe("tiktokMetric", () => {
  const s = { ...emptyTikTokStats(), spend: 200, impressions: 10_000, clicks: 100, conversions: 4, purchases: 3, purchaseValue: 600 };
  it("dépense, revenu = valeur des achats, ratios dérivés", () => {
    expect(tiktokMetric(s, "spend")).toBe(200);
    expect(tiktokMetric(s, "revenue")).toBe(600);
    expect(tiktokMetric(s, "roas")).toBe(3);
    expect(tiktokMetric(s, "purchases")).toBe(4);
    expect(tiktokMetric(s, "ctr")).toBe(1);
    expect(tiktokMetric(s, "cpc")).toBe(2);
    expect(tiktokMetric(s, "cpa")).toBe(50);
    expect(tiktokMetric(s, "cr")).toBe(4);
    expect(tiktokMetric(emptyTikTokStats(), "roas")).toBe(0);
    expect(tiktokMetric(s, "inconnue")).toBe(0);
  });
  it("revenu indisponible quand aucun achat n'est suivi", () => {
    expect(tiktokRevenueUnavailable(emptyTikTokStats())).toBe(true);
    expect(tiktokRevenueUnavailable(s)).toBe(false);
  });
});

describe("tiktokTotals", () => {
  it("additionne les comptes", async () => {
    totals[A] = { spend: 10, clicks: 1 };
    totals[B] = { spend: 5, clicks: 2 };
    expect(await tiktokTotals([A, B], "2026-09-01", "2026-09-30")).toMatchObject({ spend: 15, clicks: 3 });
  });
});

describe("checkTikTokBinding", () => {
  const scope = { all: false as const, meta: new Set<string>(), google: new Set<string>(), tiktok: new Set([A]) };
  const advertiser = { id: A, name: "Jow FR", currency: "EUR", timezone: "Europe/Paris", status: null };

  it("identifiant invalide → 400, sans appeler TikTok", async () => {
    expect(await checkTikTokBinding("act_12", ALL_ACCOUNTS)).toMatchObject({ ok: false, status: 400 });
    expect(checkAdvertiser).not.toHaveBeenCalled();
  });
  it("compte hors du périmètre → 403, sans appeler TikTok", async () => {
    expect(await checkTikTokBinding(B, scope)).toEqual({ ok: false, status: 403, error: `compte hors périmètre : ${B}` });
    expect(checkAdvertiser).not.toHaveBeenCalled();
  });
  it("dans le périmètre → la réponse de TikTok", async () => {
    checkAdvertiser.mockResolvedValue({ ok: true, advertiser });
    expect(await checkTikTokBinding(` ${A} `, scope)).toEqual({ ok: true, advertiser });
    expect(checkAdvertiser).toHaveBeenCalledWith(A);
  });
  it("TikTok ne connaît pas le compte → 400 avec son message", async () => {
    checkAdvertiser.mockResolvedValue({ ok: false, error: "TikTok ne connaît pas ce compte" });
    expect(await checkTikTokBinding(A, ALL_ACCOUNTS)).toEqual({ ok: false, status: 400, error: "TikTok ne connaît pas ce compte" });
  });
});

describe("computePacing avec TikTok", () => {
  const now = new Date("2026-09-11T12:00:00Z"); // 10 jours clos

  it("ajoute la dépense TikTok du mois à celle de Meta", async () => {
    metaInsight.mockResolvedValue({ data: { spend: "600" }, fetchedAt: "2026-09-11T00:00:00Z" });
    totals[A] = { spend: 400 };
    const p = await computePacing("111", 3000, "EUR", { tz: null, now, tiktokAdvertiserIds: [A], source: "dashboard" });
    expect(p).toMatchObject({ mtdSpend: 1000, tiktokSpend: 400, platforms: ["meta", "tiktok"], dailyRunRate: 100 });
  });

  it("TikTok seul : Meta n'est pas interrogé", async () => {
    totals[A] = { spend: 300 };
    totals[B] = { spend: 200 };
    const p = await computePacing(A, 1500, "EUR", { now, skipMeta: true, tiktokAdvertiserIds: [A, B], source: "dashboard" });
    expect(metaInsight).not.toHaveBeenCalled();
    expect(p).toMatchObject({ accountId: A, mtdSpend: 500, platforms: ["tiktok"], status: "on_track" });
  });

  it("sans compte TikTok : inchangé (Meta seul, pas de champ platforms)", async () => {
    metaInsight.mockResolvedValue({ data: { spend: "600" }, fetchedAt: "x" });
    const p = await computePacing("111", 3000, "EUR", { tz: null, now });
    expect(p.mtdSpend).toBe(600);
    expect(p.platforms).toBeUndefined();
  });
});
