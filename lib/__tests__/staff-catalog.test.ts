/**
 * Catalogue « Métriques & dimensions » des dashboards du staff : l'évaluateur
 * partagé (public/dash-catalog.js, le même dans l'app et dans le cadre), la
 * validation des définitions, le texte pour le copilote, le cadre.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import DashCatalog from "@/public/dash-catalog.js";
import { catalogPromptText, validateDimensionInput, validateMetricInput } from "@/lib/staff-dashboards/catalog";
import { buildFrameDocument } from "@/lib/staff-dashboards/frame";

describe("évaluateur de formules (dash-catalog.js)", () => {
  it("lit les champs tels quels, en camelCase, sous metrics, et les listes d'actions Meta", () => {
    expect(DashCatalog.evaluate("cost_micros / 1000000 / conversions", { metrics: { costMicros: "2000000", conversions: 4 } })).toBe(0.5);
    expect(DashCatalog.evaluate("metrics.clicks * 2", { metrics: { clicks: "3" } })).toBe(6);
    expect(DashCatalog.evaluate("actions.purchase / clicks * 100", { clicks: "200", actions: [{ action_type: "purchase", value: "10" }] })).toBe(5);
    expect(DashCatalog.evaluate("actions.offsite_conversion.fb_pixel_purchase", { actions: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "7" }] })).toBe(7);
    expect(DashCatalog.evaluate("campaign.name", { campaign: { name: "x" } })).toBe(0); // texte → 0
  });

  it("gère les fonctions, la priorité des opérateurs et la division par zéro", () => {
    expect(DashCatalog.evaluate("1 + 2 * 3", {})).toBe(7);
    expect(DashCatalog.evaluate("(1 + 2) * 3", {})).toBe(9);
    expect(DashCatalog.evaluate("-a + max(b, 9)", { a: 1, b: 3 })).toBe(8);
    expect(DashCatalog.evaluate("round(10 / 3, 2)", {})).toBe(3.33);
    expect(DashCatalog.evaluate("pct(a, b)", { a: 5, b: 0 })).toBe(0);
    expect(DashCatalog.evaluate("a / b", { a: 5, b: 0 })).toBe(0);
    expect(DashCatalog.evaluate("coalesce(x, y, 4)", { y: "2" })).toBe(2);
    expect(DashCatalog.evaluate("spend", { spend: "1 234,5" })).toBe(1234.5);
  });

  it("refuse les formules illisibles avec un message en français", () => {
    expect(DashCatalog.validateFormula("spend / (clicks")).toMatchObject({ ok: false });
    expect(DashCatalog.validateFormula("foo(1)")).toMatchObject({ ok: false, error: expect.stringContaining("fonction inconnue") });
    expect(DashCatalog.validateFormula("a $ b")).toMatchObject({ ok: false, error: expect.stringContaining("caractère inattendu") });
    expect(DashCatalog.validateFormula("a b")).toMatchObject({ ok: false, error: expect.stringContaining("texte en trop") });
    expect(DashCatalog.validateFormula("spend / clicks")).toEqual({ ok: true, fields: ["spend", "clicks"] });
  });

  it("dérive une dimension : champ, extrait regex, classement par motifs, repli", () => {
    const row = { campaign: { name: "FR - [PUR] Search" }, campaign_name: "Perf - Google" };
    expect(DashCatalog.derive({ field: "campaign.name", kind: "field" }, row)).toBe("FR - [PUR] Search");
    expect(DashCatalog.derive({ field: "campaign.name", kind: "regex", rule: { pattern: "\\[([A-Z]+)\\]", group: 1, fallback: "Sans" } }, row)).toBe("PUR");
    expect(DashCatalog.derive({ field: "campaign.name", kind: "regex", rule: { pattern: "\\[(brand)\\]", fallback: "Sans" } }, row)).toBe("Sans");
    expect(DashCatalog.derive({ field: "campaign_name", kind: "mapping", rule: { values: [{ match: "brand", value: "Marque" }, { match: "^perf", value: "Perf", regex: true }], fallback: "Autre" } }, row)).toBe("Perf");
    expect(DashCatalog.derive({ field: "missing", kind: "field", rule: { fallback: "?" } }, row)).toBe("?");
  });

  it("formate selon le format de la métrique et agrège par dimension", () => {
    expect(DashCatalog.format({ format: "currency" }, 1234.5)).toMatch(/1\s?235\s?€/);
    expect(DashCatalog.format({ format: "percent" }, 12.345)).toBe("12,35 %");
    expect(DashCatalog.format({ format: "integer" }, 12345.6)).toMatch(/12\s?346/);
    expect(DashCatalog.format({ format: "ratio" }, 3.456)).toBe("3,46x");
    const groups = DashCatalog.rollup(
      [{ campaign_name: "A brand", spend: "10", clicks: 100 }, { campaign_name: "B brand", spend: 20, clicks: 100 }, { campaign_name: "perf", spend: 5, clicks: 50 }],
      { field: "campaign_name", kind: "mapping", rule: { values: [{ match: "brand", value: "Marque" }], fallback: "Autre" } },
      [{ key: "cpc", formula: "spend / clicks" }],
    );
    expect(groups).toEqual([
      { key: "Marque", count: 2, fields: { spend: 30, clicks: 200 }, metrics: { cpc: 0.15 } },
      { key: "Autre", count: 1, fields: { spend: 5, clicks: 50 }, metrics: { cpc: 0.1 } },
    ]);
    expect(DashCatalog.rollup([{ spend: 1 }, { spend: 2 }], null, [{ key: "s", formula: "spend" }])).toEqual([{ key: "Total", count: 2, fields: { spend: 3 }, metrics: { s: 3 } }]);
  });
});

describe("validation des définitions", () => {
  it("accepte une métrique complète et normalise clé, format, devise", () => {
    const v = validateMetricInput({ key: " CPA ", label: "Coût par achat", platform: "meta", formula: "spend / actions.purchase", format: "currency", unit: "eur", description: "x" });
    expect(v).toMatchObject({ ok: true, value: { key: "cpa", format: "currency", unit: "EUR", platform: "meta" }, fields: ["spend", "actions.purchase"] });
  });
  it("refuse clé, formule, format ou devise invalides", () => {
    expect(validateMetricInput({ key: "1abc", label: "x", platform: "any", formula: "a" })).toMatchObject({ ok: false, error: expect.stringContaining("clé") });
    expect(validateMetricInput({ key: "cpa", label: "x", platform: "any", formula: "1 + 1" })).toMatchObject({ ok: false, error: expect.stringContaining("aucun champ") });
    expect(validateMetricInput({ key: "cpa", label: "x", platform: "any", formula: "a / (" })).toMatchObject({ ok: false, error: expect.stringContaining("formule") });
    expect(validateMetricInput({ key: "cpa", label: "x", platform: "mars", formula: "a" })).toMatchObject({ ok: false, error: "plateforme invalide" });
    expect(validateMetricInput({ key: "cpa", label: "x", platform: "any", formula: "a", format: "currency", unit: "euros" })).toMatchObject({ ok: false, error: expect.stringContaining("unité") });
  });
  it("accepte les trois types de dimension et refuse une règle incomplète", () => {
    expect(validateDimensionInput({ key: "camp", label: "Campagne", platform: "google", field: "campaign.name" })).toMatchObject({ ok: true, value: { kind: "field", rule: {} } });
    const rx = validateDimensionInput({ key: "verticale", label: "Verticale", platform: "any", field: "campaign_name", kind: "regex", rule: { pattern: "\\[([A-Z]+)\\]", group: 1, fallback: "Sans", flags: "i" } });
    expect(rx).toMatchObject({ ok: true, value: { kind: "regex", rule: { pattern: "\\[([A-Z]+)\\]", group: 1, fallback: "Sans", flags: "i" } } });
    expect(validateDimensionInput({ key: "v", label: "V", platform: "any", field: "x", kind: "regex", rule: { pattern: "([" } })).toMatchObject({ ok: false, error: expect.stringContaining("invalide") });
    const map = validateDimensionInput({ key: "type", label: "Type", platform: "any", field: "campaign_name", kind: "mapping", rule: { values: [{ match: "brand", value: "Marque" }, { match: "", value: "" }], fallback: "Autre" } });
    expect(map).toMatchObject({ ok: true, value: { rule: { values: [{ match: "brand", value: "Marque" }], fallback: "Autre" } } });
    expect(validateDimensionInput({ key: "type", label: "Type", platform: "any", field: "campaign_name", kind: "mapping", rule: { values: [] } })).toMatchObject({ ok: false });
  });
});

describe("copilote et cadre", () => {
  const catalog = {
    metrics: [{ id: "1", key: "cpa", label: "Coût par achat", description: "", platform: "meta" as const, formula: "spend / actions.purchase", format: "currency" as const, unit: "EUR", fields: ["spend", "actions.purchase"], ownerId: "u", createdAt: "", updatedAt: "" }],
    dimensions: [{ id: "2", key: "verticale", label: "Verticale", description: "entre crochets", platform: "any" as const, field: "campaign_name", kind: "regex" as const, rule: { pattern: "\\[([A-Z]+)\\]", group: 1, fallback: "Sans" }, ownerId: "u", createdAt: "", updatedAt: "" }],
  };
  it("décrit le catalogue au copilote, avec la façon de l'utiliser", () => {
    const text = catalogPromptText(catalog);
    expect(text).toContain("dash.metric(key");
    expect(text).toContain("cpa « Coût par achat » [Meta Ads, currency EUR] = spend / actions.purchase");
    expect(text).toContain("verticale « Verticale » [Toutes] : groupe 1 de /\\[([A-Z]+)\\]/i sur campaign_name, sinon « Sans » — entre crochets");
    expect(catalogPromptText({ metrics: [], dimensions: [] })).toContain("Catalogue vide");
  });
  it("charge l'évaluateur avant le runtime et donne le catalogue au démarrage du cadre", () => {
    const doc = buildFrameDocument("<p>x</p>", ["a"], {}, "https://app", { metrics: [{ key: "cpa", label: "CPA", description: "", platform: "meta", formula: "spend / actions.purchase", format: "currency", unit: null }], dimensions: [] });
    expect(doc.indexOf("/dash-catalog.js")).toBeLessThan(doc.indexOf("/dash-runtime.js"));
    expect(doc).toContain('dash.__catalog({"metrics":[{"key":"cpa"');
    // Before the page: a script of the page may call dash.metric as it loads.
    expect(doc.indexOf("dash.__catalog(")).toBeLessThan(doc.indexOf('<div id="dash-root">'));
    expect(doc).toContain('dash.__boot(["a"], {});');
    expect(buildFrameDocument("<p>x</p>", [], {}, "")).toContain('dash.__catalog({"metrics":[],"dimensions":[]})');
  });
});
