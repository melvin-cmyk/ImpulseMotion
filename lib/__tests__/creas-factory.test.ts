import { describe, expect, it } from "vitest";
import { parseAnalysis, parseSettings, parseSources, type RunStatus } from "@/lib/creas/model";
import {
  assembleContext, buildCopyProposalPrompt, buildFactoryImagePrompt, canTransition, estimateUsd, factoryFileName, factoryFolderName,
  parseCopyProposals, passPlan, planSlots, remainingOf, splitBatches, statusAfterPass, statusAfterVerdicts, zoneLengthHint,
} from "@/lib/creas/copy";

const analysis = parseAnalysis(JSON.stringify({ hook: "produit géant", structure: "titre en haut, produit centré, bouton en bas", textZones: [{ role: "titre", text: "Le soutien qui change tout" }, { role: "sous-titre", text: "Des profs sélectionnés, un suivi chaque semaine" }, { role: "bouton", text: "Réserver" }], brief: "garder la compo", whyItWorks: "preuve + promesse" }));
const templates = [
  { id: "cmtplaaaaaaaa1", name: "Pub A", brand: "Acadomia", source: "competitor", analysis },
  { id: "cmtplbbbbbbbb2", name: "Pub B", brand: "", source: "own", analysis: parseAnalysis(null) },
];

describe("Fabrique — contexte", () => {
  it("assembles the sources in order, capped and traced", () => {
    const ctx = assembleContext({ clientName: "Cours Legendre", brief: "Marque : soutien scolaire\nRègles de la marque : pas de promo chiffrée", templates, reviews: "x".repeat(10_000), feedback: [{ level: "run", text: "jamais de -50 %" }], instructions: "rentrée" });
    expect(ctx.md.startsWith("# Contexte statics — Cours Legendre")).toBe(true);
    expect(ctx.md).toContain("## Brief de marque");
    expect(ctx.md).toContain("T1 « Pub A » (marque d'origine Acadomia)");
    expect(ctx.md).toContain("T2 « Pub B »");
    expect(ctx.md).toContain("jamais de -50 %");
    expect(ctx.sources.map((s) => s.kind)).toEqual(["hq_brief", "templates", "reviews", "feedback", "instructions"]);
    expect(ctx.sources.find((s) => s.kind === "reviews")?.chars).toBe(6000);
    expect(ctx.sources.find((s) => s.kind === "templates")?.ref).toBe("cmtplaaaaaaaa1,cmtplbbbbbbbb2");
  });
  it("says when there is no brief and skips empty sources", () => {
    const ctx = assembleContext({ clientName: "X", brief: "", templates: [], reviews: "  ", feedback: [] });
    expect(ctx.md).toContain("aucun brief HQ en cache");
    expect(ctx.sources).toEqual([]);
  });
});

describe("Fabrique — prompt de copy", () => {
  it("asks French copies, the customers' words with a source, no number without the brand's rules, lengths per zone", () => {
    const { system, user } = buildCopyProposalPrompt({ clientName: "Cours Legendre", kind: "offer", contextMd: "CTX", templates, perTemplate: 4, persona: "parents de collégiens" });
    expect(system).toContain("français");
    expect(system).toContain("MOTS DES CLIENTS");
    expect(system).toContain("voiceSource");
    expect(system).toMatch(/Jamais d'offre chiffrée/);
    expect(system).toContain("« Cours Legendre »");
    expect(user).toContain("OFFRE");
    expect(user).toContain("parents de collégiens");
    expect(user).toContain("T1 « Pub A »");
    expect(user).toContain("longueurs : titre ≤");
    expect(user).toContain("CTX");
    expect(user).toContain("8 en tout");
  });
  it("derives zone lengths from the template's own texts, with floors", () => {
    expect(zoneLengthHint(analysis.textZones)).toBe("titre ≤ 34 caractères, sous-titre ≤ 61, bouton ≤ 16");
    expect(zoneLengthHint([])).toContain("titre ≤ 45");
  });
});

describe("Fabrique — parse des propositions", () => {
  it("keeps per-template caps, numbering, dedupe and tolerates loose shapes", () => {
    const raw = { copies: [
      { template: 1, headline: " Des profs qui écoutent ", subline: "Un suivi chaque semaine", cta: "Réserver", angle: "preuve", persona: "parents", voiceSource: "avis collé : “ma fille a repris confiance”" },
      { template: "T1", headline: "Des profs qui écoutent", subline: "doublon" },
      { template: 1, headline: "Reprendre confiance", voiceSource: "" },
      { template: 1, headline: "Trois", }, { template: 1, headline: "Quatre" }, { template: 1, headline: "Cinq (au-delà du cap)" },
      { template: 2, headline: "Pour T2" }, { template: 9, headline: "template inconnu" }, { headline: "sans template" }, "n'importe quoi", { template: 2 },
      { templateId: "cmtplbbbbbbbb2", headline: "Par id" },
    ] };
    const out = parseCopyProposals(raw, templates, 4);
    expect(out.map((c) => c.headline)).toEqual(["Des profs qui écoutent", "Reprendre confiance", "Trois", "Quatre", "Pour T2", "Par id"]);
    expect(out[0]).toMatchObject({ templateId: "cmtplaaaaaaaa1", order: 0, cta: "Réserver", voiceSource: "avis collé : “ma fille a repris confiance”" });
    expect(out[1].voiceSource).toBe("proposition");
    expect(out[4].templateId).toBe("cmtplbbbbbbbb2");
    expect(out.map((c) => c.order)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it("accepts a bare array and returns nothing on garbage", () => {
    expect(parseCopyProposals([{ template: 2, headline: "ok" }], templates, 4)).toHaveLength(1);
    expect(parseCopyProposals(null, templates, 4)).toEqual([]);
    expect(parseCopyProposals("texte", templates, 4)).toEqual([]);
  });
});

describe("Fabrique — prompt image", () => {
  it("appends the approved texts exactly, or keeps the zones free when textless", () => {
    const p = buildFactoryImagePrompt("BASE", { headline: "Reprendre confiance", subline: "Un suivi chaque semaine", cta: "Réserver" }, false);
    expect(p.startsWith("BASE\n")).toBe(true);
    expect(p).toContain("Titre : « Reprendre confiance »");
    expect(p).toContain("Sous-titre : « Un suivi chaque semaine »");
    expect(p).toContain("Bouton : « Réserver »");
    expect(p).toContain("Aucun autre texte");
    const t = buildFactoryImagePrompt("BASE", { headline: "H", subline: "", cta: "" }, true);
    expect(t).toContain("posés ensuite");
    expect(t).not.toContain("Sous-titre");
  });
});

describe("Fabrique — plan de génération", () => {
  it("splits in batches of 4", () => {
    expect(splitBatches(12)).toEqual([4, 4, 4]);
    expect(splitBatches(10)).toEqual([4, 4, 2]);
    expect(splitBatches(3)).toEqual([3]);
    expect(splitBatches(0)).toEqual([]);
    expect(splitBatches(5, 2)).toEqual([2, 2, 1]);
  });
  it("gives every approved copy one visual before any gets two (round-robin), skipping copies without template", () => {
    const copies = [{ id: "a", templateId: "t1" }, { id: "b", templateId: "t1" }, { id: "c", templateId: "t2" }, { id: "z", templateId: null }];
    const slots = planSlots(copies, 7);
    expect(slots.map((s) => s.copyId)).toEqual(["a", "b", "c", "a", "b", "c", "a"]);
    expect(slots[2].templateId).toBe("t2");
    expect(planSlots([], 5)).toEqual([]);
    expect(planSlots(copies, 0)).toEqual([]);
  });
  it("one pass takes ≤ 12 slots after what was attempted and groups them per copy into fal calls of ≤ 4", () => {
    const copies = [{ id: "a", templateId: "t1" }, { id: "b", templateId: "t2" }];
    const slots = planSlots(copies, 30);
    const first = passPlan(slots, 0);
    expect(first.reduce((s, b) => s + b.count, 0)).toBe(12);
    expect(first.map((b) => [b.copyId, b.count])).toEqual([["a", 4], ["a", 2], ["b", 4], ["b", 2]]);
    const third = passPlan(slots, 24);
    expect(third.reduce((s, b) => s + b.count, 0)).toBe(6);
    expect(passPlan(slots, 30)).toEqual([]);
    expect(first.every((b) => b.count <= 4)).toBe(true);
  });
  it("prices and remaining", () => {
    expect(estimateUsd(0.06, 12)).toBe(0.72);
    expect(estimateUsd(0.06, 0)).toBe(0);
    expect(estimateUsd(-1, 3)).toBe(0);
    expect(remainingOf({ n: 12, attempted: 8 })).toBe(4);
    expect(remainingOf({ n: 12, attempted: 14 })).toBe(0);
  });
});

describe("Fabrique — machine à états", () => {
  it("allows the expected transitions only", () => {
    const ok: Array<[RunStatus, RunStatus]> = [["draft", "copy_review"], ["copy_review", "generating"], ["generating", "review"], ["review", "done"], ["done", "review"], ["failed", "copy_review"], ["review", "generating"]];
    for (const [a, b] of ok) expect(canTransition(a, b), `${a} → ${b}`).toBe(true);
    const ko: Array<[RunStatus, RunStatus]> = [["draft", "generating"], ["done", "copy_review"], ["generating", "copy_review"], ["review", "copy_review"]];
    for (const [a, b] of ko) expect(canTransition(a, b), `${a} → ${b}`).toBe(false);
  });
  it("status after a pass: generating while slots remain, review when all tried, failed when all failed", () => {
    expect(statusAfterPass({ n: 12, attempted: 8, failed: 2 })).toBe("generating");
    expect(statusAfterPass({ n: 12, attempted: 12, failed: 1 })).toBe("review");
    expect(statusAfterPass({ n: 12, attempted: 12, failed: 12 })).toBe("failed");
  });
  it("review becomes done once every visual is judged, and reopens", () => {
    expect(statusAfterVerdicts({ status: "review", generated: 3, kept: 2, cut: 1 })).toBe("done");
    expect(statusAfterVerdicts({ status: "done", generated: 3, kept: 1, cut: 1 })).toBe("review");
    expect(statusAfterVerdicts({ status: "generating", generated: 3, kept: 3, cut: 0 })).toBe("generating");
    expect(statusAfterVerdicts({ status: "review", generated: 0, kept: 0, cut: 0 })).toBe("review");
  });
});

describe("Fabrique — réglages, sources, Drive", () => {
  it("parses settings with defaults and caps", () => {
    const s = parseSettings(JSON.stringify({ n: 12.4, engine: "fal-ai/nano-banana-2/edit", attempted: 8, failed: 1, error: "x", perTemplate: 0 }));
    expect(s).toMatchObject({ n: 12, attempted: 8, failed: 1, error: "x", perTemplate: 4, ratio: "1:1", textless: false });
    expect(parseSettings("nope").engine).toBe("fal-ai/nano-banana-2/edit");
    expect(parseSources('[{"kind":"hq_brief","ref":"x","chars":12},{"nope":1},3]')).toEqual([{ kind: "hq_brief", ref: "x", chars: 12 }]);
  });
  it("names the Drive folder and files", () => {
    expect(factoryFolderName("offer", new Date("2026-10-29T12:00:00Z"))).toBe("Fabrique 2026-10-29 offer");
    expect(factoryFileName(0, "Pub A / test", "Reprendre confiance : oui ?", "png")).toBe("01 Pub A - test — Reprendre confiance - oui -.png");
  });
});
