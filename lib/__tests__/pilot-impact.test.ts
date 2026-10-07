import { describe, it, expect } from "vitest";
import {
  impactWindows, impactWindowsNow, impactDue, verdictOf, impactSummary, changedTotal, impactHqEntry, impactHqSlug, type ImpactResult, type Metrics,
} from "@/lib/pilot/impact";

const m = (spend: number, conversions: number, revenue: number | null = null): Metrics => ({ spend, conversions, revenue, clicks: 100, impressions: 10_000 });
const result = (objects: ImpactResult["objects"], horizon = 7): ImpactResult => ({
  horizon, currency: "EUR", objects,
  before: { since: "2026-09-24", until: "2026-09-30" }, after: { since: "2026-10-02", until: "2026-10-08" },
  account: { before: m(1000, 40), after: m(1100, 50) },
});
const noGoal = { metric: null, target: null, note: "" };

describe("bilan du pilotage — périodes", () => {
  it("N jours avant et N jours après le jour de la modification (heure de Paris), le jour même exclu", () => {
    // 1er octobre 23 h 30 à Paris = 21 h 30 UTC.
    expect(impactWindows(new Date("2026-10-01T21:30:00Z"), 7)).toEqual({
      before: { since: "2026-09-24", until: "2026-09-30" }, after: { since: "2026-10-02", until: "2026-10-08" },
    });
    // 1er octobre 23 h 30 UTC = 2 octobre à Paris.
    expect(impactWindows(new Date("2026-10-01T23:30:00Z"), 14).after).toEqual({ since: "2026-10-03", until: "2026-10-16" });
  });

  it("effet maintenant : les jours pleins jusqu'à hier, autant avant, 14 au plus, rien le jour même", () => {
    const at = new Date("2026-10-01T10:00:00Z");
    expect(impactWindowsNow(at, new Date("2026-10-02T09:00:00Z"))).toBeNull();
    expect(impactWindowsNow(at, new Date("2026-10-04T09:00:00Z"))).toEqual({ horizon: 2, before: { since: "2026-09-29", until: "2026-09-30" }, after: { since: "2026-10-02", until: "2026-10-03" } });
    expect(impactWindowsNow(at, new Date("2026-11-01T09:00:00Z"))?.horizon).toBe(14);
  });

  it("dû un jour après la fin de la période d'après (conversions tardives)", () => {
    const at = new Date("2026-10-01T10:00:00Z");
    expect(impactDue(at, 7, new Date("2026-10-08T20:00:00Z"))).toBe(false);
    expect(impactDue(at, 7, new Date("2026-10-09T05:00:00Z"))).toBe(false);
    expect(impactDue(at, 7, new Date("2026-10-10T05:00:00Z"))).toBe(true);
  });
});

describe("bilan du pilotage — verdict", () => {
  const obj = (before: Metrics | null, after: Metrics | null, extra = {}) => ({ objectId: "1", objectType: "campaign", name: "C", changes: [], before, after, ...extra });

  it("sans objectif : le CPA décide (plus bas = mieux)", () => {
    expect(verdictOf(result([obj(m(500, 10), m(500, 20))]), noGoal)).toMatchObject({ verdict: "improved", metric: "cpa", before: 50, after: 25 });
    expect(verdictOf(result([obj(m(500, 20), m(500, 10))]), noGoal).verdict).toBe("worse");
    expect(verdictOf(result([obj(m(500, 20), m(510, 20))]), noGoal).verdict).toBe("flat");
  });

  it("objectif ROAS : plus haut = mieux ; peu de conversions = volume trop faible", () => {
    expect(verdictOf(result([obj(m(100, 10, 300), m(100, 12, 500))]), { metric: "roas", target: 4, note: "" })).toMatchObject({ verdict: "improved", metric: "roas" });
    expect(verdictOf(result([obj(m(100, 2), m(100, 3))]), { metric: "roas", target: 4, note: "" }).verdict).toBe("low_volume");
  });

  it("objectif de dépense : juge la distance à la cible", () => {
    expect(verdictOf(result([obj(m(200, 10), m(290, 10))]), { metric: "spend", target: 300, note: "" }).verdict).toBe("improved");
    expect(verdictOf(result([obj(m(290, 10), m(500, 10))]), { metric: "spend", target: 300, note: "" }).verdict).toBe("worse");
  });

  it("un objet à l'intérieur d'un autre objet modifié n'est pas compté deux fois ; un objet illisible non plus", () => {
    const r = result([obj(m(500, 10), m(400, 10)), obj(m(200, 5), m(100, 5), { objectId: "2", objectType: "adset", insideChanged: true }), obj(m(999, 1), m(999, 1), { objectId: "3", error: "x" })]);
    expect(changedTotal(r)).toEqual({ before: m(500, 10), after: m(400, 10) });
  });

  it("le texte donne le verdict, les périodes, les chiffres et le compte ; l'entrée HQ cite l'auteur et la raison", () => {
    const r = result([obj(m(500, 10), m(500, 20))]);
    const { verdict, summary } = impactSummary(r, noGoal, "google");
    expect(verdict).toBe("improved");
    expect(summary).toContain("Bilan à J+7 — en progrès.");
    expect(summary).toContain("24/09–30/09");
    expect(summary).toContain("Compte Google Ads entier");
    const hq = impactHqEntry({ actionId: "abcdefgh12345678", clientName: "TSE", platform: "google", accountName: "TSE", accountId: "6823803493", authorName: "Melvin", executedAt: new Date("2026-10-01T10:00:00Z"), why: "CPA trop haut", goal: noGoal, changes: ["💶 Campagne « C » — budget journalier : 8 € → 9 €"], result: r, summary });
    expect(hq).toContain("Modification faite par Melvin");
    expect(hq).toContain("CPA trop haut");
    expect(hq).toContain("sans IA");
    expect(impactHqSlug("abcdefgh12345678", 14, new Date("2026-10-01T10:00:00Z"))).toBe("pilotage-bilan-j14-2026-10-01-12345678");
  });
});
