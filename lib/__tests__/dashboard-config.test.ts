import { describe, it, expect } from "vitest";
import { validateWidgetConfig, validateWidgetWidth } from "@/lib/dashboard-types";

describe("validateWidgetConfig", () => {
  it("normalizes a kpi config with defaults", () => {
    expect(validateWidgetConfig("kpi", {})).toEqual({ metric: "spend", source: "meta" });
  });

  it("rejects unknown widget types", () => {
    expect(() => validateWidgetConfig("iframe", {})).toThrow(/Type de widget inconnu/);
  });

  it("rejects invalid metrics and sources", () => {
    expect(() => validateWidgetConfig("kpi", { metric: "likes" })).toThrow(/Métrique KPI invalide/);
    expect(() => validateWidgetConfig("kpi", { source: "tiktok" })).toThrow(/Source invalide/);
    expect(() => validateWidgetConfig("timeseries", { metric: "impressions" })).toThrow(/courbe invalide/);
    expect(() => validateWidgetConfig("table", { kind: "ads" })).toThrow(/Table invalide/);
  });

  it("clamps limits into their documented bounds", () => {
    expect(validateWidgetConfig("table", { kind: "keywords", limit: 999 })).toEqual({ kind: "keywords", limit: 30 });
    // falsy limit (0) is treated as unset and falls back to the default
    expect(validateWidgetConfig("top_creatives", { limit: 0 })).toEqual({ limit: 6 });
  });

  it("rejects oversized text widgets, strips unknown keys", () => {
    expect(() => validateWidgetConfig("text", { markdown: "x".repeat(5001) })).toThrow(/trop long/);
    expect(validateWidgetConfig("text", { markdown: "ok", evil: true })).toEqual({ markdown: "ok" });
  });
});

describe("validateWidgetWidth", () => {
  it("passes valid widths and defaults the rest to half", () => {
    expect(validateWidgetWidth("full")).toBe("full");
    expect(validateWidgetWidth("huge")).toBe("half");
    expect(validateWidgetWidth(undefined)).toBe("half");
  });
});
