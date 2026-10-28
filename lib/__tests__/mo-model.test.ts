import { describe, expect, it } from "vitest";
import { layoutNewCards, parseMoAnswer, sanitizeAsk, sanitizeOpen } from "@/lib/mo/model";

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
