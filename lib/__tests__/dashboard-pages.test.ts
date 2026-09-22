import { describe, expect, it } from "vitest";
import { buildPageCreatorSystemPrompt, cleanPageName, parsePageSpec, validatePageWidgets } from "@/lib/dashboard-pages";

describe("dashboard pages — validation", () => {
  it("normalises page names", () => {
    expect(cleanPageName("  Google   Ads ")).toBe("Google Ads");
    expect(cleanPageName("", "Nouvelle page")).toBe("Nouvelle page");
    expect(cleanPageName("x".repeat(80)).length).toBe(40);
  });

  it("accepts a valid widget list and applies the form rules", () => {
    const out = validatePageWidgets([
      { type: "kpi", title: "Dépenses", width: "third", config: { metric: "spend", source: "meta" } },
      { type: "text", title: null, width: "full", config: { markdown: "Bonjour" } },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "kpi", width: "third", title: "Dépenses" });
    expect(out[0].config).toMatchObject({ metric: "spend", source: "meta" });
  });

  it("rejects unknown types, bad configs and oversized lists", () => {
    expect(() => validatePageWidgets([{ type: "pie", config: {} }])).toThrow(/type inconnu/);
    expect(() => validatePageWidgets([{ type: "kpi", config: { metric: "nope", source: "meta" } }])).toThrow();
    expect(() => validatePageWidgets(Array.from({ length: 25 }, () => ({ type: "text", config: { markdown: "x" } })))).toThrow(/24 widgets/);
    expect(() => validatePageWidgets("nope")).toThrow(/liste/);
  });

  it("parses the AI answer with a fence and prose around it", () => {
    const raw = 'Voici la page.\n```json\n{"name":"Google Ads","note":"Pas de Meta lié.","widgets":[{"type":"kpi","title":"Coût","width":"third","config":{"metric":"spend","source":"google"}}]}\n```';
    const { spec, note } = parsePageSpec(raw);
    expect(spec.name).toBe("Google Ads");
    expect(spec.widgets).toHaveLength(1);
    expect(note).toBe("Pas de Meta lié.");
    expect(() => parsePageSpec('{"name":"x","widgets":[]}')).toThrow(/aucun widget/);
    expect(() => parsePageSpec("désolé")).toThrow(/illisible/);
  });

  it("tells the AI which sources exist and lists the catalogue", () => {
    const p = buildPageCreatorSystemPrompt({ name: "LPEV", metaAccountId: null, googleCustomerId: "123" });
    expect(p).toContain("Google Ads (source \"google\")");
    expect(p).not.toContain("Meta Ads (source");
    expect(p).toContain("- kpi (");
    expect(p).toContain("```json");
  });
});
