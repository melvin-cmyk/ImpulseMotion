import { describe, expect, it } from "vitest";
import { nameKey, parseClientYamlAccounts, parseClientsRegistry, suggestFor, type HqProjectInfo } from "@/lib/hq-matching";

const REGISTRY = `# Registre
version: 1
clients:
  bazile:
    nom: Bazile
    skills: [monthly-bazile]

  cours-legendre:
    nom: Cours Legendre
    skills: []
  gaia:
    nom: Gaia US
    note: >-
      Périmètre US.
  jow:
    nom: "Jow (FR)"
transverses:
  slides-impulse:
    nom: Pas un client
`;

const CLIENT_YAML = `slug: cours-legendre
comptes:
  google_ads:
    cid: "238-911-9715"
  meta_ads:
    account_id: act_595800441007042
    pixel_id: "204818197470340"
`;

const projects: HqProjectInfo[] = [
  { slug: "cours-legendre", name: "cours-legendre", registryName: "Cours Legendre", accounts: ["meta:595800441007042", "google:2389119715"], hasClientYaml: true },
  { slug: "bazile", name: "bazile", registryName: "Bazile", accounts: [], hasClientYaml: false },
  { slug: "gaia", name: "gaia", registryName: "Gaia US", accounts: [], hasClientYaml: false },
  { slug: "leroy-merlin", name: "leroy-merlin", registryName: "Leroy Merlin South Africa", accounts: [], hasClientYaml: false },
  { slug: "avv-beaba-03af7f543a35", name: "AVV BEABA", registryName: null, accounts: [], hasClientYaml: false },
];

describe("parseClientsRegistry", () => {
  it("reads slug → nom of the clients block only", () => {
    const r = parseClientsRegistry(REGISTRY);
    expect(r).toEqual({ bazile: "Bazile", "cours-legendre": "Cours Legendre", gaia: "Gaia US", jow: "Jow (FR)" });
  });
});

describe("parseClientYamlAccounts", () => {
  it("finds the Meta account and the Google cid with or without dashes", () => {
    expect(parseClientYamlAccounts(CLIENT_YAML).sort()).toEqual(["google:2389119715", "meta:595800441007042"]);
    expect(parseClientYamlAccounts("cid: 2389119715\n")).toEqual(["google:2389119715"]);
    expect(parseClientYamlAccounts("pixel_id: 204818197470340")).toEqual([]);
  });
});

describe("nameKey", () => {
  it("ignores accents, punctuation, years and « new »", () => {
    expect(nameKey("Cours Legendre — Cours Legendre 2023")).toBe("courslegendrecourslegendre");
    expect(nameKey("Bonne Maison - New")).toBe("bonnemaison");
    expect(nameKey("Saveurs & Vie")).toBe("saveursvie");
  });
});

describe("suggestFor", () => {
  it("prefers an account id over a name", () => {
    const r = suggestFor({ name: "Quelque chose", accounts: [{ platform: "meta", accountId: "595800441007042" }] }, projects);
    expect(r.candidates[0]).toMatchObject({ slug: "cours-legendre", level: "compte" });
    expect(r.ambiguous).toBe(false);
  });
  it("matches an identical name, then a close one", () => {
    expect(suggestFor({ name: "Bazile", accounts: [{ platform: "google", accountId: "5221764839" }] }, projects).candidates[0]).toMatchObject({ slug: "bazile", level: "nom" });
    const close = suggestFor({ name: "Cours Legendre — Cours Legendre 2023", accounts: [] }, projects);
    expect(close.candidates[0]).toMatchObject({ slug: "cours-legendre", level: "partiel" });
    expect(suggestFor({ name: "Leroy Merlin", accounts: [] }, projects).candidates[0]).toMatchObject({ slug: "leroy-merlin", level: "nom" });
    expect(suggestFor({ name: "Leroy Merlin SA", accounts: [] }, projects).candidates[0]).toMatchObject({ slug: "leroy-merlin", level: "partiel" });
  });
  it("uses the dashboards' names too and the project name of a board project", () => {
    expect(suggestFor({ name: "Compte 1543285195886235", accounts: [], dashboards: [{ name: "Gaia US" }] }, projects).candidates[0]).toMatchObject({ slug: "gaia", level: "nom" });
    expect(suggestFor({ name: "Beaba", accounts: [] }, projects).candidates[0]).toMatchObject({ slug: "avv-beaba-03af7f543a35", level: "partiel" });
  });
  it("says nothing on a short or unrelated name", () => {
    expect(suggestFor({ name: "ADT", accounts: [] }, projects).candidates).toEqual([]);
    expect(suggestFor({ name: "Au Village", accounts: [] }, projects).candidates).toEqual([]);
  });
  it("flags two candidates at the same level as ambiguous", () => {
    const twins: HqProjectInfo[] = [...projects, { slug: "bazile-2", name: "Bazile", registryName: null, accounts: [], hasClientYaml: false }];
    const r = suggestFor({ name: "Bazile", accounts: [] }, twins);
    expect(r.ambiguous).toBe(true);
    expect(r.candidates.map((c) => c.slug).sort()).toEqual(["bazile", "bazile-2"]);
  });
});
