import { describe, it, expect } from "vitest";
import { purchasesFor, conversionActionTypes, computeCpa } from "@/lib/meta-api";

const acts = (pairs: Array<[string, string]>) => pairs.map(([action_type, value]) => ({ action_type, value }));

describe("conversionActionTypes", () => {
  it("maps events to ordered action_type candidates", () => {
    expect(conversionActionTypes("purchase")).toEqual(["omni_purchase", "purchase"]);
    expect(conversionActionTypes(undefined)).toEqual(["omni_purchase", "purchase"]);
    expect(conversionActionTypes("lead")).toEqual(["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"]);
    expect(conversionActionTypes("complete_registration")).toEqual(["complete_registration", "offsite_conversion.fb_pixel_complete_registration"]);
    expect(conversionActionTypes("custom:offsite_conversion.custom.123")).toEqual(["offsite_conversion.custom.123"]);
    expect(conversionActionTypes("custom:")).toEqual(["omni_purchase", "purchase"]);
  });
});

describe("purchasesFor", () => {
  const insight = {
    actions: acts([
      ["omni_purchase", "12"],
      ["purchase", "10"],
      ["lead", "0"],
      ["onsite_conversion.lead_grouped", "7"],
      ["offsite_conversion.custom.123", "3"],
    ]),
  };
  it("defaults to purchase (omni_purchase first)", () => {
    expect(purchasesFor(insight)).toBe(12);
    expect(purchasesFor({ actions: acts([["purchase", "10"]]) })).toBe(10);
  });
  it("skips zero-valued candidates and takes the first positive", () => {
    expect(purchasesFor(insight, "lead")).toBe(7);
  });
  it("supports complete_registration and custom:<type>", () => {
    expect(purchasesFor({ actions: acts([["offsite_conversion.fb_pixel_complete_registration", "4"]]) }, "complete_registration")).toBe(4);
    expect(purchasesFor(insight, "custom:offsite_conversion.custom.123")).toBe(3);
  });
  it("returns 0 when nothing matches or actions are missing", () => {
    expect(purchasesFor({}, "lead")).toBe(0);
    expect(purchasesFor({ actions: [] })).toBe(0);
  });
});

describe("computeCpa", () => {
  it("uses cost_per_action_type for the event when present", () => {
    const i = { spend: "100", actions: acts([["purchase", "4"]]), cost_per_action_type: acts([["purchase", "23.456"]]) };
    expect(computeCpa(i)).toBe(23.46);
  });
  it("falls back to spend / conversions", () => {
    const i = { spend: "100", actions: acts([["lead", "8"]]) };
    expect(computeCpa(i, "lead")).toBe(12.5);
    expect(computeCpa({ spend: "100", actions: [] }, "lead")).toBe(0);
    expect(computeCpa({ spend: "0", actions: acts([["lead", "8"]]) }, "lead")).toBe(0);
  });
});
