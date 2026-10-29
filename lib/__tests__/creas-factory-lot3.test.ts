import { describe, expect, it } from "vitest";
import { buildCopyProposalPrompt, buildFactoryImagePrompt, feedbackLines, variationReference } from "@/lib/creas/copy";
import { parseSettings, shouldSuggestRetire } from "@/lib/creas/model";
import { parseFactoryIntent } from "@/lib/mo/intents";

const tpl = { id: "t1aaaaaaaaaa", name: "Avant après", brand: "X", source: "competitor", analysis: { hook: "avant / après", structure: "split", textZones: [], style: "", palette: [], cta: "", whyItWorks: "", brief: "" } };

describe("feedback re-injected", () => {
  it("copy prompt carries the batch feedback and the kept visuals of a variation", () => {
    const { user } = buildCopyProposalPrompt({ clientName: "N", kind: "variation", contextMd: "ctx", templates: [tpl], perTemplate: 2, season: "Noël", feedback: ["pas de -50 %"], kept: [{ template: 1, headline: "Enfin du bio", subline: "pas cher", cta: "J'y vais" }] });
    expect(user).toContain("RETOURS DU CONSULTANT");
    expect(user).toContain("pas de -50 %");
    expect(user).toContain("T1 : « Enfin du bio » / « pas cher » [J'y vais]");
    expect(user).toContain("Saison / moment : Noël");
  });
  it("image prompt says what to avoid and keeps the kept visual first", () => {
    const p = buildFactoryImagePrompt("BASE", { headline: "H", subline: "", cta: "" }, false, ["packaging déformé"], true);
    expect(p).toContain("À ÉVITER");
    expect(p).toContain("packaging déformé");
    expect(p).toContain("PREMIÈRE image de référence");
    expect(buildFactoryImagePrompt("BASE", { headline: "H", subline: "", cta: "" }, false)).not.toContain("ÉVITER");
  });
  it("feedback lines: newest first, deduplicated, capped", () => {
    expect(feedbackLines([{ text: "Pas de -50 %" }, { text: "pas de -50 %" }, { text: "ok" }, { text: "Ton rassurant" }], 5)).toEqual(["Pas de -50 %", "Ton rassurant"]);
  });
});

describe("variations and retire", () => {
  it("variation reference turns over the kept visuals of the template", () => {
    const parent = { t1: ["a1", "a2"] };
    expect([0, 1, 2].map((i) => variationReference(parent, "t1", i))).toEqual(["a1", "a2", "a1"]);
    expect(variationReference(parent, "t2", 0)).toBeNull();
  });
  it("suggests setting a template aside only after enough cuts", () => {
    expect(shouldSuggestRetire({ kept: 1, cut: 9 })).toBe(true);
    expect(shouldSuggestRetire({ kept: 0, cut: 5 })).toBe(false);
    expect(shouldSuggestRetire({ kept: 4, cut: 6 })).toBe(false);
    expect(shouldSuggestRetire({ kept: 0, cut: 10, retiredAt: "2026-10-29" })).toBe(false);
  });
  it("settings keep the parent visuals, the background flag and the publications", () => {
    const s = parseSettings(JSON.stringify({ n: 30, parentAssets: { cmabcdefghij: ["cmasset000001", "bad id!"] }, background: true, boardId: "cmboard00001", published: [{ actionId: "x", assetIds: ["a"], at: "t" }, { nope: 1 }] }));
    expect(s.parentAssets).toEqual({ cmabcdefghij: ["cmasset000001"] });
    expect(s.background).toBe(true);
    expect(s.boardId).toBe("cmboard00001");
    expect(s.published).toHaveLength(1);
    expect(parseSettings("{}").parentAssets).toBeUndefined();
  });
  it("Mo understands a long generation", () => {
    expect(parseFactoryIntent("génère 30 visuels")).toMatchObject({ kind: "factory_generate", n: 30 });
  });
});
