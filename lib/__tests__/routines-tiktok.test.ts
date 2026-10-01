/**
 * Routines — tiktok.insights: the advertisers come from the routine's
 * dashboard (never from the step), the figures from lib/tiktok-data.ts, the
 * ratios are computed here. TikTok, the relay and the database are stand-ins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const data = vi.hoisted(() => ({ fetchTikTokTotals: vi.fn(), fetchTikTokDaily: vi.fn(), fetchTikTokCampaigns: vi.fn() }));
// Only the reads are stand-ins; the helpers (emptyTikTokStats) stay the real ones.
vi.mock("@/lib/tiktok-data", async (original) => ({ ...(await original<typeof import("@/lib/tiktok-data")>()), ...data }));
const relayDirectTool = vi.hoisted(() => vi.fn());
vi.mock("@/lib/relay-tool", () => ({ relayDirectTool }));
const db = vi.hoisted(() => ({
  sources: [] as Array<{ dashboardId: string; externalId: string; label: string | null; config: string; status: string }>,
  routines: new Map<string, Record<string, unknown>>(),
  assigned: [] as Array<{ platform: string; accountId: string }>,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    dashboardSource: {
      findMany: vi.fn(async ({ where }: { where: { dashboardId: string; kind: string } }) =>
        db.sources.filter((s) => s.dashboardId === where.dashboardId && where.kind === "tiktok" && s.status !== "disabled")),
    },
    routine: { findUnique: async ({ where }: { where: { id: string } }) => db.routines.get(where.id) ?? null },
    userAdAccount: { findMany: async () => db.assigned },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  MAX_ADVERTISERS, TIKTOK_LEVELS, TIKTOK_METRICS, metricCells, routineTikTokAccounts, tiktokErrorClass, tiktokInsightsHandler,
} from "@/lib/routines/steps/tiktok-insights";
import { readsTikTok, routineForSession, routineTikTokIds } from "@/lib/routines/store";
import { STEP_WRITES, type StepContext, type TikTokInsightsStep } from "@/lib/routines/types";
import { emptyTikTokStats, type TikTokStats } from "@/lib/tiktok-data";

const A = "7123456789012345678";
const B = "7000000000000000001";
const routine: StepContext["routine"] = { id: "r1", name: "Test", metaAccountId: null, googleCustomerId: null, timezone: "Europe/Paris", maxItemsPerRun: 20, dashboardId: "dash1" };
const NOW = new Date("2026-09-29T08:00:00Z");
function context(over: Partial<StepContext["routine"]> = {}): StepContext {
  return {
    mode: "dry_run", routine: { ...routine, ...over }, runId: "run1", now: NOW, deadlineAt: Date.now() + 60_000,
    input: null, outputs: {}, write: null,
    claimItem: async () => { throw new Error("une lecture ne réserve pas d'élément"); },
    settleItem: async () => { throw new Error("une lecture ne solde pas d'élément"); },
  };
}
const step: TikTokInsightsStep = { id: "tt", type: "tiktok.insights", level: "account", window: "7d", metrics: ["spend", "ctr", "cpa", "roas"] };
const stats = (over: Partial<TikTokStats>): TikTokStats => ({ ...emptyTikTokStats(), ...over });
const source = (externalId: string, label: string | null, currency: string | null, over: Partial<(typeof db.sources)[number]> = {}) =>
  ({ dashboardId: "dash1", externalId, label, config: JSON.stringify({ currency, timezone: "Europe/Paris" }), status: "active", ...over });

beforeEach(() => {
  for (const fn of Object.values(data)) fn.mockReset();
  relayDirectTool.mockReset();
  db.sources = [source(A, "Jow FR", "EUR"), source(B, "Jow UK", "GBP")];
  db.routines.clear();
  db.assigned = [];
});

describe("tiktok.insights — contrat", () => {
  it("ne lit que : aucune écriture sur TikTok", () => {
    expect(STEP_WRITES["tiktok.insights"]).toBe("none");
    expect(tiktokInsightsHandler.writes).toBe("none");
  });

  it("accepte les listes fermées et reconstruit l'étape", () => {
    expect(tiktokInsightsHandler.validate({ ...step, metrics: ["spend", "spend", "roas"] })).toEqual({ ok: true, step: { ...step, metrics: ["spend", "roas"] } });
    for (const level of TIKTOK_LEVELS) expect(tiktokInsightsHandler.validate({ ...step, level }).ok).toBe(true);
    expect(tiktokInsightsHandler.validate({ ...step, metrics: [...TIKTOK_METRICS] }).ok).toBe(true);
  });

  it("refuse un compte écrit dans l'étape, un champ inconnu, une valeur hors liste", () => {
    for (const bad of [
      { ...step, advertiserId: A }, { ...step, advertiser_id: A }, { ...step, accountId: A }, { ...step, nameContains: "promo" },
      { ...step, level: "adgroup" }, { ...step, level: "ad" }, { ...step, window: "90d" }, { ...step, metrics: [] },
      { ...step, metrics: ["complete_payment"] }, { ...step, metrics: "spend" }, { ...step, type: "google.insights" },
    ]) expect(tiktokInsightsHandler.validate(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it("calcule les ratios, et null plutôt qu'une division par zéro", () => {
    expect(metricCells(stats({ spend: 123.456, impressions: 2000, clicks: 47, conversions: 4, purchases: 3, purchaseValue: 617.28, videoViews: 900 }), [...TIKTOK_METRICS]))
      .toEqual({ spend: 123.46, impressions: 2000, clicks: 47, ctr: 2.35, cpm: 61.73, conversions: 4, cpa: 30.86, purchases: 3, purchase_value: 617.28, roas: 5, video_views: 900 });
    expect(metricCells(emptyTikTokStats(), ["ctr", "cpm", "cpa", "roas"])).toEqual({ ctr: null, cpm: null, cpa: null, roas: null });
  });

  it("sépare l'erreur du compte de la panne passagère", () => {
    expect(tiktokErrorClass("TikTok 40001 : No permission to operate advertiser")).toBe("functional");
    expect(tiktokErrorClass("TikTok 40100 : Too many requests")).toBe("infra");
    expect(tiktokErrorClass("TikTok 50002 : internal error")).toBe("infra");
    expect(tiktokErrorClass("Relay unreachable")).toBe("infra");
  });
});

describe("tiktok.insights — comptes du client", () => {
  it("lit les comptes rattachés au dashboard, en service, sans doublon", async () => {
    db.sources.push(source(A, "doublon", "EUR"), source("7999999999999999999", "Coupé", "EUR", { status: "disabled" }), source("abc", "Faux", null));
    expect(await routineTikTokAccounts("dash1")).toEqual([
      { id: A, name: "Jow FR", currency: "EUR" },
      { id: B, name: "Jow UK", currency: "GBP" },
    ]);
    expect(await routineTikTokAccounts(null)).toEqual([]);
    expect(await routineTikTokAccounts("autre")).toEqual([]);
  });

  it("échoue fonctionnellement sans compte TikTok, sans rien demander à TikTok", async () => {
    for (const dashboardId of [null, undefined, "autre"]) {
      const out = await tiktokInsightsHandler.run(step, context({ dashboardId }));
      expect(out).toMatchObject({ status: "failed", error: { class: "functional", message: expect.stringContaining("aucun compte TikTok") } });
      expect(await tiktokInsightsHandler.preflight(step, { ...routine, dashboardId })).toMatchObject([{ severity: "error" }]);
    }
    expect(data.fetchTikTokTotals).not.toHaveBeenCalled();
    expect(relayDirectTool).not.toHaveBeenCalled();
  });

  it("vérifie chaque compte au préalable", async () => {
    relayDirectTool.mockImplementation(async (_tool: string, input: { advertiser_ids: string }) => {
      const [id] = JSON.parse(input.advertiser_ids) as string[];
      return id === A
        ? { code: 0, message: "OK", data: { list: [{ advertiser_id: A, name: "Jow FR", currency: "EUR" }] } }
        : { code: 40001, message: "No permission" };
    });
    const issues = await tiktokInsightsHandler.preflight(step, routine);
    expect(relayDirectTool).toHaveBeenCalledTimes(2);
    expect(relayDirectTool.mock.calls[0][0]).toBe("mcp-tiktok-ads.get_advertiser_info");
    expect(issues).toEqual([{ stepId: "tt", severity: "error", message: expect.stringContaining(`compte TikTok ${B}`) }]);
  });
});

describe("tiktok.insights — exécution", () => {
  it("niveau compte : une ligne par compte qui a diffusé, sur la fenêtre de la routine", async () => {
    data.fetchTikTokTotals.mockImplementation(async (id: string) =>
      id === A ? stats({ spend: 200, impressions: 10_000, clicks: 100, conversions: 4, purchaseValue: 1000 }) : emptyTikTokStats());
    const out = await tiktokInsightsHandler.run(step, context());
    expect(data.fetchTikTokTotals.mock.calls).toEqual([[A, "2026-09-22", "2026-09-28"], [B, "2026-09-22", "2026-09-28"]]);
    expect(out).toMatchObject({ status: "ok", rowsOut: 1, planned: [], written: [] });
    expect(out.output.rows).toEqual({
      columns: ["advertiser_id", "advertiser_name", "currency", "date_start", "date_stop", "spend", "ctr", "cpa", "roas"],
      truncated: false,
      rows: [{ advertiser_id: A, advertiser_name: "Jow FR", currency: "EUR", date_start: "2026-09-22", date_stop: "2026-09-28", spend: 200, ctr: 1, cpa: 50, roas: 5 }],
    });
  });

  it("niveau jour : une ligne par compte et par jour, datée de son jour", async () => {
    data.fetchTikTokDaily.mockImplementation(async (id: string) => (id === A
      ? [{ date: "2026-09-27", ...stats({ spend: 10, impressions: 100 }) }, { date: "2026-09-28", ...stats({ spend: 20, impressions: 400 }) }]
      : []));
    const out = await tiktokInsightsHandler.run({ ...step, level: "day", window: "month_to_date", metrics: ["spend", "cpm"] }, context());
    expect(data.fetchTikTokDaily).toHaveBeenCalledWith(A, "2026-09-01", "2026-09-28");
    expect(out.output.rows?.rows).toEqual([
      { advertiser_id: A, advertiser_name: "Jow FR", currency: "EUR", date_start: "2026-09-27", date_stop: "2026-09-27", spend: 10, cpm: 100 },
      { advertiser_id: A, advertiser_name: "Jow FR", currency: "EUR", date_start: "2026-09-28", date_stop: "2026-09-28", spend: 20, cpm: 50 },
    ]);
  });

  it("niveau campagne : les campagnes qui ont diffusé, les plus dépensières d'abord, tous comptes confondus", async () => {
    data.fetchTikTokCampaigns.mockImplementation(async (id: string) => (id === A
      ? [{ id: "c1", name: "Marque", objective: "CONVERSIONS", ...stats({ spend: 50, impressions: 10 }) }, { id: "c0", name: "Morte", objective: null, ...emptyTikTokStats() }]
      : [{ id: "c2", name: "UK", objective: "REACH", ...stats({ spend: 80, impressions: 10 }) }]));
    const out = await tiktokInsightsHandler.run({ ...step, level: "campaign", metrics: ["spend"] }, context());
    expect(out.output.rows?.columns).toEqual(["advertiser_id", "advertiser_name", "campaign_id", "campaign_name", "objective", "currency", "date_start", "date_stop", "spend"]);
    expect(out.output.rows?.rows.map((r) => [r.campaign_id, r.currency, r.spend])).toEqual([["c2", "GBP", 80], ["c1", "EUR", 50]]);
  });

  it("dit quand rien n'a diffusé, et ne lit pas plus de comptes que la limite", async () => {
    db.sources = Array.from({ length: MAX_ADVERTISERS + 2 }, (_, i) => source(`70000000000000000${String(i).padStart(2, "0")}`, `Compte ${i}`, "EUR"));
    data.fetchTikTokTotals.mockResolvedValue(emptyTikTokStats());
    const out = await tiktokInsightsHandler.run(step, context());
    expect(out).toMatchObject({ status: "ok", rowsOut: 0 });
    expect(data.fetchTikTokTotals).toHaveBeenCalledTimes(MAX_ADVERTISERS);
    expect(out.warnings.join(" ")).toContain("Aucune diffusion TikTok Ads");
    expect(out.warnings.join(" ")).toContain(`seuls les ${MAX_ADVERTISERS} premiers`);
  });

  it("classe l'échec : compte refusé par TikTok ou panne", async () => {
    data.fetchTikTokTotals.mockRejectedValue(new Error("TikTok 40001 : No permission"));
    expect(await tiktokInsightsHandler.run(step, context())).toMatchObject({ status: "failed", error: { class: "functional", message: expect.stringContaining("TikTok Ads") } });
    data.fetchTikTokTotals.mockRejectedValue(new Error("Relay unreachable"));
    expect(await tiktokInsightsHandler.run(step, context())).toMatchObject({ status: "failed", error: { class: "infra" } });
  });
});

describe("tiktok.insights — périmètre de la routine", () => {
  const definitionJson = JSON.stringify({ version: 1, steps: [{ id: "tt", type: "tiktok.insights", level: "account", window: "7d", metrics: ["spend"] }] });
  const ID = "cku1routine0001";

  it("ne compte les comptes TikTok que pour une routine qui les lit", async () => {
    expect(readsTikTok(definitionJson)).toBe(true);
    expect(readsTikTok(JSON.stringify({ version: 1, steps: [{ id: "g", type: "google.insights" }] }))).toBe(false);
    expect(readsTikTok("pas du json")).toBe(false);
    expect(await routineTikTokIds({ dashboardId: "dash1", definitionJson })).toEqual([A, B]);
    expect(await routineTikTokIds({ dashboardId: null, definitionJson })).toEqual([]);
    vi.mocked(prisma.dashboardSource.findMany).mockClear();
    expect(await routineTikTokIds({ dashboardId: "dash1", definitionJson: "{}" })).toEqual([]);
    expect(prisma.dashboardSource.findMany).not.toHaveBeenCalled();
  });

  it("refuse la routine à qui n'a pas ses comptes TikTok", async () => {
    db.routines.set(ID, { id: ID, dashboardId: "dash1", metaAccountId: null, googleCustomerId: null, definitionJson });
    const consultant = { userId: "u7", role: "consultant" };
    db.assigned = [{ platform: "tiktok", accountId: A }];
    expect((await routineForSession(consultant, ID)).status).toBe(403);
    db.assigned.push({ platform: "tiktok", accountId: B });
    expect((await routineForSession(consultant, ID)).status).toBe(200);
    db.assigned = [];
    expect((await routineForSession({ userId: "u1", role: "admin" }, ID)).status).toBe(200);
    // The same routine without a TikTok step does not ask for them.
    db.routines.set(ID, { ...db.routines.get(ID)!, definitionJson: "{}" });
    expect((await routineForSession(consultant, ID)).status).toBe(200);
  });
});
