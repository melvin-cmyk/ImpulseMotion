/**
 * TikTok in the budgets (/me/budgets, pacing) and the account settings: the
 * spend comes from lib/tiktok-data.ts, the profile (currency, timezone, name)
 * from checkAdvertiser, the advertiser must be in the person's scope. TikTok,
 * the relay, Meta and the database are stand-ins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const data = vi.hoisted(() => ({ fetchTikTokTotals: vi.fn(), fetchTikTokDaily: vi.fn(), fetchTikTokCampaigns: vi.fn() }));
vi.mock("@/lib/tiktok-data", async (original) => ({ ...(await original<typeof import("@/lib/tiktok-data")>()), ...data }));
const relayDirectTool = vi.hoisted(() => vi.fn());
vi.mock("@/lib/relay-tool", () => ({ relayDirectTool }));
const metaInsights = vi.hoisted(() => vi.fn());
vi.mock("@/lib/insights", () => ({
  getAccountInsightsCachedWithMeta: metaInsights,
  getAccountProfileCached: async () => ({ currency: "EUR", timezone_name: "Europe/Paris" }),
}));
vi.mock("@/lib/meta-api", () => ({ getMetaSystemToken: () => "token" }));

const db = vi.hoisted(() => ({
  settings: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<Record<string, unknown>>,
  budgets: [] as Array<Record<string, unknown>>,
  assigned: [] as Array<{ platform: string; accountId: string }>,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    accountSetting: {
      findFirst: async ({ where }: { where: { platform: string; OR: Array<{ accountId: string }> } }) =>
        db.settings.find((s) => s.platform === where.platform && where.OR.some((o) => o.accountId === s.accountId)) ?? null,
      findMany: async ({ where }: { where?: { platform?: string } } = {}) => db.settings.filter((s) => !where?.platform || s.platform === where.platform),
      upsert: async (args: { where: { platform_accountId: { platform: string; accountId: string } }; create: Record<string, unknown> }) => {
        db.upserts.push(args as unknown as Record<string, unknown>);
        return { ...args.create };
      },
    },
    accountBudget: {
      findMany: async () => db.budgets,
      upsert: async (args: { create: Record<string, unknown> }) => { db.upserts.push(args as unknown as Record<string, unknown>); return { id: "b-new", ...args.create }; },
    },
    userAdAccount: {
      findMany: async () => db.assigned,
      count: async ({ where }: { where: { platform: string; OR: Array<{ accountId: string }> } }) =>
        db.assigned.filter((a) => a.platform === where.platform && where.OR.some((o) => o.accountId === a.accountId)).length,
    },
  },
}));

let session: { userId: string; role: string } | null = null;
vi.mock("@/lib/auth-helpers", () => ({
  requireSession: async () => (session ? { session } : { error: Response.json({ error: "unauthorized" }, { status: 401 }) }),
  requireStaff: async () => (session && session.role !== "client" ? { session } : { error: Response.json({ error: "forbidden" }, { status: 403 }) }),
}));

import { computePacing, computePacingBatch } from "@/lib/budgets";
import { clearTikTokProfileCache, getAccountProfileSettings } from "@/lib/account-settings";
import * as budgetsHandlers from "@/app/api/me/budgets/route";
import * as settingsHandlers from "@/app/api/admin/account-settings/route";

// The handlers are typed as possibly answering nothing; here they always answer.
const budgetsRoute = {
  GET: async (r: NextRequest) => (await budgetsHandlers.GET(r))!,
  POST: async (r: NextRequest) => (await budgetsHandlers.POST(r))!,
};
const settingsRoute = {
  GET: async (r: NextRequest) => (await settingsHandlers.GET(r))!,
  PUT: async (r: NextRequest) => (await settingsHandlers.PUT(r))!,
};

const A = "7123456789012345678";
const B = "7000000000000000001";
const NOW = new Date("2026-09-15T10:00:00Z");
const advertiserInfo = (id: string) => ({ code: 0, message: "OK", data: { list: [{ advertiser_id: id, name: "Jow FR", currency: "eur", display_timezone: "Europe/Paris" }] } });
const json = (url: string, method = "GET", body?: unknown) =>
  new NextRequest(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(() => {
  for (const fn of Object.values(data)) fn.mockReset();
  relayDirectTool.mockReset();
  metaInsights.mockReset();
  clearTikTokProfileCache();
  db.settings = []; db.upserts = []; db.budgets = []; db.assigned = [];
  session = { userId: "u1", role: "consultant" };
});

describe("profil d'un compte TikTok (account settings)", () => {
  it("lit devise, fuseau et nom chez TikTok, les garde en secours, et les met en cache", async () => {
    relayDirectTool.mockResolvedValue(advertiserInfo(A));
    const p = await getAccountProfileSettings("tiktok", A);
    expect(p).toEqual({ aov: null, currency: "EUR", timezone: "Europe/Paris", conversionEvent: "purchase", name: "Jow FR" });
    expect(relayDirectTool).toHaveBeenCalledWith("mcp-tiktok-ads.get_advertiser_info", { advertiser_ids: JSON.stringify([A]) }, 20000);
    expect(db.upserts[0]).toMatchObject({ where: { platform_accountId: { platform: "tiktok", accountId: A } }, create: { currency: "EUR", timezone: "Europe/Paris" } });
    await getAccountProfileSettings("tiktok", A);
    expect(relayDirectTool).toHaveBeenCalledTimes(1);
  });

  it("retombe sur la ligne enregistrée quand TikTok ne répond pas", async () => {
    db.settings = [{ platform: "tiktok", accountId: A, aov: 30, currency: "GBP", timezone: "Europe/London", conversionEvent: null }];
    relayDirectTool.mockRejectedValue(new Error("Relay unreachable"));
    expect(await getAccountProfileSettings("tiktok", A)).toEqual({ aov: 30, currency: "GBP", timezone: "Europe/London", conversionEvent: "purchase", name: null });
    expect(db.upserts).toHaveLength(0);
  });

  it("route admin : enregistre un réglage TikTok dans le périmètre, refuse le reste", async () => {
    const put = (body: unknown) => settingsRoute.PUT(json("http://x/api/admin/account-settings", "PUT", body));
    db.assigned = [{ platform: "tiktok", accountId: A }];
    expect((await put({ platform: "tiktok", accountId: "pas un id", aov: 40 })).status).toBe(400);
    expect((await put({ platform: "snapchat", accountId: A })).status).toBe(400);
    expect((await put({ platform: "tiktok", accountId: B, aov: 40 })).status).toBe(403);
    // An advertiser id assigned on TikTok does not open the same digits on Meta.
    expect((await put({ platform: "meta", accountId: A, aov: 40 })).status).toBe(403);
    const ok = await put({ platform: "tiktok", accountId: ` ${A} `, aov: 40, currency: "EUR" });
    expect(ok.status).toBe(200);
    expect(db.upserts.at(-1)).toMatchObject({ where: { platform_accountId: { platform: "tiktok", accountId: A } }, create: { aov: 40, currency: "EUR" } });
  });

  it("route admin : donne le profil TikTok d'un compte demandé", async () => {
    db.assigned = [{ platform: "tiktok", accountId: A }];
    relayDirectTool.mockResolvedValue(advertiserInfo(A));
    const res = await settingsRoute.GET(json(`http://x/api/admin/account-settings?platform=tiktok&accountId=${A}`));
    expect(res.status).toBe(200);
    expect((await res.json()).profile).toMatchObject({ currency: "EUR", timezone: "Europe/Paris", name: "Jow FR" });
    expect((await settingsRoute.GET(json(`http://x/api/admin/account-settings?platform=tiktok&accountId=${B}`))).status).toBe(403);
  });
});

describe("pacing d'un budget TikTok", () => {
  it("lit la dépense des jours clos chez TikTok, dans le fuseau du compte", async () => {
    data.fetchTikTokTotals.mockResolvedValue({ spend: 1400, impressions: 1, clicks: 0, conversions: 0, purchases: 0, purchaseValue: 0, videoViews: 0 });
    const p = await computePacing(A, 3000, "EUR", { platform: "tiktok", tz: "Europe/Paris", now: NOW });
    expect(data.fetchTikTokTotals).toHaveBeenCalledWith(A, "2026-09-01", "2026-09-14");
    expect(metaInsights).not.toHaveBeenCalled();
    expect(p).toMatchObject({ accountId: A, mtdSpend: 1400, dailyRunRate: 100, projectedSpend: 3000, pacingPct: 100, status: "on_track" });
  });

  it("dit « inconnu » plutôt qu'un faux retard quand TikTok ne répond pas", async () => {
    data.fetchTikTokTotals.mockRejectedValue(new Error("TikTok 40100 : Too many requests"));
    const [p] = await computePacingBatch([{ accountId: A, monthlyTarget: 3000, currency: "EUR", platform: "tiktok" }], { now: NOW });
    expect(p).toMatchObject({ status: "unknown", reason: expect.stringContaining("40100") });
  });

  it("client TikTok seul sans compte dans la devise du budget : « inconnu », jamais un faux sous-investissement", async () => {
    const p = await computePacing(A, 10000, "EUR", { skipMeta: true, tiktokAdvertiserIds: [], tz: "Europe/Paris", now: NOW });
    expect(p).toMatchObject({ status: "unknown", mtdSpend: 0, reason: expect.stringContaining("devise") });
    expect(data.fetchTikTokTotals).not.toHaveBeenCalled();
    expect(metaInsights).not.toHaveBeenCalled();
  });

  it("reste sur Meta par défaut", async () => {
    metaInsights.mockResolvedValue({ data: { spend: "700" }, fetchedAt: "2026-09-15T09:00:00Z" });
    const p = await computePacing("act_123456789", 1500, "EUR", { tz: "Europe/Paris", now: NOW });
    expect(p.mtdSpend).toBe(700);
    expect(data.fetchTikTokTotals).not.toHaveBeenCalled();
  });
});

describe("/api/me/budgets avec TikTok", () => {
  const post = (body: unknown) => budgetsRoute.POST(json("http://x/api/me/budgets", "POST", body));

  it("crée un budget TikTok sur un compte du périmètre, et seulement là", async () => {
    db.assigned = [{ platform: "tiktok", accountId: A }];
    expect((await post({ accountId: B, platform: "tiktok", monthlyTarget: 3000 })).status).toBe(403);
    expect((await post({ accountId: "abc", platform: "tiktok", monthlyTarget: 3000 })).status).toBe(400);
    expect((await post({ accountId: A, platform: "google", monthlyTarget: 3000 })).status).toBe(400);
    const res = await post({ accountId: A, platform: "tiktok", monthlyTarget: 3000, currency: "EUR" });
    expect(res.status).toBe(200);
    expect(db.upserts.at(-1)).toMatchObject({ create: { userId: "u1", platform: "tiktok", accountId: A, monthlyTarget: 3000, currency: "EUR" } });
  });

  it("garde la règle Meta : compte attribué, ou administrateur", async () => {
    expect((await post({ accountId: "act_123456789", monthlyTarget: 1000 })).status).toBe(403);
    db.assigned = [{ platform: "meta", accountId: "123456789" }];
    expect((await post({ accountId: "act_123456789", monthlyTarget: 1000 })).status).toBe(200);
    expect(db.upserts.at(-1)).toMatchObject({ create: { platform: "meta" } });
  });

  it("donne à chaque budget le pacing de sa plateforme", async () => {
    db.budgets = [
      { id: "b1", userId: "u1", platform: "tiktok", accountId: A, monthlyTarget: 3000, currency: "EUR" },
      { id: "b2", userId: "u1", platform: "meta", accountId: "123456789", monthlyTarget: 1500, currency: "EUR" },
    ];
    relayDirectTool.mockResolvedValue(advertiserInfo(A));
    data.fetchTikTokTotals.mockResolvedValue({ spend: 1400, impressions: 1, clicks: 0, conversions: 0, purchases: 0, purchaseValue: 0, videoViews: 0 });
    metaInsights.mockResolvedValue({ data: { spend: "700" }, fetchedAt: "2026-09-15T09:00:00Z" });
    // Mid-month: on the 1st no day is closed and nothing is read.
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const res = await budgetsRoute.GET(json("http://x/api/me/budgets?withPacing=1")).finally(() => vi.useRealTimers());
    const body = await res.json() as { budgets: Array<{ id: string; pacing: { accountId: string; mtdSpend: number } | null }> };
    expect(body.budgets.map((b) => [b.id, b.pacing?.accountId])).toEqual([["b1", A], ["b2", "123456789"]]);
    expect(data.fetchTikTokTotals).toHaveBeenCalledTimes(1);
    expect(metaInsights).toHaveBeenCalledTimes(1);
  });
});
