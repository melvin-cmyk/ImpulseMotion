import { describe, expect, it } from "vitest";
import { winningAngles, renderWarehouseSection, renderClientContext, hqMirrorContent, cleanEditedDoc, type WarehouseAdInput } from "@/lib/creas/context-doc";
import { assembleContext } from "@/lib/creas/copy";
import { formatOf, groupFormats, renderPlaybook, pickByNumbers, playbookKey, type PlaybookCandidate } from "@/lib/creas/playbook-doc";
import { parseFactoryIntent, saidNumbers } from "@/lib/mo/intents";
import { usefulComment, pickComments } from "@/lib/meta-comments";
import { parseSources } from "@/lib/creas/model";

const ad = (name: string, spend: number, conversions: number, tags: Record<string, string> = {}, ctr = 1): WarehouseAdInput => ({ name, title: `Titre ${name}`, body: `Texte ${name}`, spend, conversions, cpa: conversions ? spend / conversions : 0, ctr, roas: null, tags });

describe("winningAngles", () => {
  it("picks winners by CPA and finds over-represented angles", () => {
    const ads = [
      ad("A", 500, 50, { "ai:hook": "Preuve sociale", "ai:format": "Témoignage" }),
      ad("B", 400, 40, { "ai:hook": "Preuve sociale", "ai:format": "Témoignage" }),
      ad("C", 600, 10, { "ai:hook": "Question", "ai:format": "Titre en gros" }),
      ad("D", 300, 3, { "ai:hook": "Question", "ai:format": "Titre en gros" }),
      ad("E", 200, 2, { "ai:hook": "Chiffre", "ai:format": "Titre en gros" }),
      ad("F", 5, 0),
    ];
    const w = winningAngles(ads);
    expect(w.basis).toBe("cpa");
    expect(w.winners.map((a) => a.name)).toEqual(["A", "B"]);
    expect(w.winning.find((x) => x.value === "Preuve sociale")?.winners).toBe(100);
    expect(w.untested.some((u) => u.key === "ai:hook" && u.value === "Avant / après")).toBe(true);
    expect(w.untested.some((u) => u.value === "Preuve sociale")).toBe(false);
    const md = renderWarehouseSection(w, "90 derniers jours");
    expect(md).toContain("coût par résultat");
    expect(md).toContain("Angles jamais testés");
  });
  it("falls back to CTR when nothing converts, and says nothing without spend", () => {
    expect(winningAngles([ad("A", 100, 0, {}, 3), ad("B", 100, 0, {}, 1)]).basis).toBe("ctr");
    const none = winningAngles([ad("A", 3, 0)]);
    expect(none.winners).toEqual([]);
    expect(renderWarehouseSection(none, "x")).toBe("");
  });
});

describe("client context document", () => {
  it("orders sections, marks unconfirmed personas as hypothesis, traces sources", () => {
    const doc = renderClientContext({
      clientName: "Naturalia", brief: "Bio, prix justes.",
      hqFiles: [{ kind: "langage_client", path: "projects/n/brain/recherche/langage-client.md", content: "« enfin du bio pas cher » revient souvent dans les avis clients.", statut: "confirme" }, { kind: "personas", path: "projects/n/brain/recherche/personas.md", content: "Persona 1 : parents urbains soucieux du bio et du budget.", statut: "brouillon" }],
      warehouse: { section: "## Ce qui gagne\n- A", ref: "entrepôt" }, comments: ["Trop bien ce magasin"], feedback: [{ level: "client", text: "jamais de -50 %" }], verdictNotes: ["coupée : packaging déformé"],
    });
    expect(doc.sources.map((s) => s.kind)).toEqual(["hq_brief", "personas", "langage_client", "warehouse", "comments", "feedback"]);
    expect(doc.sources.find((s) => s.kind === "personas")?.note).toBe("hypothèse");
    expect(doc.md.indexOf("Personas")).toBeLessThan(doc.md.indexOf("Langage client"));
    expect(doc.md).toContain("HYPOTHÈSE");
    expect(doc.md).toContain("jamais de -50 %");
  });
  it("a run uses the client document instead of the bare brief", () => {
    const ctx = assembleContext({ clientName: "N", brief: "ignored", client: { md: "# Contexte statics — N\n\n## Brief\nVrai brief", sources: [{ kind: "hq_brief", ref: "x", chars: 10 }] }, templates: [], reviews: "", feedback: [], instructions: "Noël" });
    expect(ctx.md).toContain("Vrai brief");
    expect(ctx.md).not.toContain("ignored");
    expect(ctx.md.match(/# Contexte statics/g)?.length).toBe(1);
    expect(ctx.sources.map((s) => s.kind)).toEqual(["hq_brief", "instructions"]);
  });
  it("HQ mirror has a state frontmatter; edits lose a pasted frontmatter", () => {
    const m = hqMirrorContent("## A\nb", "Melvin: test", new Date("2026-10-29T10:00:00Z"));
    expect(m.startsWith("---\nstatut: brouillon\n")).toBe(true);
    expect(m).toContain('confirme_par: "Melvin: test"');
    expect(m).toContain("maj: 2026-10-29");
    expect(cleanEditedDoc(m)).toBe("## A\nb");
  });
  it("parseSources keeps the note", () => {
    expect(parseSources('[{"kind":"personas","ref":"p","chars":3,"note":"hypothèse"}]')).toEqual([{ kind: "personas", ref: "p", chars: 3, note: "hypothèse" }]);
  });
});

const cand = (id: string, hook: string, structure = "", brief = ""): PlaybookCandidate => ({ libraryId: id, pageName: "Huel", image: null, text: "", startedAt: null, video: false, snapshotUrl: null, format: "", analysis: { hook, structure, textZones: [], style: "", palette: [], cta: "", whyItWorks: "", brief } });

describe("playbook", () => {
  it("recognises formats from the AI's words", () => {
    expect(formatOf({ hook: "Avant / après spectaculaire", structure: "", style: "" })).toBe("Avant / après");
    expect(formatOf({ hook: "Témoignage client avec étoiles", structure: "", style: "" })).toBe("Témoignage / avis client");
    expect(formatOf({ hook: "Packshot", structure: "produit géant au centre", style: "" })).toBe("Produit héros");
    expect(formatOf({ hook: "", structure: "", style: "" })).toBe("Non lu");
  });
  it("groups, ranks and tags polyvalent formats", () => {
    const c = [cand("1", "Avant / après"), cand("2", "avant et après"), cand("3", "Before after"), cand("4", "Témoignage"), cand("5", "Avant après Huel", "", "le shaker Huel au centre")];
    const f = groupFormats(c, "Huel");
    expect(f[0]).toMatchObject({ label: "Avant / après", count: 4, verdict: "polyvalent" });
    expect(f[1]).toMatchObject({ label: "Témoignage / avis client", count: 1, verdict: "spécifique" });
    expect(c[3].format).toBe("Témoignage / avis client");
    const md = renderPlaybook({ brand: "Huel", country: "FR", at: "2026-10-29T10:00:00Z", total: 9, analysed: 5, formats: f, candidates: c });
    expect(md).toContain("## Avant / après — 4 pubs");
    expect(md).toContain("À garder comme templates en priorité : Avant / après.");
  });
  it("numbers and cache key", () => {
    expect(pickByNumbers(["a", "b", "c"], [3, 1, 1, 9, 0])).toEqual(["c", "a"]);
    expect(playbookKey("La Fourche", "fr")).toBe("playbook:la-fourche:FR");
  });
});

describe("Mo fabrique intents", () => {
  it("approve", () => {
    expect(parseFactoryIntent("valide tout")).toMatchObject({ kind: "factory_approve", numbers: "all" });
    expect(parseFactoryIntent("valide 1 à 5")).toMatchObject({ numbers: [1, 2, 3, 4, 5] });
    expect(parseFactoryIntent("valide 1, 4 et 7")).toMatchObject({ numbers: [1, 4, 7] });
    expect(parseFactoryIntent("valide les 3 premiers")).toMatchObject({ numbers: [1, 2, 3] });
    expect(parseFactoryIntent("valide de deux à quatre")).toMatchObject({ numbers: [2, 3, 4] });
  });
  it("generate, repropose, and not the other follow-ups", () => {
    expect(parseFactoryIntent("génère 8 visuels")).toMatchObject({ kind: "factory_generate", n: 8 });
    expect(parseFactoryIntent("lance la génération")).toMatchObject({ kind: "factory_generate", n: null });
    expect(parseFactoryIntent("Génère vingt images")).toMatchObject({ n: 20 });
    expect(parseFactoryIntent("repropose les copys")).toMatchObject({ kind: "factory_repropose" });
    expect(parseFactoryIntent("génère deux autres comme ça")).toBeNull();
    expect(parseFactoryIntent("garde deux autres comme ça")).toBeNull();
    expect(parseFactoryIntent("les créas de naturalia cette semaine")).toBeNull();
    expect(saidNumbers("1 a 3 et 7")).toEqual([1, 2, 3, 7]);
  });
});

describe("Meta comments (closed until permissions)", () => {
  it("keeps words, drops tags, links and duplicates, most liked first", () => {
    expect(usefulComment("@Marie regarde")).toBe(false);
    expect(usefulComment("Check my profile https://spam.io")).toBe(false);
    expect(usefulComment("Enfin un magasin bio pas trop cher, je recommande")).toBe(true);
    const picked = pickComments([{ adId: "1", text: "Super produit, livré vite et bien emballé", likes: 1, at: null }, { adId: "2", text: "Super produit, livré vite et bien emballé", likes: 5, at: null }, { adId: "3", text: "Le goût est vraiment top pour les enfants", likes: 9, at: null }]);
    expect(picked.map((c) => c.likes)).toEqual([9, 5]);
  });
});
