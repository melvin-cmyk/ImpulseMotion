import { describe, expect, it } from "vitest";
import { describeOperation, prepareOperation, sameValue, type PilotObjectState } from "@/lib/pilot/ops";
import { tiktokMutation } from "@/lib/pilot/tiktok";

const NOW = new Date("2026-10-07T10:00:00Z");
const adgroup = (over: Partial<PilotObjectState> = {}): PilotObjectState => ({
  id: "1700000000002", type: "adset", accountId: "7012345678901234567", name: "Prospection vidéo", status: "ACTIVE", effectiveStatus: "ACTIVE",
  dailyBudget: 2500, lifetimeBudget: null, endTime: "2026-12-31 23:59:59", startTime: "2026-01-01 00:00:00", bidAmount: 120,
  strategyLock: "la stratégie d'enchère TikTok se change dans TikTok Ads Manager.", endTimeLock: null, parentName: "Campagne TikTok", ...over,
});

describe("pilotage — TikTok Ads", () => {
  it("statut, budget, nom, date de fin et enchère d'un groupe ; le reste refusé avec la raison", () => {
    expect(prepareOperation({ kind: "set_status", objectType: "adset", objectId: "1700000000002", value: "PAUSED" }, adgroup(), "EUR", NOW, "tiktok")).toMatchObject({ ok: true, op: { field: "status", after: "PAUSED" } });
    expect(prepareOperation({ kind: "set_daily_budget", objectType: "adset", objectId: "1700000000002", value: 30 }, adgroup(), "EUR", NOW, "tiktok")).toMatchObject({ ok: true, op: { field: "daily_budget", before: 2500, after: 3000 } });
    expect(prepareOperation({ kind: "set_bid_amount", objectType: "adset", objectId: "1700000000002", value: "1,5" }, adgroup(), "EUR", NOW, "tiktok")).toMatchObject({ ok: true, op: { field: "bid_amount", before: 120, after: 150 } });
    const end = prepareOperation({ kind: "set_end_time", objectType: "adset", objectId: "1700000000002", value: "2026-11-30T23:00:00+01:00" }, adgroup(), "EUR", NOW, "tiktok");
    expect(end).toMatchObject({ ok: true, op: { field: "end_time", before: "2026-12-31 23:59:59", after: "2026-11-30 23:59:59" } });
    if (end.ok) expect(describeOperation(end.op, "EUR", "tiktok")).toBe("📅 Groupe d'annonces « Prospection vidéo » (Campagne TikTok) — date de fin : 31/12/2026 23:59 → 30/11/2026 23:59");
    expect(sameValue("end_time", "2026-11-30 23:59:59", "2026-11-30 23:59:59")).toBe(true);
    expect(prepareOperation({ kind: "set_target_cpa", objectType: "adset", objectId: "1700000000002", value: 10 }, adgroup(), "EUR", NOW, "tiktok").ok).toBe(false);
    expect(prepareOperation({ kind: "duplicate", objectType: "adset", objectId: "1700000000002", value: '{"name":"x"}' }, adgroup(), "EUR", NOW, "tiktok").ok).toBe(false);
    expect(prepareOperation({ kind: "set_end_time", objectType: "campaign", objectId: "1700000000001", value: "2026-11-30T23:00:00+01:00" }, { ...adgroup(), id: "1700000000001", type: "campaign", endTimeLock: null }, "EUR", NOW, "tiktok").ok).toBe(false);
    expect(prepareOperation({ kind: "rename", objectType: "ad", objectId: "1700000000003", value: "x" }, { ...adgroup(), id: "1700000000003", type: "ad" }, "EUR", NOW, "tiktok").ok).toBe(false);
  });

  it("les appels TikTok : un identifiant, un réglage, montants en unités de la devise", () => {
    expect(tiktokMutation("7012345678901234567", "1700000000001", "campaign", "status", "PAUSED", "EUR")).toEqual({ endpoint: "campaign/status/update", body: { advertiser_id: "7012345678901234567", campaign_ids: ["1700000000001"], operation_status: "DISABLE" } });
    expect(tiktokMutation("7012345678901234567", "1700000000002", "adset", "daily_budget", 3000, "EUR")).toEqual({ endpoint: "adgroup/update", body: { advertiser_id: "7012345678901234567", adgroup_id: "1700000000002", budget: 30 } });
    expect(tiktokMutation("7012345678901234567", "1700000000002", "adset", "bid_amount", 150, "EUR")).toEqual({ endpoint: "adgroup/update", body: { advertiser_id: "7012345678901234567", adgroup_id: "1700000000002", conversion_bid_price: 1.5, bid_price: 1.5 } });
    expect(tiktokMutation("7012345678901234567", "1700000000002", "adset", "end_time", "2026-11-30 23:59:59", "EUR")).toEqual({ endpoint: "adgroup/update", body: { advertiser_id: "7012345678901234567", adgroup_id: "1700000000002", schedule_end_time: "2026-11-30 23:59:59" } });
    expect(tiktokMutation("7012345678901234567", "1700000000003", "ad", "status", "DELETED", "EUR")).toEqual({ endpoint: "ad/status/update", body: { advertiser_id: "7012345678901234567", ad_ids: ["1700000000003"], operation_status: "DELETE" } });
    expect(tiktokMutation("7012345678901234567", "1700000000003", "ad", "name", "x", "EUR")).toBeNull();
    expect(tiktokMutation("7012345678901234567", "1700000000001", "campaign", "bid_amount", 1, "EUR")).toBeNull();
    expect(tiktokMutation("7012345678901234567", "1~2", "keyword", "status", "PAUSED", "EUR")).toBeNull();
  });
});
