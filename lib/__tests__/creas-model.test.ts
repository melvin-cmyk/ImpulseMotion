import { describe, expect, it } from "vitest";
import { analysisIsEmpty, parseAnalysis, parseTags, ratioFor } from "@/lib/creas/model";
import { buildCopyPrompt, buildEditorAsk } from "@/lib/creas/templates";

describe("Créas — template analysis", () => {
  it("reads the AI's JSON with caps and drops the junk", () => {
    const a = parseAnalysis(JSON.stringify({ hook: " avant / après ", structure: "titre en haut", textZones: [{ role: "titre", text: "-30 %" }, { nope: 1 }, "x"], style: "UGC", palette: ["#fff", 3, "rouge"], cta: "Acheter", whyItWorks: "preuve", brief: "garder la compo" }));
    expect(a.hook).toBe("avant / après");
    expect(a.textZones).toEqual([{ role: "titre", text: "-30 %" }]);
    expect(a.palette).toEqual(["#fff", "rouge"]);
    expect(analysisIsEmpty(a)).toBe(false);
  });
  it("is empty on garbage", () => {
    expect(analysisIsEmpty(parseAnalysis("nope"))).toBe(true);
    expect(analysisIsEmpty(parseAnalysis(null))).toBe(true);
    expect(parseAnalysis("[]").textZones).toEqual([]);
  });
  it("tags and ratios", () => {
    expect(parseTags(" ugc, promo ,, ")).toEqual(["ugc", "promo"]);
    expect(ratioFor(1080, 1350)).toBe("4:5");
    expect(ratioFor(1080, 1920)).toBe("9:16");
    expect(ratioFor(null, 10)).toBe("1:1");
  });
});

describe("Créas — prompts", () => {
  const analysis = parseAnalysis(JSON.stringify({ hook: "produit géant", structure: "produit centré, prix en bas", textZones: [{ role: "prix", text: "19 €" }], style: "3D", palette: ["#000"] }));
  it("copy brief keeps the template, swaps the brand, respects textless", () => {
    const p = buildCopyPrompt({ template: { name: "Pub X", brand: "Emma", title: null, body: null }, analysis, clientName: "Naturalia", instructions: "ambiance hiver", assets: 2, textless: true });
    expect(p).toContain("marque d'origine : Emma");
    expect(p).toContain("« Naturalia »");
    expect(p).toContain("Images 2 à 3");
    expect(p).toContain("AUCUN texte");
    expect(p).toContain("ambiance hiver");
    const withText = buildCopyPrompt({ template: { name: "Pub X", brand: "", title: null, body: null }, analysis, clientName: "Naturalia", instructions: "", assets: 0, textless: false });
    expect(withText).toContain("prix (« 19 € »");
    expect(withText).toContain("Aucun visuel de marque");
  });
  it("editor asks name the uploaded file and the client", () => {
    expect(buildEditorAsk({ editor: "figcraft", file: "template-1.jpg", template: { name: "Pub X", brand: "Emma" }, analysis, clientName: "LPEV" })).toMatch(/uploads\/template-1\.jpg.*« LPEV ».*calques/s);
    expect(buildEditorAsk({ editor: "photocraft", file: "t.png", template: { name: "Pub X", brand: "" }, analysis, clientName: null })).toMatch(/pour l'agence.*out\/template\.psd/s);
  });
});
