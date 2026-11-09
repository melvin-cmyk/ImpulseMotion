import { describe, it, expect } from "vitest";
import { looksLikeCreatives, parseCreativeBlock } from "@/components/bot/bot-creative-cards";

describe("parseCreativeBlock — bloc ```creas → cartes", () => {
  it("visuel, légende, chiffres en libellé / valeur", () => {
    const c = parseCreativeBlock("![Laponie](/api/bot/b1/video?ad=meta%3A1) | Vidéo · lancée le 09/07 | dépense 1 136 € · CTR 2 % · conversions 2 · ROAS 4,95 · hook 27,5 %\n");
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ name: "Laponie", src: "/api/bot/b1/video?ad=meta%3A1", caption: "Vidéo · lancée le 09/07" });
    expect(c[0].kpis).toEqual([
      { label: "dépense", value: "1 136 €" }, { label: "CTR", value: "2 %" }, { label: "conversions", value: "2" },
      { label: "ROAS", value: "4,95" }, { label: "hook", value: "27,5 %" },
    ]);
  });
  it("lignes de liste, chiffres seuls, lignes parasites ignorées", () => {
    const c = parseCreativeBlock("Voici :\n- ![A](/api/bot/b1/image?name=A) | dépense 10 €\n* ![B](/api/bot/b1/image?ad=meta%3A2)\n");
    expect(c.map((x) => x.name)).toEqual(["A", "B"]);
    expect(c[0]).toMatchObject({ caption: "", kpis: [{ label: "dépense", value: "10 €" }] });
    expect(c[1].kpis).toEqual([]);
  });

  it("ligne sans visuel : la créa est retrouvée par son nom", () => {
    const c = parseCreativeBlock("1. « DPA - CAR - IMG » — dépense 1 498 € · ROAS 4,95\n**YOGA - SGL** | Vidéo | dépense 519 €", "b1");
    expect(c.map((x) => x.name)).toEqual(["DPA - CAR - IMG", "YOGA - SGL"]);
    expect(c[0].src).toBe("/api/bot/b1/image?name=DPA%20-%20CAR%20-%20IMG");
    expect(c[0].kpis).toEqual([{ label: "dépense", value: "1 498 €" }, { label: "ROAS", value: "4,95" }]);
    expect(c[1].caption).toBe("Vidéo");
  });
  it("reconnaît un bloc de créas quel que soit son libellé", () => {
    expect(looksLikeCreatives("x", "creas")).toBe(true);
    expect(looksLikeCreatives("![A](/api/bot/b1/image?ad=meta%3A1) | dépense 1 €", "")).toBe(true);
    expect(looksLikeCreatives("const a = 1;", "ts")).toBe(false);
  });
});

describe("bloc creas recopié avec les lignes du prompt", () => {
  it("garde les cartes, ignore « carte : », le titre numéroté et le texte", async () => {
    const { parseCreativeBlock } = await import("@/components/bot/bot-creative-cards");
    const block = [
      "1. « W42Y26_SGL_IMG_laponie » — Image dynamique, lancée le 18/10, dépense stable",
      "   texte : Réservez vos prochaines vacances sportives ! Plus de 200 séjours",
      "   carte : ![W42Y26_SGL_IMG_laponie](/api/bot/b1/image?ad=meta%3A1) | Image dynamique · lancée le 18/10 | dépense 540 € · ROAS 9,47",
      "![Yoga](/api/bot/b1/video?ad=meta%3A2) | Vidéo | dépense 300 € · ROAS 4,2",
    ].join("\n");
    const cards = parseCreativeBlock(block, "b1");
    expect(cards.map((c) => c.name)).toEqual(["W42Y26_SGL_IMG_laponie", "Yoga"]);
    expect(cards[0].src).toBe("/api/bot/b1/image?ad=meta%3A1");
  });
});
