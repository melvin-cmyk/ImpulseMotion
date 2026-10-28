import { describe, expect, it } from "vitest";
import { cardRemovedTooSoon, foldSimilarity, isNegation, misunderstoodBy, percentile, summarizeMoTurns } from "@/lib/mo/measure";
import { brandBriefFromHq, competitorsFromBrief, moreLikeThisPrompt } from "@/lib/mo/brief";
import { parseTurnCreate, parseTurnPatch } from "@/lib/mo/turns";

describe("Mo measures — misunderstanding rules (spec §6)", () => {
  it("similarity of two sentences after fold, stop words apart", () => {
    expect(foldSimilarity("les créas de Cours Legendre cette semaine", "créas cours legendre cette semaine")).toBeGreaterThan(0.6);
    expect(foldSimilarity("les créas de Cours Legendre cette semaine", "le CPA de Naturalia ce mois-ci")).toBeLessThan(0.3);
    expect(foldSimilarity("", "")).toBe(0);
  });
  it("a reformulation within 60 s marks the previous turn", () => {
    const prev = { text: "montre les créas de cours legendre cette semaine", at: 1_000 };
    expect(misunderstoodBy(prev, { text: "les créas cours legendre de cette semaine", at: 20_000 })).toBe("reformulation");
    expect(misunderstoodBy(prev, { text: "les créas cours legendre de cette semaine", at: 90_000 })).toBeNull();
    expect(misunderstoodBy(prev, { text: "chiffres de Naturalia", at: 5_000 })).toBeNull();
  });
  it("« non / pas ça / je voulais » is a correction", () => {
    expect(isNegation("Non, pas ça")).toBe(true);
    expect(isNegation("je voulais les créas de la semaine dernière")).toBe(true);
    expect(isNegation("non")).toBe(true);
    expect(isNegation("montre les créas de Naturalia")).toBe(false);
    expect(misunderstoodBy({ text: "x", at: 0 }, { text: "pas ça, je parlais de LPEV", at: 10 })).toBe("negation");
    expect(misunderstoodBy(null, { text: "non", at: 10 })).toBeNull();
  });
  it("a card removed within 30 s was not what was wanted", () => {
    const turn = { at: 0, cardIds: ["a1", "b2"] };
    expect(cardRemovedTooSoon(turn, "a1", 10_000)).toBe(true);
    expect(cardRemovedTooSoon(turn, "a1", 40_000)).toBe(false);
    expect(cardRemovedTooSoon(turn, "zz", 1_000)).toBe(false);
    expect(cardRemovedTooSoon(null, "a1", 1_000)).toBe(false);
  });
});

describe("Mo measures — summary for /admin/usage", () => {
  it("percentiles by nearest rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 90)).toBe(5);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 90)).toBe(7);
  });
  it("time to first card by path, share without model, misunderstanding rate, actions per day", () => {
    const at = "2026-10-28T09:00:00.000Z";
    const rows = [
      { userId: "u1", path: "quick", kind: "creatives", firstCardMs: 2100, totalMs: 2000, clarified: false, retried: false, misunderstood: false, at },
      { userId: "u1", path: "quick", kind: "metrics", firstCardMs: 2900, totalMs: 2700, clarified: false, retried: true, misunderstood: false, at },
      { userId: "u1", path: "quick", kind: "more_like_this", firstCardMs: 31000, totalMs: 30000, clarified: false, retried: false, misunderstood: false, at },
      { userId: "u2", path: "act", kind: "verdict", firstCardMs: null, totalMs: 600, clarified: false, retried: false, misunderstood: false, at },
      { userId: "u2", path: "act", kind: "verdict", firstCardMs: 700, totalMs: 500, clarified: false, retried: false, misunderstood: false, at: "2026-10-27T09:00:00.000Z" },
      { userId: "u1", path: "model", kind: null, firstCardMs: 9000, totalMs: 25000, clarified: false, retried: false, misunderstood: true, at },
      { userId: "u1", path: "nav", kind: null, firstCardMs: 0, totalMs: 0, clarified: false, retried: false, misunderstood: false, at },
      { userId: "u1", path: "ask", kind: "creatives", firstCardMs: null, totalMs: 0, clarified: true, retried: false, misunderstood: false, at },
      { userId: "u1", path: "ask", kind: "metrics", firstCardMs: null, totalMs: 0, clarified: false, retried: false, misunderstood: false, at },
    ];
    const s = summarizeMoTurns(rows);
    expect(s.turns).toBe(9);
    const quick = s.byPath.find((p) => p.path === "quick")!;
    expect(quick.turns).toBe(3);
    expect(quick.p50FirstCardMs).toBe(2900);
    expect(quick.p90FirstCardMs).toBe(31000);
    const act = s.byPath.find((p) => p.path === "act")!;
    expect(act.p50FirstCardMs).toBe(600); // the server's total stands in when the browser gave nothing
    // 7 requests (asks apart): nav + 3 quick + 2 act = 6 without the model.
    expect(s.withoutModelPct).toBe(86);
    // misunderstood: the model turn + the ask left without a chip = 2 / 9.
    expect(s.asksAbandoned).toBe(1);
    expect(s.misunderstoodPct).toBe(22.2);
    expect(s.actionsByDay).toEqual([
      { day: "2026-10-28", userId: "u1", actions: 1, kinds: { more_like_this: 1 } },
      { day: "2026-10-28", userId: "u2", actions: 1, kinds: { verdict: 1 } },
      { day: "2026-10-27", userId: "u2", actions: 1, kinds: { verdict: 1 } },
    ]);
  });
  it("is empty without rows", () => {
    const s = summarizeMoTurns([]);
    expect(s.turns).toBe(0);
    expect(s.withoutModelPct).toBeNull();
    expect(s.misunderstoodPct).toBeNull();
    expect(s.byPath.every((p) => p.turns === 0 && p.p50FirstCardMs === null)).toBe(true);
  });
});

describe("Mo measures — the turn API bodies", () => {
  it("reads a patch field by field", () => {
    expect(parseTurnPatch({ firstCardMs: 1234.6, misunderstood: true, junk: 1 })).toEqual({ firstCardMs: 1235, misunderstood: true });
    expect(parseTurnPatch({ firstCardMs: -5 })).toEqual({ error: "Rien à modifier." });
    expect(parseTurnPatch(null)).toEqual({ error: "Corps illisible." });
  });
  it("reads a browser-side turn (nav, ask) and refuses the model path", () => {
    expect(parseTurnCreate({ boardId: "cmabcdefgh1234", path: "nav" })).toMatchObject({ boardId: "cmabcdefgh1234", path: "nav", totalMs: 0, clarified: false });
    expect(parseTurnCreate({ boardId: "cmabcdefgh1234", path: "model" })).toEqual({ error: "path nav | quick | act | ask requis." });
    expect(parseTurnCreate({ boardId: "x", path: "nav" })).toEqual({ error: "boardId requis." });
  });
});

const BRIEF = `### Client
Secteur : enseignement, France, modèle lead_gen, consultant référent Jordan.
### Objectifs & KPI cible
- KPI principal : CPL, événement « Lead » ; CPL max 25 €.
### Saisonnalité & contexte marché
- Rentrée septembre et janvier ; concurrents : Acadomia, Complétude et Les Sherpas (soutien scolaire).
### Règles & points d'attention
- Jamais de visuel avec des enfants seuls ; couleurs bleu nuit et jaune.
### Personas
- Parent inquiet (mère, 40-50 ans) : « aidez votre enfant à reprendre confiance ».`;

describe("Mo brief — the HQ brief at generation", () => {
  it("keeps the brand lines, the rules, the personas and the objective, within the cap", () => {
    const b = brandBriefFromHq(BRIEF);
    expect(b).toContain("Marque : Secteur : enseignement");
    expect(b).toContain("Règles de la marque : Jamais de visuel avec des enfants seuls");
    expect(b).toContain("Cibles : Parent inquiet");
    expect(b).toContain("Objectif : KPI principal : CPL");
    expect(b).not.toContain("Acadomia");
    expect(brandBriefFromHq(BRIEF, 80).length).toBeLessThanOrEqual(80);
    expect(brandBriefFromHq(null)).toBe("");
    expect(brandBriefFromHq("### Décisions & historique\n- 2026-01-01 : budget doublé")).toBe("");
  });
  it("names the competitors of the market section", () => {
    expect(competitorsFromBrief(BRIEF)).toEqual(["Acadomia", "Complétude", "Les Sherpas"]);
    expect(competitorsFromBrief("### Client\nRien ici.")).toEqual([]);
    expect(competitorsFromBrief("Concurrents directs : La Fourche, Greenweez / Kazidomi")).toEqual(["La Fourche", "Greenweez", "Kazidomi"]);
  });
  it("writes the generation prompt from the card (names, notes, style)", () => {
    const p = moreLikeThisPrompt({ clientName: "Cours Legendre", names: ["IMG · Parent · Checklist", "UGC Lisa"], notes: ["Hook fort"], style: "en jaune", n: 2 });
    expect(p).toContain("Cours Legendre");
    expect(p).toContain("« IMG · Parent · Checklist », « UGC Lisa »");
    expect(p).toContain("Variante demandée : en jaune.");
    expect(p).toContain("Hook fort");
    expect(p).toContain("distincte");
    expect(moreLikeThisPrompt({ clientName: "X", names: [], style: "", n: 1 })).toContain("Propose une variante nouvelle");
  });
});
