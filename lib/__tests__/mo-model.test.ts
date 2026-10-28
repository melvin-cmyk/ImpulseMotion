import { describe, expect, it } from "vitest";
import { describeCards, layoutNewCards, modelHistory, parseMoAnswer, parseMoEntries, sanitizeAsk, sanitizeOpen } from "@/lib/mo/model";

describe("Mo — parsing of an answer", () => {
  it("reads the ```mo block: say, cards, open", () => {
    const text = "```mo\n" + JSON.stringify({ say: "Voilà.", open: "/analyse?client=abc123", cards: [{ type: "kpis", title: "CPA", items: [{ label: "CPA", value: "12 €" }] }] }) + "\n```";
    const a = parseMoAnswer(text);
    expect(a.say).toBe("Voilà.");
    expect(a.open).toBe("/analyse?client=abc123");
    expect(a.cards).toHaveLength(1);
    expect(a.cards[0].type).toBe("kpis");
  });
  it("turns prose into a note and says its first sentence", () => {
    const a = parseMoAnswer("Le CPA a baissé de 8 %. Les détails suivent.");
    expect(a.say).toBe("Le CPA a baissé de 8 %.");
    expect(a.cards[0]).toMatchObject({ type: "note" });
    expect(a.open).toBeUndefined();
  });
  it("drops empty or malformed cards", () => {
    const a = parseMoAnswer(JSON.stringify({ say: "ok", cards: [{ type: "table", columns: [] }, { type: "chart", x: [], series: [] }, { type: "nope" }, { type: "note", markdown: "x" }] }));
    expect(a.cards.map((c) => c.type)).toEqual(["note"]);
  });
});

describe("Mo — when it hesitates (ask)", () => {
  it("reads « ask » and says the question", () => {
    const a = parseMoAnswer("```mo\n" + JSON.stringify({ say: "Deux lectures possibles.", cards: [], ask: { question: "Naturalia ou Naturalia Bio ?", options: ["Naturalia", "Naturalia Bio"] } }) + "\n```");
    expect(a.ask).toEqual({ question: "Naturalia ou Naturalia Bio ?", options: ["Naturalia", "Naturalia Bio"] });
    expect(a.say).toBe("Deux lectures possibles. Naturalia ou Naturalia Bio ?");
    expect(a.cards).toHaveLength(0);
  });
  it("the question alone is said when « say » already carries it, or is missing", () => {
    expect(parseMoAnswer(JSON.stringify({ say: "Tu veux cette semaine ou ce mois-ci ?", ask: { question: "Tu veux cette semaine ou ce mois-ci ?", options: ["cette semaine", "ce mois-ci"] } })).say).toBe("Tu veux cette semaine ou ce mois-ci ?");
    expect(parseMoAnswer(JSON.stringify({ ask: { question: "Meta ou Google ?", options: ["Meta", "Google"] } })).say).toBe("Meta ou Google ?");
  });
  it("sanitises: 4 options at most, 60 chars each, distinct, a question required", () => {
    expect(sanitizeAsk({ question: "Q ?", options: ["a", "b", "c", "d", "e", "f"] })?.options).toEqual(["a", "b", "c", "d"]);
    expect(sanitizeAsk({ question: "Q ?", options: ["x".repeat(100)] })?.options[0]).toHaveLength(60);
    expect(sanitizeAsk({ question: "Q ?", options: ["a", "a", " a ", 3, null] })?.options).toEqual(["a", "3"]);
    expect(sanitizeAsk({ question: "", options: ["a"] })).toBeNull();
    expect(sanitizeAsk({ question: "Q ?", options: [] })).toBeNull();
    expect(sanitizeAsk("nope")).toBeNull();
    expect(parseMoAnswer(JSON.stringify({ say: "ok", ask: { question: "Q ?" } })).ask).toBeUndefined();
  });
  it("an « ask » card lands on the board like any other, with its size", () => {
    const placed = layoutNewCards([], { cards: [{ type: "ask", title: "Mo te demande", question: "Q ?", options: ["a", "b"] }] }, 0, "2026-10-28T00:00:00Z");
    expect(placed[0]).toMatchObject({ type: "ask", question: "Q ?", options: ["a", "b"], w: 440, h: 200 });
    const a = parseMoAnswer(JSON.stringify({ say: "ok", cards: [{ type: "ask", title: "?", question: "Q ?", options: ["a"] }] }));
    expect(a.cards[0]).toMatchObject({ type: "ask", options: ["a"] });
  });
});

describe("Mo — pages it may open", () => {
  it("accepts the app's pages", () => {
    expect(sanitizeOpen("/portfolio/ckx123")).toBe("/portfolio/ckx123");
    expect(sanitizeOpen("/analyse?client=ckx123")).toBe("/analyse?client=ckx123");
    expect(sanitizeOpen(" /cockpit ")).toBe("/cockpit");
    expect(sanitizeOpen("/me/alerts?dashboardId=1")).toBe("/me/alerts?dashboardId=1");
  });
  it("refuses the outside, the admin and odd characters", () => {
    expect(sanitizeOpen("https://evil.example")).toBeNull();
    expect(sanitizeOpen("//evil.example")).toBeNull();
    expect(sanitizeOpen("/admin/users")).toBeNull();
    expect(sanitizeOpen("/api/mo")).toBeNull();
    expect(sanitizeOpen("/portfolio/<script>")).toBeNull();
    expect(sanitizeOpen("/portfolioX")).toBeNull();
    expect(sanitizeOpen(42)).toBeNull();
  });
});

describe("Mo — layout", () => {
  it("puts a new turn on a row under the existing cards", () => {
    const first = layoutNewCards([], { say: "", cards: [{ type: "note", title: "a", markdown: "x" }, { type: "note", title: "b", markdown: "y" }] }, 0, "t");
    expect(first[0].y).toBe(0);
    expect(first[1].x).toBeGreaterThan(first[0].x);
    const second = layoutNewCards(first, { say: "", cards: [{ type: "note", title: "c", markdown: "z", ref: first[0].id }] }, 1, "t");
    expect(second[0].y).toBeGreaterThan(first[0].y);
    expect(second[0].ref).toBe(first[0].id);
  });
});

describe("Mo — cards of lot 2 (file, action) and verdicts", () => {
  it("keeps a verdict, a template id and the client on a creatives card", () => {
    const a = parseMoAnswer(JSON.stringify({ say: "ok", cards: [{ type: "creatives", title: "t", clientId: "d_cl", clientName: "Cours Legendre", items: [{ name: "a", metrics: {}, verdict: "keep", templateId: "tpl1" }, { name: "b", metrics: {}, verdict: "nope" }] }] }));
    const c = a.cards[0] as Extract<typeof a.cards[number], { type: "creatives" }>;
    expect(c.clientId).toBe("d_cl"); expect(c.clientName).toBe("Cours Legendre");
    expect(c.items[0]).toMatchObject({ verdict: "keep", templateId: "tpl1" });
    expect(c.items[1].verdict).toBeUndefined();
  });
  it("reads a file card (our own picture only, https link only)", () => {
    const a = parseMoAnswer(JSON.stringify({ say: "ok", cards: [{ type: "file", title: "visuel.png", name: "visuel.png", mime: "image/png", bytes: 1234.6, image: "/api/studio/assets/ckasset0000000001/file?inline=1", link: "https://drive.google.com/x", assetId: "ckasset0000000001", folder: "creas" }, { type: "file", title: "b", name: "brief.pdf", mime: "application/pdf", image: "http://evil/x.png", link: "ftp://x", folder: "briefs" }, { type: "file", title: "no name" }] }));
    expect(a.cards).toHaveLength(2);
    expect(a.cards[0]).toMatchObject({ type: "file", name: "visuel.png", bytes: 1235, image: "/api/studio/assets/ckasset0000000001/file?inline=1", link: "https://drive.google.com/x", assetId: "ckasset0000000001", folder: "creas" });
    expect(a.cards[1]).not.toHaveProperty("image");
    expect(a.cards[1]).not.toHaveProperty("link");
    expect(layoutNewCards([], { cards: a.cards }, 0, "t")[0]).toMatchObject({ w: 300, h: 380 });
  });
  it("reads a publish action card and refuses one without its draft", () => {
    const ok = { type: "action", title: "À publier", kind: "publish", actionId: "act_1", status: "to_confirm", assetId: "ckasset0000000001", adsetId: "12345678", account: "CL", adset: "Prospection", page: "Page", name: "Mo · x", primaryText: "Texte", linkUrl: "https://cours.fr", writesOpen: true, hq: "ok", pilotage: "/pilotage?dashboardId=d_cl", textsFrom: "UGC Lisa" };
    const a = parseMoAnswer(JSON.stringify({ say: "ok", cards: [ok, { ...ok, status: "sent", adId: "123" }, { ...ok, status: "weird", pilotage: "https://evil" }, { ...ok, actionId: "" }, { ...ok, adsetId: "abc" }] }));
    expect(a.cards).toHaveLength(3);
    expect(a.cards[0]).toMatchObject({ type: "action", kind: "publish", status: "to_confirm", actionId: "act_1", textsFrom: "UGC Lisa", writesOpen: true });
    expect(a.cards[1]).toMatchObject({ status: "sent", adId: "123" });
    expect(a.cards[2]).toMatchObject({ status: "to_confirm", pilotage: "/pilotage" });
  });
  it("describes verdicts, files and publications to the model", () => {
    const d = describeCards([
      { id: "a1", type: "creatives", title: "Créas", clientName: "CL", x: 0, y: 0, w: 1, turn: 0, at: "t", items: [{ name: "UGC Lisa", adId: "1", metrics: {}, verdict: "keep" }, { name: "B", metrics: {}, verdict: "cut" }] },
      { id: "a2", type: "file", title: "brief.pdf", name: "brief.pdf", mime: "application/pdf", link: "https://drive.google.com/x", x: 0, y: 0, w: 1, turn: 0, at: "t" },
      { id: "a3", type: "action", title: "À publier", kind: "publish", actionId: "x", status: "to_confirm", assetId: "s", adsetId: "12345678", account: "", adset: "Prospection", page: "", name: "", primaryText: "", linkUrl: "", writesOpen: false, hq: "", pilotage: "/pilotage", x: 0, y: 0, w: 1, turn: 0, at: "t" },
    ]);
    expect(d).toContain("[client CL]");
    expect(d).toContain("verdicts : UGC Lisa gardée ; B coupée");
    expect(d).toContain("fichier brief.pdf (dans le Drive)");
    expect(d).toContain("publication à confirmer par la personne : Prospection");
  });
});

describe("Mo — the journal's action lines", () => {
  it("are stored with the messages but never shown to the model", () => {
    const json = JSON.stringify([
      { role: "user", content: "créas cl", at: "t1" },
      { role: "action", content: "garde celle-là", at: "t2", action: { kind: "verdict", clientId: "d_cl", cardIds: ["abc123"], label: "Gardée : UGC Lisa", at: "t2" } },
      { role: "action", content: "x", at: "t3", action: { kind: "nope", cardIds: [], label: "" } },
      { role: "assistant", content: "```mo\n{}\n```", at: "t4", say: "ok" },
    ]);
    const all = parseMoEntries(json);
    expect(all.map((m) => m.role)).toEqual(["user", "action", "assistant"]);
    expect(all[1].action).toMatchObject({ kind: "verdict", clientId: "d_cl", cardIds: ["abc123"], label: "Gardée : UGC Lisa" });
    expect(modelHistory(all).map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});
