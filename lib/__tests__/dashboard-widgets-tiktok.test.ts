/**
 * TikTok Ads in the dashboard widget engine (lib/dashboard-widgets): binding
 * from the dashboard's TikTok sources (owner's ACL or admin), several
 * advertisers summed in one currency, KPI / courbe / campagnes / vue par
 * plateforme, combined totals with Meta, and the default widget set.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = {
  acl: [] as Array<{ platform: string; accountId: string }>,
  ownerRole: "admin",
  sources: [] as Array<{ kind: string; externalId: string; status: string; label: string | null; config: string }>,
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    userAdAccount: { findMany: vi.fn(async () => db.acl) },
    user: { findUnique: vi.fn(async () => ({ role: db.ownerRole })) },
    dashboardSource: { findMany: vi.fn(async () => db.sources) },
    alertEvent: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/lib/kpi-cache", () => ({
  cached: async (_key: string, fn: () => Promise<unknown>) => fn(),
  cachedWithMeta: async (_key: string, fn: () => Promise<unknown>) => ({ data: await fn(), fetchedAt: "2026-09-30T00:00:00.000Z" }),
  ttlForRange: () => 1000,
}));
vi.mock("@/lib/account-settings", () => ({
  getAccountProfileSettings: vi.fn(async () => ({ aov: null, currency: "EUR", timezone: "Europe/Paris", conversionEvent: "purchase" })),
}));
const metaInsight = vi.fn();
vi.mock("@/lib/insights", () => ({ getAccountInsightsCachedWithMeta: (...a: unknown[]) => metaInsight(...a) }));
vi.mock("@/lib/meta-api", async (orig) => ({ ...(await orig<typeof import("@/lib/meta-api")>()), getMetaSystemToken: () => "token" }));
vi.mock("@/lib/relay-tool", () => ({ relayDirectTool: vi.fn(async () => { throw new Error("no relay in tests"); }) }));

const tiktok = {
  totals: {} as Record<string, Record<string, number>>,
  daily: {} as Record<string, Array<Record<string, number | string>>>,
  campaigns: {} as Record<string, Array<Record<string, number | string | null>>>,
};
vi.mock("@/lib/tiktok-data", async (orig) => {
  const actual = await orig<typeof import("@/lib/tiktok-data")>();
  const full = (s: Record<string, unknown>) => ({ ...actual.emptyTikTokStats(), ...s });
  return {
    ...actual,
    fetchTikTokTotals: vi.fn(async (id: string) => full(tiktok.totals[id] ?? {})),
    fetchTikTokDaily: vi.fn(async (id: string) => (tiktok.daily[id] ?? []).map(full)),
    fetchTikTokCampaigns: vi.fn(async (id: string) => (tiktok.campaigns[id] ?? []).map(full)),
  };
});

import { defaultWidgets, resolveWidgets, tiktokPacingIds, validateWidgetConfig, type ResolvedWidget } from "@/lib/dashboard-widgets";

const A = "7000000000000000001";
const B = "7000000000000000002";
const C = "7000000000000000003";
const source = (id: string, label: string, currency: string | null) => ({
  kind: "tiktok", externalId: id, status: "active", label, config: JSON.stringify({ currency, timezone: "Europe/Paris" }),
});

const DASH = { id: "d1", userId: "owner", metaAccountId: null, googleCustomerId: null };

async function resolve(widgets: Array<{ type: string; config: Record<string, unknown> }>, dashboard: typeof DASH | { id: string; userId: string; metaAccountId: string | null; googleCustomerId: string | null } = DASH): Promise<ResolvedWidget[]> {
  return resolveWidgets(
    dashboard,
    widgets.map((w, i) => ({ id: `w${i}`, type: w.type, title: null, width: "half", position: i, config: JSON.stringify(w.config) })),
    "2026-09-01",
    "2026-09-30",
    null,
  );
}

beforeEach(() => {
  db.acl = [];
  db.ownerRole = "admin";
  db.sources = [source(A, "Jow FR", "EUR"), source(B, "Jow BE", "EUR")];
  tiktok.totals = {
    [A]: { spend: 1000, impressions: 100_000, clicks: 2000, conversions: 50, purchases: 40, purchaseValue: 4000 },
    [B]: { spend: 500, impressions: 50_000, clicks: 500, conversions: 10, purchases: 10, purchaseValue: 1000 },
    [C]: { spend: 300, impressions: 1000, clicks: 10, conversions: 1, purchases: 1, purchaseValue: 30 },
  };
  tiktok.daily = {
    [A]: [{ date: "2026-09-01", spend: 100, purchaseValue: 300 }, { date: "2026-09-02", spend: 200, purchaseValue: 200 }],
    [B]: [{ date: "2026-09-02", spend: 50, purchaseValue: 100 }],
  };
  tiktok.campaigns = {
    [A]: [{ id: "c1", name: "Prospection", objective: null, spend: 700, clicks: 900, conversions: 30, purchaseValue: 2100 }],
    [B]: [{ id: "c2", name: "Retargeting", objective: null, spend: 900, clicks: 100, conversions: 5, purchaseValue: 450 }],
  };
  metaInsight.mockReset();
});

describe("TikTok KPI", () => {
  it("additionne les comptes TikTok du client et calcule les ratios", async () => {
    const [spend, roas, cpa, ctr] = await resolve([
      { type: "kpi", config: { metric: "spend", source: "tiktok" } },
      { type: "kpi", config: { metric: "roas", source: "tiktok" } },
      { type: "kpi", config: { metric: "cpa", source: "tiktok" } },
      { type: "kpi", config: { metric: "ctr", source: "tiktok" } },
    ]);
    expect(spend.error).toBeUndefined();
    expect(spend.data).toMatchObject({ value: 1500, source: "tiktok", currency: "EUR", platforms: ["tiktok"] });
    expect((roas.data as { value: number }).value).toBeCloseTo(5000 / 1500, 2);
    expect((cpa.data as { value: number }).value).toBe(25);
    expect((ctr.data as { value: number }).value).toBeCloseTo(2500 / 150_000 * 100, 2);
  });

  it("écarte un compte dans une autre devise, avec un avertissement", async () => {
    db.sources = [source(A, "Jow FR", "EUR"), source(C, "Jow US", "USD")];
    const [spend] = await resolve([{ type: "kpi", config: { metric: "spend", source: "tiktok" } }]);
    expect(spend.data).toMatchObject({ value: 1000, currency: "EUR", partial: true });
    expect((spend.data as { errors: string[] }).errors[0]).toMatch(/Jow US \(USD\) écarté/);
  });

  it("propriétaire non admin : seuls les comptes de son ACL comptent", async () => {
    db.ownerRole = "client";
    db.acl = [{ platform: "tiktok", accountId: B }];
    const [spend] = await resolve([{ type: "kpi", config: { metric: "spend", source: "tiktok" } }]);
    expect((spend.data as { value: number }).value).toBe(500);

    db.acl = [];
    const [none] = await resolve([{ type: "kpi", config: { metric: "spend", source: "tiktok" } }]);
    expect(none.error).toMatch(/Aucun compte TikTok Ads autorisé/);
  });

  it("propriétaire consultant (accès complet, lib/roles) : tous les comptes rattachés", async () => {
    db.ownerRole = "consultant";
    const [spend] = await resolve([{ type: "kpi", config: { metric: "spend", source: "tiktok" } }]);
    expect((spend.data as { value: number }).value).toBe(1500);
  });

  it("combined additionne Meta et TikTok et signale des devises différentes", async () => {
    db.acl = [{ platform: "meta", accountId: "111" }];
    db.sources = [source(C, "Jow US", "USD")];
    metaInsight.mockResolvedValue({ data: { spend: "200", impressions: "1000", clicks: "20", ctr: "2", currency: "EUR", actions: [] }, fetchedAt: "x" });
    const [spend] = await resolve(
      [{ type: "kpi", config: { metric: "spend", source: "combined" } }],
      { ...DASH, metaAccountId: "111" },
    );
    expect(spend.data).toMatchObject({ value: 500, platforms: ["meta", "tiktok"], partial: true, currency: "EUR" });
    expect((spend.data as { errors: string[] }).errors.join(" ")).toMatch(/Devises différentes: Meta EUR \/ TikTok USD/);
  });

  it("combined garde les autres plateformes quand TikTok tombe", async () => {
    db.acl = [{ platform: "meta", accountId: "111" }];
    const data = await import("@/lib/tiktok-data");
    vi.mocked(data.fetchTikTokTotals).mockRejectedValueOnce(new Error("TikTok 40100 : quota"));
    metaInsight.mockResolvedValue({ data: { spend: "200", impressions: "1000", clicks: "20", ctr: "2", currency: "EUR", actions: [] }, fetchedAt: "x" });
    const [spend] = await resolve(
      [{ type: "kpi", config: { metric: "spend", source: "combined" } }],
      { ...DASH, metaAccountId: "111" },
    );
    expect(spend.data).toMatchObject({ value: 200, partial: true, platforms: ["meta"] });
    expect((spend.data as { errors: string[] }).errors[0]).toMatch(/^TikTok: TikTok 40100/);
  });
});

describe("TikTok courbe, campagnes et vue par plateforme", () => {
  it("courbe quotidienne : jours des comptes additionnés", async () => {
    const [spend, roas] = await resolve([
      { type: "timeseries", config: { metric: "spend", source: "tiktok" } },
      { type: "timeseries", config: { metric: "roas", source: "tiktok" } },
    ]);
    expect((spend.data as { points: unknown[] }).points).toEqual([{ date: "2026-09-01", value: 100 }, { date: "2026-09-02", value: 250 }]);
    expect((roas.data as { points: Array<{ value: number }> }).points[1].value).toBe(1.2);
  });

  it("table des campagnes : tous les comptes, par dépense décroissante", async () => {
    const [table] = await resolve([{ type: "table", config: { kind: "campaigns", source: "tiktok", limit: 10 } }]);
    expect((table.data as { rows: unknown[] }).rows).toEqual([
      { name: "Retargeting", spend: 900, clicks: 100, conversions: 5, roas: 0.5 },
      { name: "Prospection", spend: 700, clicks: 900, conversions: 30, roas: 3 },
    ]);
  });

  it("vue par plateforme : une ligne TikTok", async () => {
    const [table] = await resolve([{ type: "platform_table", config: {} }]);
    const rows = (table.data as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: "TikTok", cost: 1500, clicks: 2500, conversions: 60, cpa: 25 });
  });

  it("un dashboard sans aucun compte reste une erreur", async () => {
    db.sources = [];
    await expect(resolve([{ type: "kpi", config: { metric: "spend", source: "tiktok" } }]))
      .rejects.toThrow(/n'est lié à aucun compte publicitaire \(Meta, Google ou TikTok\)/);
  });
});

describe("validateWidgetConfig — source tiktok", () => {
  it("acceptée là où TikTok a un équivalent", () => {
    expect(validateWidgetConfig("kpi", { metric: "spend", source: "tiktok" })).toEqual({ metric: "spend", source: "tiktok" });
    expect(validateWidgetConfig("timeseries", { metric: "roas", source: "tiktok" })).toEqual({ metric: "roas", source: "tiktok" });
    expect(validateWidgetConfig("table", { kind: "campaigns", source: "tiktok" })).toMatchObject({ kind: "campaigns", source: "tiktok" });
  });
  it("refusée ailleurs", () => {
    expect(() => validateWidgetConfig("table", { kind: "keywords", source: "tiktok" })).toThrow(/tiktok ne supporte que kind=campaigns/);
    expect(() => validateWidgetConfig("funnel", { source: "tiktok" })).toThrow(/Source d'entonnoir invalide/);
    expect(() => validateWidgetConfig("geo_device", { source: "tiktok" })).toThrow(/Source de répartition invalide/);
  });
});

describe("tiktokPacingIds", () => {
  const binding = { tiktokAdvertiserIds: [A, B], tiktokCurrency: "EUR" };
  it("la dépense TikTok compte contre le budget du client, dans sa devise", () => {
    expect(tiktokPacingIds({ source: "dashboard", currency: "EUR" }, binding)).toEqual([A, B]);
    expect(tiktokPacingIds({ source: "dashboard", currency: "USD" }, binding)).toEqual([]);
    expect(tiktokPacingIds({ source: "account_budget", currency: "EUR" }, binding)).toEqual([]);
    expect(tiktokPacingIds({ source: "dashboard", currency: "EUR" }, { tiktokAdvertiserIds: [], tiktokCurrency: null })).toEqual([]);
  });
});

describe("defaultWidgets avec TikTok", () => {
  const UNITS: Record<string, number> = { third: 2, half: 3, full: 6 };
  /** Every row of the 6-unit grid is complete. */
  const rowsComplete = (ws: Array<{ width: string }>) => {
    let row = 0;
    for (const w of ws) {
      row += UNITS[w.width];
      if (row > 6) return false;
      if (row === 6) row = 0;
    }
    return row === 0;
  };
  const cases: Array<[string, boolean, boolean, boolean, boolean]> = [
    ["TikTok seul", false, false, false, true],
    ["TikTok seul + HubSpot", false, false, true, true],
    ["Meta + TikTok", true, false, false, true],
    ["Google + TikTok", false, true, false, true],
    ["Meta + Google + TikTok + HubSpot", true, true, true, true],
    ["Meta seul (inchangé)", true, false, false, false],
  ];
  for (const [label, meta, google, hubspot, tt] of cases) {
    it(`${label} : rangées complètes, configs valides`, () => {
      const ws = defaultWidgets(meta, google, "Jow", hubspot, tt);
      expect(rowsComplete(ws)).toBe(true);
      for (const w of ws) expect(() => validateWidgetConfig(w.type, w.config)).not.toThrow();
      const sources = new Set(ws.map((w) => w.config.source).filter(Boolean));
      if (tt) expect(sources.has("tiktok")).toBe(true);
      else expect(sources.has("tiktok")).toBe(false);
    });
  }

  it("TikTok seul : KPI tiktok, ni entonnoir ni widgets Meta, pacing et campagnes TikTok", () => {
    const ws = defaultWidgets(false, false, "Jow", false, true);
    const types = ws.map((w) => w.type);
    expect(ws.find((w) => w.type === "kpi")?.config.source).toBe("tiktok");
    expect(types).not.toContain("funnel");
    expect(types).not.toContain("top_creatives");
    expect(types).toContain("pacing");
    expect(ws.find((w) => w.type === "table")?.config).toEqual({ kind: "campaigns", source: "tiktok", limit: 10 });
    expect(String(ws[0].config.markdown)).toContain("TikTok Ads");
  });

  it("Meta + TikTok : KPI combined, entonnoir sur Meta seulement", () => {
    const ws = defaultWidgets(true, false, "Jow", false, true);
    expect(ws.find((w) => w.type === "kpi")?.config.source).toBe("combined");
    expect(ws.find((w) => w.type === "funnel")?.config.source).toBe("meta");
    expect(ws.filter((w) => w.type === "timeseries").map((w) => w.title)).toEqual([
      "Dépenses quotidiennes — Meta", "ROAS quotidien — Meta", "Dépenses quotidiennes — TikTok", "ROAS quotidien — TikTok",
    ]);
  });
});
