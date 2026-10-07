import { describe, expect, it } from "vitest";
import { canonicalTargeting, editsOf, readTargeting, summarizeTargeting, targetingDiff, withTargetingEdits, type Targeting } from "@/lib/pilot/targeting";
import { describeOperation, prepareOperation, type PilotObjectState } from "@/lib/pilot/ops";

const base: Targeting = {
  age_max: 65, age_min: 21,
  excluded_custom_audiences: [{ id: "1", name: "Purchase 730j" }],
  geo_locations: { countries: ["FR"], cities: [{ key: "12345", name: "Lyon" }], location_types: ["home", "recent"] },
  flexible_spec: [{ interests: [{ id: "6003", name: "Bricolage" }] }],
  targeting_automation: { advantage_audience: 1 },
  user_age_unknown: false,
};

describe("ciblage Meta — lecture et édition", () => {
  it("résume un ciblage en français", () => {
    expect(summarizeTargeting(base)).toEqual(["21–65 ans, tous", "lieux : France · 1 ville(s)", "exclues : Purchase 730j", "intérêts : Bricolage", "placements automatiques", "audience Advantage+ activée"]);
  });

  it("applique des modifications sans toucher au reste", () => {
    const after = withTargetingEdits(base, { ageMin: 25, ageMax: 54, genders: [2], countries: ["FR", "BE"], customAudiences: ["9"], publisherPlatforms: ["facebook", "instagram"], advantageAudience: false });
    expect(after.age_min).toBe(25);
    expect(after.genders).toEqual([2]);
    expect((after.geo_locations as Record<string, unknown>).countries).toEqual(["FR", "BE"]);
    expect((after.geo_locations as Record<string, unknown>).cities).toEqual([{ key: "12345", name: "Lyon" }]);
    expect(after.custom_audiences).toEqual([{ id: "9" }]);
    expect(after.excluded_custom_audiences).toEqual([{ id: "1", name: "Purchase 730j" }]);
    expect(after.publisher_platforms).toEqual(["facebook", "instagram"]);
    expect(after.flexible_spec).toEqual(base.flexible_spec);
    expect(after.targeting_automation).toEqual({ advantage_audience: 0 });
    expect(targetingDiff(base, after)).toEqual([
      "âge 21–65 ans → 25–54 ans", "genre tous → femmes", "pays France → France, Belgique", "audiences + #9", "placements automatiques → Facebook, Instagram", "audience Advantage+ activée → désactivée",
    ]);
    // Back to automatic placements: the positions of the platforms go too.
    const manual = { ...after, facebook_positions: ["feed"] };
    expect(withTargetingEdits(manual, { publisherPlatforms: null }).facebook_positions).toBeUndefined();
    expect(editsOf(after)).toMatchObject({ ageMin: 25, ageMax: 54, genders: [2], countries: ["FR", "BE"], customAudiences: ["9"], excludedCustomAudiences: ["1"], publisherPlatforms: ["facebook", "instagram"], advantageAudience: false });
  });

  it("refuse un ciblage sans lieu, un âge hors bornes, une clé inconnue ; compare sans l'ordre des clés", () => {
    expect(readTargeting({ age_min: 18 }).ok).toBe(false);
    expect(readTargeting({ ...base, age_min: 12 }).ok).toBe(false);
    expect(readTargeting({ ...base, evil: true }).ok).toBe(false);
    expect(readTargeting(JSON.stringify(base)).ok).toBe(true);
    expect(canonicalTargeting({ b: 1, a: { d: 1, c: 2 } })).toBe(canonicalTargeting('{"a":{"c":2,"d":1},"b":1}'));
  });
});

describe("ciblage Meta — opération du pilotage", () => {
  const adset: PilotObjectState = {
    id: "1200002", type: "adset", accountId: "555", name: "Retargeting 30j", status: "ACTIVE", effectiveStatus: "ACTIVE",
    dailyBudget: 3000, lifetimeBudget: null, endTime: null, bidAmount: null, parentName: "Prospection", targeting: JSON.stringify(base),
  };
  it("prépare le ciblage entier, avant et après, décrit par la différence ; même ciblage refusé ; Google refusé", () => {
    const after = withTargetingEdits(base, { ageMin: 25 });
    const op = prepareOperation({ kind: "set_targeting", objectType: "adset", objectId: "1200002", value: JSON.stringify(after) }, adset, "EUR", new Date(), "meta");
    expect(op).toMatchObject({ ok: true, op: { field: "targeting", before: JSON.stringify(base), double: null } });
    if (op.ok) expect(describeOperation(op.op, "EUR")).toBe("🎯 Ensemble de publicités « Retargeting 30j » (Prospection) — ciblage : âge 21–65 ans → 25–65 ans");
    expect(prepareOperation({ kind: "set_targeting", objectType: "adset", objectId: "1200002", value: JSON.stringify({ ...base }) }, adset, "EUR", new Date(), "meta").ok).toBe(false);
    expect(prepareOperation({ kind: "set_targeting", objectType: "adset", objectId: "1200002", value: JSON.stringify(after) }, adset, "EUR", new Date(), "google").ok).toBe(false);
    expect(prepareOperation({ kind: "set_targeting", objectType: "adset", objectId: "1200002", value: "{}" }, adset, "EUR", new Date(), "meta").ok).toBe(false);
  });
});
