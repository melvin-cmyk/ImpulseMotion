import { describe, expect, it } from "vitest";
import { layoutNewCards, parseMoAnswer, sanitizeOpen } from "@/lib/mo/model";

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
