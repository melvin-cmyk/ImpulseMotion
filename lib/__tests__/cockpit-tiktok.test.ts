import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TikTok Ads in the Global Cockpit: sheet lines, automatic matching (manual
 * rows untouched), daily series, scope, and the admin attach route.
 */

type Row = { id: string; clientKey: string; platform: string; accountId: string; name: string; currency: string | null; label: string | null; mode: string | null; source: string; enabled: boolean };
const store: Row[] = [];
const created: Array<Record<string, unknown>> = [];
let sheetCsv = "";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    cockpitAccount: {
      findMany: async (args?: { where?: { enabled?: boolean } }) => store.filter((r) => args?.where?.enabled === undefined || r.enabled === args.where.enabled),
      findUnique: async ({ where }: { where: { platform_accountId: { platform: string; accountId: string } } }) =>
        store.find((r) => r.platform === where.platform_accountId.platform && r.accountId === where.platform_accountId.accountId) ?? null,
      createMany: async ({ data }: { data: Array<Omit<Row, "id" | "label" | "mode" | "enabled">> }) => {
        for (const d of data) {
          if (store.some((r) => r.platform === d.platform && r.accountId === d.accountId)) continue;
          store.push({ id: `row-${store.length}`, label: null, mode: null, enabled: true, ...d });
        }
        return { count: data.length };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: "new", ...data }; },
      update: async ({ data }: { data: Record<string, unknown> }) => data,
    },
    cockpitClient: { findMany: async () => [] },
    accountSetting: { findMany: async () => [] },
  },
}));
vi.mock("@/lib/kpi-cache", () => ({ cached: async (_key: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/tiktok-data", () => ({ fetchTikTokDaily: vi.fn(), listTikTokAdvertisers: vi.fn() }));
vi.mock("@/lib/tiktok-accounts", () => ({
  checkAdvertiser: vi.fn(),
  normalizeAdvertiserId: (raw: unknown) => {
    if (typeof raw !== "string") return null;
    const id = raw.replace(/\s+/g, "");
    return /^\d{5,25}$/.test(id) ? id : null;
  },
}));
vi.mock("@/lib/cockpit/fx", () => ({ loadFx: async () => ({ rates: { EUR: 1, USD: 0.9 }, note: "test" }) }));
vi.mock("@/lib/auth-helpers", () => ({ requireAdmin: async () => ({ session: { userId: "admin", role: "admin" } }) }));
vi.mock("@/lib/cockpit/sheet", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/cockpit/sheet")>();
  return { ...real, fetchBudgetSheet: async () => real.parseBudgetSheet(sheetCsv) };
});
vi.mock("@/lib/cockpit/fetch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/cockpit/fetch")>();
  return { ...real, listMetaAccounts: vi.fn(async () => []), listGoogleAccounts: vi.fn(async () => []), metaSeries: vi.fn(), googleSeries: vi.fn() };
});

import { fetchTikTokDaily, listTikTokAdvertisers } from "@/lib/tiktok-data";
import { checkAdvertiser } from "@/lib/tiktok-accounts";
import { metaSeries, googleSeries, tiktokSeries, listTikTokAccounts } from "@/lib/cockpit/fetch";
import { buildCockpit } from "@/lib/cockpit/build";
import { parseBudgetSheet, parsePlatform, sheetClients } from "@/lib/cockpit/sheet";
import { accountLabel } from "@/lib/cockpit/match";
import { buildClient } from "@/lib/cockpit/engine";
import { scopeData } from "@/lib/cockpit/view";
import { PUT } from "@/app/api/cockpit/global/config/route";
import type { CockpitData } from "@/lib/cockpit/build";
import type { AccountScope } from "@/lib/scope";

const TT = "7000000000000000001";
const HEADER = "Client,Team,Country / Region,Platform,Currency,Mois,Budget,Target ROAS,Target CPL";
const day = (d: number, over: Partial<{ spend: number; conversions: number; purchases: number; purchaseValue: number }> = {}) => ({
  date: `2026-09-${String(d).padStart(2, "0")}`,
  spend: 100, impressions: 10_000, clicks: 100, conversions: 5, purchases: 0, purchaseValue: 0, videoViews: 0, ...over,
});
const september = (over: Parameters<typeof day>[1] = {}) => Array.from({ length: 30 }, (_, i) => day(i + 1, over));

beforeEach(() => {
  store.length = 0;
  created.length = 0;
  vi.mocked(fetchTikTokDaily).mockReset();
  vi.mocked(listTikTokAdvertisers).mockReset();
  vi.mocked(checkAdvertiser).mockReset();
  vi.mocked(metaSeries).mockReset();
  vi.mocked(googleSeries).mockReset();
  vi.mocked(checkAdvertiser).mockResolvedValue({ ok: true, advertiser: { id: TT, name: "Naturalia TikTok FR", currency: "EUR", timezone: "Europe/Paris", status: "STATUS_ENABLE" } });
  sheetCsv = [
    HEADER,
    "Naturalia,Team A,France,FB/IG,EUR,01/September/2026,\"€3,000\",,",
    "Naturalia,Team A,France,TikTok,EUR,01/September/2026,\"€1,500\",,",
  ].join("\n");
});

describe("cockpit sheet — TikTok lines", () => {
  it("reads « TikTok » and « TT » as TikTok and sums its budget", () => {
    expect(parsePlatform("TikTok")).toBe("tiktok");
    expect(parsePlatform("TT")).toBe("tiktok");
    expect(parsePlatform("Tiktok Ads")).toBe("tiktok");
    expect(parsePlatform("LinkedIn")).toBe("other");
    const [naturalia] = sheetClients(parseBudgetSheet(sheetCsv), "2026-09");
    expect(naturalia.budget).toEqual({ meta: 3000, google: null, tiktok: 1500 });
    expect(naturalia.otherPlatforms).toEqual([]);
  });

  it("labels TikTok accounts like the others", () => {
    expect(accountLabel("tiktok", "Naturalia", "Naturalia TikTok FR", 1)).toBe("TikTok");
    expect(accountLabel("tiktok", "Naturalia", "Naturalia TikTok FR", 2)).toBe("TikTok · FR");
  });

  it("paces the TikTok budget of the sheet", () => {
    const row = buildClient({
      key: "n", name: "N", kpi_mode: "cpa", team: null, target_roas: null, target_cpl: null,
      budgets: { meta: null, google: null, tiktok: 1000 },
      platforms: [{ key: "tiktok", plat: "tiktok", label: "TikTok", accountId: TT, ccy: "EUR", mode: "cpa", weeks: [], mtd: 900, budget: 1000, err: null }],
    }, { fx: { EUR: 1 }, month: { elapsed: 27, days: 30 } });
    expect(row.pacing?.budget).toBe(1000);
  });
});

describe("cockpit fetch — TikTok", () => {
  it("lists the agency advertisers as cockpit accounts", async () => {
    vi.mocked(listTikTokAdvertisers).mockResolvedValue([{ id: TT, name: "Naturalia TikTok FR", businessCenters: ["Impulse"] }]);
    expect(await listTikTokAccounts()).toEqual([{ platform: "tiktok", accountId: TT, name: "Naturalia TikTok FR", currency: null, active: true }]);
  });

  it("reads in ROAS an account that tracks a purchase value, purchases as conversions", async () => {
    vi.mocked(fetchTikTokDaily).mockResolvedValue([day(1, { purchases: 2, purchaseValue: 500 })]);
    const s = await tiktokSeries(TT, { since: "2026-09-01", until: "2026-09-30" }, { mode: null });
    expect(s.mode).toBe("roas");
    expect(s.currency).toBe("EUR");
    expect(s.convEvent).toBe("total_purchase");
    expect(s.days[0]).toMatchObject({ date: "2026-09-01", spend: 100, conv: 2, value: 500 });
  });

  it("reads in CPA the optimisation event; a failed currency check gives null", async () => {
    vi.mocked(fetchTikTokDaily).mockResolvedValue([day(1)]);
    vi.mocked(checkAdvertiser).mockResolvedValue({ ok: false, error: "nope" });
    const s = await tiktokSeries(TT, { since: "2026-09-01", until: "2026-09-30" }, { mode: null });
    expect(s.mode).toBe("cpa");
    expect(s.currency).toBeNull();
    expect(s.days[0].conv).toBe(5);
  });
});

describe("cockpit build — TikTok", () => {
  const now = new Date("2026-10-01T08:00:00Z");

  it("matches a TikTok account by name and reads it as TikTok", async () => {
    vi.mocked(listTikTokAdvertisers).mockResolvedValue([{ id: TT, name: "Naturalia TikTok FR", businessCenters: [] }]);
    vi.mocked(fetchTikTokDaily).mockResolvedValue(september());
    const data = await buildCockpit({ now, deadline: Date.now() + 10_000 });
    expect(store).toMatchObject([{ clientKey: "naturalia", platform: "tiktok", accountId: TT, source: "auto" }]);
    const naturalia = data.clients.find((c) => c.key === "naturalia")!;
    expect(Object.keys(naturalia.platforms)).toEqual(["tiktok"]);
    expect(naturalia.platforms.tiktok).toMatchObject({ plat: "tiktok", label: "TikTok", ccy: "EUR", mode: "cpa", spend: 700 });
    expect(naturalia.pacing?.budget).toBe(1500);
    expect(naturalia.missing).toEqual(["Meta"]);
    expect(metaSeries).not.toHaveBeenCalled();
  });

  it("never moves an account an admin attached, and never reads an unknown platform as Meta", async () => {
    store.push(
      { id: "m1", clientKey: "naturalia", platform: "tiktok", accountId: TT, name: "Naturalia TikTok FR", currency: "EUR", label: "TikTok · Bio", mode: "roas", source: "manual", enabled: true },
      { id: "m2", clientKey: "naturalia", platform: "linkedin", accountId: "12345", name: "Naturalia LinkedIn", currency: "EUR", label: null, mode: null, source: "manual", enabled: true },
    );
    vi.mocked(listTikTokAdvertisers).mockResolvedValue([{ id: TT, name: "Naturalia TikTok FR", businessCenters: [] }]);
    vi.mocked(fetchTikTokDaily).mockResolvedValue(september({ purchases: 1, purchaseValue: 300 }));
    const data = await buildCockpit({ now, deadline: Date.now() + 10_000 });
    expect(store).toHaveLength(2);
    const naturalia = data.clients.find((c) => c.key === "naturalia")!;
    expect(naturalia.platforms.tiktok).toMatchObject({ label: "TikTok · Bio", mode: "roas" });
    expect(Object.values(naturalia.platforms).map((p) => p.plat)).toEqual(["tiktok"]);
    expect(metaSeries).not.toHaveBeenCalled();
    expect(googleSeries).not.toHaveBeenCalled();
  });

  it("keeps building when the TikTok listing fails", async () => {
    vi.mocked(listTikTokAdvertisers).mockRejectedValue(new Error("relay down"));
    const data = await buildCockpit({ now, deadline: Date.now() + 10_000 });
    expect(data.warnings.some((w) => w.includes("TikTok Ads"))).toBe(true);
    expect(data.unmatched).toEqual([{ key: "naturalia", name: "Naturalia", platforms: ["Meta", "TikTok"] }]);
  });
});

describe("cockpit view — TikTok scope", () => {
  it("shows a consultant the clients whose TikTok account is assigned to them", () => {
    const data = { clients: [{ key: "naturalia", eur_w0: 0, eur_base: 0, pacing: null, platforms: { tiktok: { plat: "tiktok", accountId: TT, err: null, pacing: null } } }], unmatched: [] } as unknown as CockpitData;
    const scope = (tiktok: string[]) => ({ all: false, meta: new Set<string>(), google: new Set<string>(), tiktok: new Set(tiktok) }) as unknown as AccountScope;
    expect(scopeData(data, scope([TT])).clients).toHaveLength(1);
    expect(scopeData(data, scope([])).clients).toHaveLength(0);
  });
});

describe("cockpit config — attach a TikTok account", () => {
  const put = async (account: Record<string, unknown>) =>
    (await PUT(new NextRequest("http://x/api/cockpit/global/config", { method: "PUT", body: JSON.stringify({ account }) })))!;

  it("attaches a listed advertiser with its name and currency", async () => {
    vi.mocked(listTikTokAdvertisers).mockResolvedValue([{ id: TT, name: "Naturalia TikTok FR", businessCenters: [] }]);
    const res = await put({ platform: "tiktok", accountId: ` ${TT} `, clientKey: "naturalia" });
    expect(res.status).toBe(200);
    expect(created).toEqual([expect.objectContaining({ clientKey: "naturalia", platform: "tiktok", accountId: TT, name: "Naturalia TikTok FR", currency: "EUR", source: "manual" })]);
  });

  it("falls back on TikTok itself for an advertiser outside the Business Centers", async () => {
    vi.mocked(listTikTokAdvertisers).mockResolvedValue([]);
    const res = await put({ platform: "tiktok", accountId: TT, clientKey: "gaia" });
    expect(res.status).toBe(200);
    expect(created[0]).toMatchObject({ clientKey: "gaia", name: "Naturalia TikTok FR", currency: "EUR" });
  });

  it("refuses an id that is not digits, or an advertiser TikTok does not know", async () => {
    expect((await put({ platform: "tiktok", accountId: "act_123", clientKey: "yoga" })).status).toBe(400);
    expect((await put({ platform: "linkedin", accountId: "123456", clientKey: "yoga" })).status).toBe(400);
    vi.mocked(listTikTokAdvertisers).mockResolvedValue([]);
    vi.mocked(checkAdvertiser).mockResolvedValue({ ok: false, error: "inconnu" });
    expect((await put({ platform: "tiktok", accountId: TT, clientKey: "yoga" })).status).toBe(404);
    expect(created).toHaveLength(0);
  });
});
