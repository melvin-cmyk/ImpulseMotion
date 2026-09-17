import { describe, it, expect } from "vitest";
import {
  conversionEventLabel, dedupeActionTypes, metaActionLabel, parseConversionEvent, summarizeMetaActions,
} from "@/lib/meta-actions";
import { validateWidgetConfig } from "@/lib/dashboard-types";

const a = (pairs: Record<string, number>) =>
  Object.entries(pairs).map(([action_type, v]) => ({ action_type, value: String(v) }));

describe("metaActionLabel()", () => {
  it("labels standard, pixel and custom conversion types", () => {
    expect(metaActionLabel("omni_purchase")).toBe("Achats");
    expect(metaActionLabel("offsite_conversion.fb_pixel_add_to_cart")).toBe("Ajouts au panier (pixel)");
    expect(metaActionLabel("offsite_conversion.fb_pixel_custom.DevisEnvoye")).toBe("DevisEnvoye (événement pixel)");
    expect(metaActionLabel("offsite_conversion.custom.42", { "42": "Demande de devis" })).toBe("Demande de devis (conv. perso)");
    expect(metaActionLabel("offsite_conversion.custom.42")).toBe("Conversion perso 42");
  });

  it("labels conversion events", () => {
    expect(conversionEventLabel("lead")).toBe("Leads");
    expect(conversionEventLabel("custom:landing_page_view")).toBe("Vues de page de destination");
  });
});

describe("dedupeActionTypes()", () => {
  it("hides aliases carrying the canonical count, keeps real differences", () => {
    const counts = new Map(Object.entries({
      omni_purchase: 10, purchase: 10, "offsite_conversion.fb_pixel_purchase": 10, onsite_web_purchase: 10,
      lead: 7, "offsite_conversion.fb_pixel_lead": 3, "onsite_conversion.lead_grouped": 4,
      link_click: 500,
    }));
    const hidden = dedupeActionTypes(counts);
    expect([...hidden].sort()).toEqual(["offsite_conversion.fb_pixel_purchase", "onsite_web_purchase", "purchase"]);
  });
});

describe("summarizeMetaActions()", () => {
  const insight = {
    spend: "100",
    actions: a({ omni_purchase: 4, purchase: 4, link_click: 200, add_to_cart: 0 }),
    action_values: a({ omni_purchase: 320 }),
    cost_per_action_type: a({ link_click: 0.5 }),
  };

  it("lists deduped non-zero actions by count, with cost and value", () => {
    expect(summarizeMetaActions(insight)).toEqual([
      { actionType: "link_click", count: 200, value: null, costPer: 0.5 },
      { actionType: "omni_purchase", count: 4, value: 320, costPer: 25 },
    ]);
  });

  it("follows an explicit selection, zero-filling absent types", () => {
    expect(summarizeMetaActions(insight, ["omni_purchase", "lead"]).map((r) => [r.actionType, r.count, r.costPer]))
      .toEqual([["omni_purchase", 4, 25], ["lead", 0, null]]);
  });
});

describe("conversion override on widget configs", () => {
  it("keeps a valid override and drops an empty one", () => {
    expect(validateWidgetConfig("kpi", { metric: "cpa", conversionEvent: "custom:offsite_conversion.custom.123" }))
      .toEqual({ metric: "cpa", source: "meta", conversionEvent: "custom:offsite_conversion.custom.123" });
    expect(validateWidgetConfig("funnel", { conversionEvent: "" })).toEqual({ source: "combined" });
    expect(parseConversionEvent(undefined)).toBeNull();
  });

  it("rejects garbage and ignores the field on unrelated widgets", () => {
    expect(() => validateWidgetConfig("kpi", { conversionEvent: "achat; drop" })).toThrow(/Action de conversion invalide/);
    expect(validateWidgetConfig("alerts", { conversionEvent: "lead" })).toEqual({ limit: 5 });
  });

  it("validates meta_actions", () => {
    expect(validateWidgetConfig("meta_actions", {})).toEqual({ actions: [], limit: 15 });
    expect(validateWidgetConfig("meta_actions", { actions: ["link_click", "link_click", " omni_purchase "], limit: 99 }))
      .toEqual({ actions: ["link_click", "omni_purchase"], limit: 50 });
    expect(() => validateWidgetConfig("meta_actions", { actions: ["a b"] })).toThrow(/invalide/);
    expect(() => validateWidgetConfig("meta_actions", { actions: Array.from({ length: 31 }, (_, i) => `t${i}`) })).toThrow(/30 actions/);
  });
});
