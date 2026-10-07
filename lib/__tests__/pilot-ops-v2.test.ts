import { describe, expect, it } from "vitest";
import { describeOperation, inverseRequest, prepareOperation, readCopy, type PilotObjectState } from "@/lib/pilot/ops";
import { metaFieldsFor } from "@/lib/pilot/meta";
import { googleMutation } from "@/lib/pilot/google";

const NOW = new Date("2026-10-07T10:00:00Z");

const meta = (over: Partial<PilotObjectState> = {}): PilotObjectState => ({
  id: "1200002", type: "adset", accountId: "555", name: "Retargeting 30j", status: "ACTIVE", effectiveStatus: "ACTIVE",
  dailyBudget: 3000, lifetimeBudget: null, endTime: null, startTime: "2026-09-01T07:00:00+0000", bidAmount: null, bidStrategy: "LOWEST_COST_WITHOUT_CAP",
  targetCpa: null, targetRoas: null, spendCap: null, strategyLock: null, parentName: "Prospection", ...over,
});
const google = (over: Partial<PilotObjectState> = {}): PilotObjectState => ({
  id: "21025591832", type: "campaign", accountId: "6823803493", name: "Search Marque", status: "ACTIVE", effectiveStatus: "ACTIVE",
  dailyBudget: 800, lifetimeBudget: null, endTime: null, startTime: "2026-01-15", bidAmount: null, bidStrategy: "MAXIMIZE_CONVERSIONS",
  targetCpa: 4500, targetRoas: null, spendCap: null, strategyLock: null, parentName: "", budgetLock: null, endTimeLock: null, ...over,
});

describe("pilotage v2 — dates", () => {
  it("Meta : date de début dans le futur, en ISO ; Google : le jour (Paris), campagne pas encore commencée", () => {
    const m = prepareOperation({ kind: "set_start_time", objectType: "adset", objectId: "1200002", value: "2026-10-20T08:00:00+02:00" }, meta(), "EUR", NOW, "meta");
    expect(m).toMatchObject({ ok: true, op: { field: "start_time", before: "2026-09-01T07:00:00+0000", after: "2026-10-20T06:00:00.000Z" } });
    const started = prepareOperation({ kind: "set_start_time", objectType: "campaign", objectId: "21025591832", value: "2026-10-20T08:00:00+02:00" }, google(), "EUR", NOW, "google");
    expect(started.ok).toBe(false);
    const future = prepareOperation({ kind: "set_start_time", objectType: "campaign", objectId: "21025591832", value: "2026-10-20T00:30:00+02:00" }, google({ startTime: "2026-11-01" }), "EUR", NOW, "google");
    expect(future).toMatchObject({ ok: true, op: { field: "start_date", before: "2026-11-01", after: "2026-10-20" } });
    const past = prepareOperation({ kind: "set_start_time", objectType: "adset", objectId: "1200002", value: "2026-10-07T10:30:00Z" }, meta(), "EUR", NOW, "meta");
    expect(past.ok).toBe(false);
  });

  it("Google : date de fin = un jour, jamais avant le début ; groupe d'annonces verrouillé", () => {
    const ok = prepareOperation({ kind: "set_end_time", objectType: "campaign", objectId: "21025591832", value: "2026-12-31T23:00:00+01:00" }, google(), "EUR", NOW, "google");
    expect(ok).toMatchObject({ ok: true, op: { field: "end_date", before: null, after: "2026-12-31" } });
    const before = prepareOperation({ kind: "set_end_time", objectType: "campaign", objectId: "21025591832", value: "2026-10-20T23:00:00+01:00" }, google({ startTime: "2026-11-01" }), "EUR", NOW, "google");
    expect(before.ok).toBe(false);
    const group = prepareOperation({ kind: "set_end_time", objectType: "adset", objectId: "1", value: "2026-12-31T23:00:00+01:00" }, { ...google(), id: "1", type: "adset", endTimeLock: "pas de date de fin." }, "EUR", NOW, "google");
    expect(group.ok).toBe(false);
  });
});

describe("pilotage v2 — enchères et plafonds", () => {
  it("Meta : coût cible = cost cap + enchère, en une seule écriture ; ROAS minimum ×10 000 ; retour en automatique", () => {
    const cap = prepareOperation({ kind: "set_target_cpa", objectType: "adset", objectId: "1200002", value: "12,5" }, meta(), "EUR", NOW, "meta");
    expect(cap).toMatchObject({ ok: true, op: { field: "cost_cap", before: null, after: 1250 } });
    expect(metaFieldsFor("cost_cap", 1250)).toEqual({ bid_strategy: "COST_CAP", bid_amount: "1250" });
    expect(metaFieldsFor("roas_floor", 2.5)).toEqual({ bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", bid_constraints: '{"roas_average_floor":25000}' });
    const auto = prepareOperation({ kind: "set_bid_strategy", objectType: "adset", objectId: "1200002", value: "AUTO" }, meta({ bidStrategy: "COST_CAP", targetCpa: 1250 }), "EUR", NOW, "meta");
    expect(auto).toMatchObject({ ok: true, op: { field: "bid_strategy", before: "COST_CAP", after: "LOWEST_COST_WITHOUT_CAP" } });
    expect(prepareOperation({ kind: "set_bid_strategy", objectType: "adset", objectId: "1200002", value: "COST_CAP" }, meta(), "EUR", NOW, "meta").ok).toBe(false);
    // Under a campaign budget (CBO) the ad set carries no strategy: refused with the reason.
    const cbo = prepareOperation({ kind: "set_target_cpa", objectType: "adset", objectId: "1200002", value: 10 }, meta({ bidStrategy: null }), "EUR", NOW, "meta");
    expect(cbo).toMatchObject({ ok: false });
    expect(describeOperation({ kind: "set_target_cpa", objectType: "adset", objectName: "R", field: "cost_cap", before: null, after: 1250 }, "EUR").replace(/[  ]/g, " ")).toBe("🎯 Ensemble de publicités « R » — coût cible (cost cap) : — → 12,50 €");
    expect(inverseRequest({ kind: "set_target_cpa", objectType: "adset", objectId: "1", field: "cost_cap", before: 1000, after: 1250 }, "EUR")).toEqual({ kind: "set_target_cpa", objectType: "adset", objectId: "1", value: 10 });
    expect(inverseRequest({ kind: "set_bid_strategy", objectType: "adset", objectId: "1", field: "bid_strategy", before: "COST_CAP", after: "LOWEST_COST_WITHOUT_CAP" }, "EUR")).toBeNull();
  });

  it("Google : CPA cible selon la stratégie (masque imbriqué), ROAS cible, stratégie sans cible verrouillée", () => {
    const cpa = prepareOperation({ kind: "set_target_cpa", objectType: "campaign", objectId: "21025591832", value: 40 }, google(), "EUR", NOW, "google");
    expect(cpa).toMatchObject({ ok: true, op: { field: "target_cpa", before: 4500, after: 4000 } });
    expect(googleMutation("6823803493", "21025591832", "campaign", "target_cpa", 4000, "EUR", null, "MAXIMIZE_CONVERSIONS")).toEqual({
      resource: "campaigns", operation: { update: { resourceName: "customers/6823803493/campaigns/21025591832", maximizeConversions: { targetCpaMicros: "40000000" } }, updateMask: "maximize_conversions.target_cpa_micros" },
    });
    expect(googleMutation("6823803493", "21025591832", "campaign", "target_roas", 3.5, "EUR", null, "TARGET_ROAS")).toEqual({
      resource: "campaigns", operation: { update: { resourceName: "customers/6823803493/campaigns/21025591832", targetRoas: { targetRoas: 3.5 } }, updateMask: "target_roas.target_roas" },
    });
    expect(googleMutation("6823803493", "21025591832", "campaign", "target_cpa", 4000, "EUR", null, "MANUAL_CPC")).toBeNull();
    expect(googleMutation("6823803493", "21025591832", "campaign", "end_date", "2026-12-31", "EUR")).toEqual({
      resource: "campaigns", operation: { update: { resourceName: "customers/6823803493/campaigns/21025591832", endDate: "2026-12-31" }, updateMask: "end_date" },
    });
    const locked = prepareOperation({ kind: "set_target_roas", objectType: "campaign", objectId: "21025591832", value: 3 }, google({ strategyLock: "sa stratégie n'a pas de cible." }), "EUR", NOW, "google");
    expect(locked).toEqual({ ok: false, error: "la campagne « Search Marque » : sa stratégie n'a pas de cible." });
    expect(prepareOperation({ kind: "set_spend_cap", objectType: "campaign", objectId: "21025591832", value: 500 }, google(), "EUR", NOW, "google").ok).toBe(false);
  });

  it("Meta : plafond de dépense d'une campagne, 100 au moins", () => {
    const c = meta({ type: "campaign", id: "1200001", parentName: "", spendCap: null });
    expect(prepareOperation({ kind: "set_spend_cap", objectType: "campaign", objectId: "1200001", value: 50 }, c, "EUR", NOW, "meta").ok).toBe(false);
    expect(prepareOperation({ kind: "set_spend_cap", objectType: "campaign", objectId: "1200001", value: 1500 }, c, "EUR", NOW, "meta")).toMatchObject({ ok: true, op: { field: "spend_cap", before: null, after: 150000 } });
  });
});

describe("pilotage v2 — duplication", () => {
  it("une copie en pause sous un autre nom, Meta seulement, jamais remise en place", () => {
    expect(readCopy('{"name":"  Retargeting 30j — copie  "}')).toEqual({ ok: true, spec: { name: "Retargeting 30j — copie" } });
    expect(readCopy('{"name":""}').ok).toBe(false);
    const op = prepareOperation({ kind: "duplicate", objectType: "adset", objectId: "1200002", value: '{"name":"Retargeting 30j — copie"}' }, meta(), "EUR", NOW, "meta");
    expect(op).toMatchObject({ ok: true, op: { field: "copy", before: null, double: null, irreversible: false } });
    expect(prepareOperation({ kind: "duplicate", objectType: "adset", objectId: "1200002", value: '{"name":"Retargeting 30j"}' }, meta(), "EUR", NOW, "meta").ok).toBe(false);
    expect(prepareOperation({ kind: "duplicate", objectType: "campaign", objectId: "21025591832", value: '{"name":"x"}' }, google(), "EUR", NOW, "google").ok).toBe(false);
    expect(describeOperation({ kind: "duplicate", objectType: "adset", objectName: "R", field: "copy", before: null, after: '{"name":"R2"}' }, "EUR")).toBe("📋 Ensemble de publicités « R » — dupliqué en « R2 » (créée en pause)");
    expect(inverseRequest({ kind: "duplicate", objectType: "adset", objectId: "1", field: "copy", before: null, after: '{"name":"R2"}' }, "EUR")).toBeNull();
  });
});
