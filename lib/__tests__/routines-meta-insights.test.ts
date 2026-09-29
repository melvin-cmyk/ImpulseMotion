import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MetaInsightsStep, StepContext } from "@/lib/routines/types";

// Meta is a fetch mock and the settings table a module mock: nothing real is read.

const findFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { accountSetting: { findFirst: (...a: unknown[]) => findFirst(...a) } } }));

const TOKEN = "EAAprimaryTokenForTestsOnly000000000000000001";
const ACCOUNT = "564381881705822";

const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const urls = () => fetchMock.mock.calls.map((c) => new URL(String(c[0])));

interface Ad { ad: number; adset: number; campaign?: number; spend: string; impressions?: string; clicks?: string; purchases?: number; value?: number; leads?: number }
const adRow = (a: Ad) => ({
  ad_id: `ad${a.ad}`, ad_name: `Pub ${a.ad}`, adset_id: `as${a.adset}`, adset_name: `Ensemble ${a.adset}`,
  campaign_id: `c${a.campaign ?? 1}`, campaign_name: `Campagne ${a.campaign ?? 1}`,
  spend: a.spend, impressions: a.impressions ?? "1000", clicks: a.clicks ?? "20", ctr: "2", cpc: "1", cpm: "10", account_currency: "EUR",
  actions: [
    ...(a.purchases ? [{ action_type: "omni_purchase", value: String(a.purchases) }, { action_type: "purchase", value: String(a.purchases) }] : []),
    ...(a.leads ? [{ action_type: "lead", value: String(a.leads) }] : []),
    { action_type: "link_click", value: "15" },
  ],
  action_values: a.value ? [{ action_type: "omni_purchase", value: String(a.value) }] : [],
  date_start: "2026-09-22", date_stop: "2026-09-28",
});

/** Serves `rows` by pages of `size`, as the Graph API does with cursors. */
function paged(rows: unknown[], size: number) {
  fetchMock.mockImplementation(async (target) => {
    const url = new URL(String(target));
    const start = Number(url.searchParams.get("after") ?? 0);
    const next = start + size < rows.length;
    return json({ data: rows.slice(start, start + size), ...(next ? { paging: { cursors: { after: String(start + size) }, next: "https://x" } } : {}) });
  });
}

const step = (patch: Partial<MetaInsightsStep> = {}): MetaInsightsStep => ({
  id: "lire", type: "meta.insights", level: "ad", window: "7d", metrics: ["spend", "impressions", "clicks", "ctr", "cpm", "conversions", "cpa", "roas"], ...patch,
});

function context(metaAccountId: string | null = `act_${ACCOUNT}`): StepContext {
  return {
    mode: "dry_run",
    routine: { id: "r1", name: "Suivi", metaAccountId, googleCustomerId: null, timezone: "Europe/Paris", maxItemsPerRun: 20 },
    runId: "run1", now: new Date("2026-09-29T08:00:00Z"), deadlineAt: Date.now() + 250_000,
    input: null, outputs: {}, write: null,
    claimItem: async () => { throw new Error("a read step must not claim an item"); },
    settleItem: async () => { throw new Error("a read step must not settle an item"); },
  };
}

async function load() {
  return (await import("@/lib/routines/steps/meta-insights"));
}

beforeEach(() => {
  vi.resetModules();
  process.env.META_SYSTEM_TOKEN = TOKEN;
  process.env.META_RETRY_BASE_MS = "0";
  findFirst.mockReset();
  findFirst.mockResolvedValue({ aov: null, currency: "EUR", timezone: "Europe/Paris", conversionEvent: "purchase" });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.META_SYSTEM_TOKEN;
  delete process.env.META_RETRY_BASE_MS;
});

describe("meta.insights — validation", () => {
  it("accepts the levels, windows and metrics of the type, and rebuilds the step", async () => {
    const { metaInsightsHandler: h } = await load();
    expect(h.type).toBe("meta.insights");
    expect(h.writes).toBe("none");
    for (const level of ["account", "campaign", "adset", "ad"] as const) {
      for (const window of ["yesterday", "7d", "14d", "30d", "month_to_date"] as const) {
        expect(h.validate({ id: "s", type: "meta.insights", level, window, metrics: ["spend", "roas"] })).toEqual({
          ok: true, step: { id: "s", type: "meta.insights", level, window, metrics: ["spend", "roas"] },
        });
      }
    }
    expect(h.validate({ ...step(), nameContains: " ACQ ", label: "Lire" })).toEqual({ ok: true, step: { ...step(), nameContains: "ACQ", label: "Lire" } });
  });

  it("refuses anything else", async () => {
    const { metaInsightsHandler: h } = await load();
    for (const bad of [
      null, [], "meta.insights", { ...step(), level: "creative" }, { ...step(), window: "90d" }, { ...step(), window: "2026-01-01..2026-02-01" },
      { ...step(), metrics: [] }, { ...step(), metrics: ["spend", "frequency"] }, { ...step(), metrics: ["spend", "spend"] }, { ...step(), metrics: "spend" },
      { ...step(), accountId: "act_1" }, { ...step(), fields: "spend" }, { ...step(), breakdowns: "age" }, { ...step(), id: "" },
      { ...step(), nameContains: "" }, { ...step(), nameContains: 3 }, { ...step(), level: "account", nameContains: "ACQ" }, { ...step(), type: "google.insights" },
    ]) {
      expect(h.validate(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("meta.insights — windows", () => {
  it("are full days ending yesterday, in the account timezone", async () => {
    const { windowRange } = await load();
    const now = new Date("2026-09-29T08:00:00Z");
    expect(windowRange("yesterday", "Europe/Paris", now)).toEqual({ since: "2026-09-28", until: "2026-09-28" });
    expect(windowRange("7d", "Europe/Paris", now)).toEqual({ since: "2026-09-22", until: "2026-09-28" });
    expect(windowRange("14d", "Europe/Paris", now)).toEqual({ since: "2026-09-15", until: "2026-09-28" });
    expect(windowRange("30d", "Europe/Paris", now)).toEqual({ since: "2026-08-30", until: "2026-09-28" });
    expect(windowRange("month_to_date", "Europe/Paris", now)).toEqual({ since: "2026-09-01", until: "2026-09-28" });
    // 23:30 UTC on the 28th is already the 29th in Auckland, still the 28th in Los Angeles.
    const late = new Date("2026-09-28T23:30:00Z");
    expect(windowRange("yesterday", "Pacific/Auckland", late)).toEqual({ since: "2026-09-28", until: "2026-09-28" });
    expect(windowRange("yesterday", "America/Los_Angeles", late)).toEqual({ since: "2026-09-27", until: "2026-09-27" });
  });
});

describe("meta.insights — run", () => {
  it("reads the whole series, beyond the first page of 25", async () => {
    const ads = Array.from({ length: 60 }, (_, i) => adRow({ ad: i + 1, adset: (i % 4) + 1, spend: "10", purchases: 1, value: 40 }));
    paged(ads, 25);
    const { metaInsightsHandler: h } = await load();
    const out = await h.run(step(), context());
    expect(out.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out.rowsOut).toBe(60);
    expect(out.output.rows?.rows).toHaveLength(60);
    expect(out.output.rows?.truncated).toBe(false);
    expect(new Set(out.output.rows?.rows.map((r) => r.ad_id)).size).toBe(60);
    expect(out.planned).toEqual([]);
    expect(out.written).toEqual([]);

    const first = urls()[0];
    expect(first.pathname).toBe(`/v22.0/act_${ACCOUNT}/insights`);
    expect(first.searchParams.get("level")).toBe("ad");
    expect(JSON.parse(first.searchParams.get("time_range") ?? "{}")).toEqual({ since: "2026-09-22", until: "2026-09-28" });
    expect(first.searchParams.get("use_unified_attribution_setting")).toBe("true");
    for (const c of fetchMock.mock.calls) expect(c[1]?.method ?? "GET").toBe("GET");
  });

  it("computes the metrics as the rest of the application does", async () => {
    paged([adRow({ ad: 1, adset: 1, spend: "100", impressions: "20000", clicks: "300", purchases: 4, value: 350 })], 25);
    const { metaInsightsHandler: h } = await load();
    const out = await h.run(step(), context());
    expect(out.output.rows?.columns).toEqual([
      "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name", "date_start", "date_stop", "currency",
      "spend", "impressions", "clicks", "ctr", "cpm", "conversions", "cpa", "roas",
    ]);
    expect(out.output.rows?.rows[0]).toEqual({
      campaign_id: "c1", campaign_name: "Campagne 1", adset_id: "as1", adset_name: "Ensemble 1", ad_id: "ad1", ad_name: "Pub 1",
      date_start: "2026-09-22", date_stop: "2026-09-28", currency: "EUR",
      spend: 100, impressions: 20000, clicks: 300, ctr: 1.5, cpm: 5, conversions: 4, cpa: 25, roas: 3.5,
    });
  });

  it("keeps only the metrics asked for, in the order asked", async () => {
    paged([adRow({ ad: 1, adset: 1, spend: "100", purchases: 4, value: 350 })], 25);
    const { metaInsightsHandler: h } = await load();
    const out = await h.run(step({ metrics: ["roas", "spend"] }), context());
    expect(out.output.rows?.columns.slice(-2)).toEqual(["roas", "spend"]);
    expect(Object.keys(out.output.rows!.rows[0])).not.toContain("clicks");
  });

  it("counts the conversion event of the account", async () => {
    findFirst.mockResolvedValue({ aov: 80, currency: "EUR", timezone: "Europe/Paris", conversionEvent: "lead" });
    paged([adRow({ ad: 1, adset: 1, spend: "100", leads: 5, purchases: 1 })], 25);
    const { metaInsightsHandler: h } = await load();
    const out = await h.run(step({ metrics: ["conversions", "cpa", "roas"] }), context());
    // No tracked value: revenue = conversions × configured basket, as computeRevenue does.
    expect(out.output.rows?.rows[0]).toMatchObject({ conversions: 5, cpa: 20, roas: 4 });
  });

  it("leaves the ROAS empty when the revenue is unknown, never an invented 0", async () => {
    paged([adRow({ ad: 1, adset: 1, spend: "100", purchases: 2 })], 25);
    const { metaInsightsHandler: h } = await load();
    const out = await h.run(step({ metrics: ["spend", "conversions", "roas"] }), context());
    expect(out.output.rows?.rows[0]).toMatchObject({ spend: 100, conversions: 2, roas: null });
    expect(out.warnings.join(" ")).toMatch(/ROAS vide/);
  });

  it("sums the ads of an ad set and recomputes the ratios on the sums", async () => {
    paged([
      adRow({ ad: 1, adset: 1, spend: "100", impressions: "10000", clicks: "100", purchases: 2, value: 300 }),
      adRow({ ad: 2, adset: 1, spend: "50", impressions: "30000", clicks: "500", purchases: 4, value: 150 }),
      adRow({ ad: 3, adset: 2, spend: "10", impressions: "1000", clicks: "10" }),
    ], 2);
    const { metaInsightsHandler: h } = await load();
    const out = await h.run(step({ level: "adset" }), context());
    expect(out.output.rows?.columns.slice(0, 4)).toEqual(["campaign_id", "campaign_name", "adset_id", "adset_name"]);
    expect(out.output.rows?.columns).not.toContain("ad_id");
    expect(out.output.rows?.rows).toEqual([
      expect.objectContaining({ adset_id: "as1", adset_name: "Ensemble 1", spend: 150, impressions: 40000, clicks: 600, ctr: 1.5, cpm: 3.75, conversions: 6, cpa: 25, roas: 3 }),
      expect.objectContaining({ adset_id: "as2", spend: 10, conversions: 0, cpa: 0, roas: null }),
    ]);
    expect(Object.keys(out.output.rows!.rows[0])).not.toContain("ad_name");
  });

  it("filters on the name of the level, whatever the case", async () => {
    paged([
      { ...adRow({ ad: 1, adset: 1, spend: "1" }), ad_name: "W40 - ACQ - Statique" },
      { ...adRow({ ad: 2, adset: 1, spend: "1" }), ad_name: "W40 - RET - Vidéo", campaign_name: "acq" },
      { ...adRow({ ad: 3, adset: 1, spend: "1" }), ad_name: "w41 - acq - carrousel" },
    ], 25);
    const { metaInsightsHandler: h } = await load();
    const out = await h.run(step({ nameContains: "acq" }), context());
    expect(out.output.rows?.rows.map((r) => r.ad_id)).toEqual(["ad1", "ad3"]);
    expect(out.rowsOut).toBe(2);
  });

  it("reads the campaign level, 40 campaigns over two pages", async () => {
    const campaigns = Array.from({ length: 40 }, (_, i) => ({
      campaign_id: `c${i}`, campaign_name: i % 2 ? `ACQ ${i}` : `RET ${i}`, account_currency: "USD", spend: "20", impressions: "4000", clicks: "40", ctr: "1",
      actions: [{ action_type: "omni_purchase", value: "2" }], action_values: [{ action_type: "omni_purchase", value: "90" }],
      cost_per_action_type: [{ action_type: "omni_purchase", value: "10" }], date_start: "d", date_stop: "d",
    }));
    paged(campaigns, 25);
    const { metaInsightsHandler: h } = await load();
    const out = await h.run(step({ level: "campaign", nameContains: "ACQ" }), context());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urls()[0].searchParams.get("level")).toBe("campaign");
    expect(out.output.rows?.rows).toHaveLength(20);
    expect(out.output.rows?.rows[0]).toMatchObject({ campaign_id: "c1", currency: "USD", spend: 20, cpm: 5, conversions: 2, cpa: 10, roas: 4.5 });
  });

  it("reads the account level: one row, zero-filled when nothing was delivered", async () => {
    fetchMock.mockImplementation(async () => json({ data: [] }));
    const { metaInsightsHandler: h } = await load();
    const out = await h.run(step({ level: "account", window: "yesterday", metrics: ["spend", "impressions", "ctr", "conversions"] }), context());
    expect(out.status).toBe("ok");
    expect(out.output.rows?.rows).toEqual([{
      account_id: `act_${ACCOUNT}`, date_start: "2026-09-28", date_stop: "2026-09-28", currency: "EUR", spend: 0, impressions: 0, ctr: 0, conversions: 0,
    }]);
    expect(urls()[0].searchParams.get("level")).toBe("account");
  });

  it("uses the account of the routine and reads the settings without writing them", async () => {
    paged([], 25);
    const { metaInsightsHandler: h } = await load();
    await h.run(step(), context(ACCOUNT));
    expect(urls()[0].pathname).toBe(`/v22.0/act_${ACCOUNT}/insights`);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ platform: "meta" });
  });

  it("falls back on purchases and on the routine's timezone when the settings cannot be read", async () => {
    findFirst.mockRejectedValue(new Error("database down"));
    paged([adRow({ ad: 1, adset: 1, spend: "10", purchases: 3, value: 30 })], 25);
    const { metaInsightsHandler: h } = await load();
    const out = await h.run(step({ metrics: ["conversions"] }), context());
    expect(out.status).toBe("ok");
    expect(out.output.rows?.rows[0].conversions).toBe(3);
    expect(out.warnings.join(" ")).toMatch(/Réglages du compte illisibles/);
  });

  it("fails cleanly, with the right class and without the token", async () => {
    const { metaInsightsHandler: h } = await load();
    expect(await h.run(step(), context(null))).toMatchObject({ status: "failed", error: { class: "functional" } });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockImplementation(async () => json({ error: { message: `(#100) Invalid account access_token=${TOKEN}`, code: 100 } }, 400));
    const invalid = await h.run(step(), context());
    expect(invalid).toMatchObject({ status: "failed", rowsOut: 0, error: { class: "functional" } });
    expect(JSON.stringify(invalid)).not.toContain(TOKEN);

    fetchMock.mockImplementation(async () => json({ error: { message: "User request limit reached", code: 17 } }, 400));
    expect(await h.run(step(), context())).toMatchObject({ status: "failed", error: { class: "infra" } });
  });
});

describe("meta.insights — preflight", () => {
  const routine = (metaAccountId: string | null) => ({ id: "r1", name: "Suivi", metaAccountId, googleCustomerId: null, timezone: "Europe/Paris", maxItemsPerRun: 20 });

  it("checks that the account can be read", async () => {
    const { metaInsightsHandler: h } = await load();
    expect(await h.preflight(step(), routine(null))).toEqual([expect.objectContaining({ severity: "error" })]);
    fetchMock.mockImplementation(async () => json({ id: `act_${ACCOUNT}`, name: "Compte", currency: "EUR", timezone_name: "Europe/Paris" }));
    expect(await h.preflight(step(), routine(ACCOUNT))).toEqual([]);
    fetchMock.mockImplementation(async () => json({ error: { message: "Unsupported get request", code: 100, error_subcode: 33 } }, 400));
    expect(await h.preflight(step(), routine(ACCOUNT))).toEqual([expect.objectContaining({ severity: "error", stepId: "lire" })]);
  });
});
