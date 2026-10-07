import { describe, expect, it } from "vitest";
import { agencyChangesToActions, agencyMatcher, type AgencyChange } from "@/lib/pilot/agency";

const staff = [
  { name: "Pierre", email: "pierre@impulse-analytics.com" },
  { name: "Victoire", email: "victoire@impulse-analytics.com" },
  { name: "Sarah", email: "sarah.bondu@impulse-analytics.com" },
  { name: null, email: "bot@impulse-analytics.com" },
  { name: "Test User", email: "someone@gmail.com" },
];

describe("acteurs de l'agence", () => {
  const isAgency = agencyMatcher(staff, "Charlotte Durand");

  it("reconnaît les mails de l'agence sur Google", () => {
    expect(isAgency("mathilde@impulse-analytics.com", "mathilde@impulse-analytics.com")).toBe(true);
    expect(isAgency("vincent.guiraud@adesa.fr", "vincent.guiraud@adesa.fr")).toBe(false);
    expect(isAgency("Bulk Actions", "Bulk Actions")).toBe(false);
  });

  it("reconnaît les noms Meta par le prénom ou par le mail prénom.nom, et la liste en plus", () => {
    expect(isAgency("Pierre Ayel", null)).toBe(true);
    expect(isAgency("Victoire Wigniolle", null)).toBe(true);
    expect(isAgency("Sarah Bondu", null)).toBe(true);
    expect(isAgency("Charlotte Durand", null)).toBe(true);
    expect(isAgency("Nael HAMAMEH", null)).toBe(false);
    expect(isAgency("Orla Dallman", null)).toBe(false);
    expect(isAgency("Meta", null)).toBe(false);
    expect(isAgency("Conversion api", null)).toBe(false);
    expect(isAgency("", null)).toBe(false);
    // « Test User » has no agency email: its name does not make « Test » an agency first name.
    expect(isAgency("Test Account", null)).toBe(false);
  });
});

const change = (over: Partial<AgencyChange>): AgencyChange => ({
  id: "c", platform: "meta", accountId: "123", actorName: "Pierre Ayel", source: "external", at: "2026-10-03T10:00:00Z", pilotActionId: null,
  objectType: "campaign", objectName: "Prospection", field: "daily_budget", line: "Campagne « Prospection » : budget quotidien 50 € → 70 €", note: "", significant: true, accountName: "Naturalia", impact: null, ...over,
});

describe("changements de l'agence → actions du rapport", () => {
  it("regroupe une séance, garde le bilan le plus lointain, ignore ce qui vient du pilotage", () => {
    const rows = [
      change({ id: "a", at: "2026-10-03T10:00:00Z", impact: { horizon: 7, verdict: "improved", summary: "CPA 42 € → 35 €." } }),
      change({ id: "b", at: "2026-10-03T10:05:00Z", line: "Campagne « Retargeting » : en pause", note: "Stock épuisé", impact: { horizon: 14, verdict: "flat", summary: "Rien de net." } }),
      change({ id: "c", at: "2026-10-03T10:06:00Z", line: "Campagne « Retargeting » : en pause" }),
      change({ id: "d", at: "2026-10-05T09:00:00Z", pilotActionId: "pa1", line: "Depuis le pilotage" }),
      change({ id: "e", at: "2026-10-06T09:00:00Z", source: "impulsemotion", line: "API" }),
    ];
    const out = agencyChangesToActions(rows, { improved: "en progrès", flat: "stable" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ at: "2026-10-03", author: "Pierre Ayel", account: "Naturalia", origin: "plateforme", why: "Stock épuisé", verdict: "J+14 stable", effect: "Rien de net." });
    expect(out[0].lines).toEqual(["Campagne « Prospection » : budget quotidien 50 € → 70 €", "Campagne « Retargeting » : en pause"]);
  });

  it("tronque les longues séances", () => {
    const rows = Array.from({ length: 15 }, (_, i) => change({ id: `r${i}`, at: `2026-10-03T10:${String(i).padStart(2, "0")}:00Z`, line: `Ligne ${i}`, significant: i === 14 }));
    const out = agencyChangesToActions(rows, {});
    expect(out[0].lines).toHaveLength(9);
    expect(out[0].lines[0]).toBe("Ligne 14");
    expect(out[0].lines[8]).toBe("… et 7 autres modifications");
  });
});
