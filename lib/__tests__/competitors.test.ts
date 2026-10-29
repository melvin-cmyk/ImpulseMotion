import { describe, expect, it } from "vitest";
import {
  addCompetitor, brandKey, cleanBrand, competitorChips, landingDomains, mergeCompetitors, needsSuggestions, parseSetting,
  parseSuggestions, parseSuggestionsSetting, removeCompetitor, suggestionPrompt, suggestionsFresh,
} from "@/lib/competitors-core";
import { parseFollowUpQuick, parseQuickIntent, withClientAliases } from "@/lib/mo/intents";

const empty = { saved: [], removed: [] };

describe("competitors — names", () => {
  it("cleans and folds brand names", () => {
    expect(cleanBrand("  - « La  Fourche ». ")).toBe("La Fourche");
    expect(cleanBrand("x")).toBe("");
    expect(cleanBrand(42)).toBe("");
    expect(brandKey("Aroma-Zone")).toBe(brandKey("aroma zone"));
    expect(brandKey("Écolo")).toBe("ecolo");
  });

  it("reads a broken setting as empty", () => {
    expect(parseSetting("not json")).toEqual(empty);
    expect(parseSetting(JSON.stringify({ saved: ["Greenweez", "greenweez", 3], removed: ["Biocoop"] }))).toEqual({ saved: ["Greenweez"], removed: ["Biocoop"] });
    expect(parseSuggestionsSetting("{}")).toBeNull();
  });
});

describe("competitors — edits", () => {
  it("adds first and un-hides a removed name", () => {
    const s = addCompetitor({ saved: ["Biocoop"], removed: ["Greenweez"] }, "greenweez ");
    expect(s.saved).toEqual(["greenweez", "Biocoop"]);
    expect(s.removed).toEqual([]);
  });

  it("removes from the saved ones and hides HQ / AI names", () => {
    const s = removeCompetitor({ saved: ["Biocoop", "Greenweez"], removed: [] }, "biocoop");
    expect(s.saved).toEqual(["Greenweez"]);
    const list = mergeCompetitors({ setting: s, hq: ["Biocoop", "La Vie Claire"], suggested: [] });
    expect(list.map((c) => c.name)).toEqual(["Greenweez", "La Vie Claire"]);
  });
});

describe("competitors — merge", () => {
  it("orders saved, HQ, suggested without duplicates nor the client itself", () => {
    const list = mergeCompetitors({ setting: { saved: ["Greenweez"], removed: [] }, hq: ["greenweez", "Biocoop"], suggested: ["La Vie Claire", "Naturalia", "Bio c' Bon"], clientName: "Naturalia" });
    expect(list).toEqual([
      { name: "Greenweez", origin: "saved" },
      { name: "Biocoop", origin: "hq" },
      { name: "La Vie Claire", origin: "suggested" },
      { name: "Bio c' Bon", origin: "suggested" },
    ]);
  });

  it("asks the AI below 3 confirmed names", () => {
    expect(needsSuggestions([{ name: "A", origin: "saved" }, { name: "B", origin: "hq" }, { name: "C", origin: "suggested" }])).toBe(true);
    expect(needsSuggestions([{ name: "A", origin: "saved" }, { name: "B", origin: "hq" }, { name: "C", origin: "saved" }])).toBe(false);
  });

  it("keeps suggestions 30 days", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(suggestionsFresh({ names: ["A"], at: "2026-10-10T12:00:00Z" }, now)).toBe(true);
    expect(suggestionsFresh({ names: ["A"], at: "2026-09-20T12:00:00Z" }, now)).toBe(false);
    expect(suggestionsFresh(null, now)).toBe(false);
  });
});

describe("competitors — AI call", () => {
  it("takes the landing domains, most frequent first", () => {
    expect(landingDomains(["https://www.naturalia.fr/a?x=1", "https://naturalia.fr/b", "https://shop.naturalia.fr", "https://www.facebook.com/x", "nope", null])).toEqual(["naturalia.fr", "shop.naturalia.fr"]);
  });

  it("builds a bounded prompt", () => {
    const p = suggestionPrompt({ clientName: "Naturalia", domains: ["naturalia.fr"], adTexts: ["Le bio à prix doux toute l'année", "Le bio à prix doux toute l'année", "court"], brief: "### Client\nRéseau de magasins bio", known: ["Biocoop"] });
    expect(p).toContain("Client : Naturalia");
    expect(p).toContain("naturalia.fr");
    expect(p.match(/prix doux/g)).toHaveLength(1);
    expect(p).not.toContain("court");
    expect(p).toContain("ne les répète pas) : Biocoop");
  });

  it("reads the model's answer in any shape", () => {
    expect(parseSuggestions('Voici :\n```json\n{"competitors": ["Biocoop", "La Vie Claire", "Naturalia", "Greenweez", "Bio c\' Bon", "Satoriz"]}\n```', "Naturalia")).toEqual(["Biocoop", "La Vie Claire", "Greenweez", "Bio c' Bon", "Satoriz"]);
    expect(parseSuggestions('["Emma", {"name": "Tediber"}]')).toEqual(["Emma", "Tediber"]);
    expect(parseSuggestions("1. Emma\n2. Tediber\n- Hypnia")).toEqual(["Emma", "Tediber", "Hypnia"]);
    expect(parseSuggestions("")).toEqual([]);
  });
});

describe("competitors — Mo chips", () => {
  const clients = withClientAliases([{ id: "a1", name: "Naturalia", dashboardId: null, aliasIds: [] }, { id: "b2", name: "La Fourche", dashboardId: null, aliasIds: [] }]);

  it("words each chip so that the quick path reads the brand and the client", () => {
    const chips = competitorChips(["Greenweez", "Bio c' Bon", "Une marque au nom vraiment beaucoup trop longue", "Nature et Découvertes"], "Naturalia");
    expect(chips).toEqual(["Pubs du concurrent Greenweez pour Naturalia", "Pubs du concurrent Bio c' Bon pour Naturalia", "Pubs du concurrent Nature et Découvertes pour Naturalia"]);
    for (const c of chips) expect(c.length).toBeLessThanOrEqual(60);
    expect(parseQuickIntent(chips[0], clients)).toBeNull();
    expect(parseFollowUpQuick(chips[0], clients)).toMatchObject({ kind: "competitor_ads", brands: ["Greenweez"], client: { id: "a1" } });
    expect(parseFollowUpQuick(chips[1], clients)).toMatchObject({ kind: "competitor_ads", brands: ["Bio c Bon"], client: { id: "a1" } });
    expect(parseFollowUpQuick(chips[2], clients)).toMatchObject({ kind: "competitor_ads", brands: ["Nature et Découvertes"], client: { id: "a1" } });
  });

  it("keeps « les concurrents de X » as the client's competitors", () => {
    expect(parseFollowUpQuick("que font les concurrents de Naturalia", clients)).toMatchObject({ kind: "competitor_ads", brands: [], client: { id: "a1" } });
    expect(parseFollowUpQuick("montre les concurrents de La Fourche", clients)).toMatchObject({ kind: "competitor_ads", brands: [], client: { id: "b2" } });
    // Another client of the agency can be a competitor; the client itself cannot.
    expect(parseFollowUpQuick("pubs du concurrent La Fourche pour Naturalia", clients)).toMatchObject({ brands: ["La Fourche"], client: { id: "a1" } });
    expect(parseFollowUpQuick("pubs du concurrent Naturalia pour Naturalia", clients)).not.toMatchObject({ brands: ["Naturalia"], client: { id: "a1" } });
  });
});
