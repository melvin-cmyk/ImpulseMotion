import { describe, expect, it } from "vitest";
import { HOME_TITLE, groupPages, pageTitle, parseCreatePage, type MoPageSummary } from "@/lib/mo/pages";
import { dayRange, journalForDay, localDay, type JournalBoard } from "@/lib/mo/journal";
import type { MoCard, MoMessage } from "@/lib/mo/model";

const page = (id: string, kind: MoPageSummary["kind"], extra: Partial<MoPageSummary> = {}): MoPageSummary => ({ id, title: "", kind, clientId: null, updatedAt: "2026-10-28T08:00:00.000Z", cards: 0, archived: false, position: 0, ...extra });

describe("pages — grouping and titles", () => {
  it("home first (always titled « Aujourd'hui »), client pages by position then name, free pages most recent first, archived left out", () => {
    const rows = [
      page("f1", "free", { title: "Vieille session", updatedAt: "2026-10-01T00:00:00.000Z" }),
      page("c2", "client", { clientId: "b", clientName: "Beta", position: 2 }),
      page("h", "home", { title: "Mo partout" }),
      page("f2", "free", { updatedAt: "2026-10-27T00:00:00.000Z" }),
      page("c1", "client", { clientId: "a", clientName: "Alpha", position: 1 }),
      page("c3", "client", { clientId: "z", title: "Zed (archivée)", archived: true, position: 3 }),
    ];
    const g = groupPages(rows)!;
    expect(g.home.id).toBe("h");
    expect(g.home.title).toBe(HOME_TITLE);
    expect(g.client.map((p) => p.id)).toEqual(["c1", "c2"]);
    expect(g.free.map((p) => p.id)).toEqual(["f2", "f1"]);
    expect(groupPages(rows, true)!.client.map((p) => p.id)).toEqual(["c1", "c2", "c3"]);
  });
  it("needs the home page", () => {
    expect(groupPages([page("f", "free")])).toBeNull();
  });
  it("titles: home, the client's name, the page's own title, a placeholder", () => {
    expect(pageTitle(page("h", "home", { title: "x" }))).toBe(HOME_TITLE);
    expect(pageTitle(page("c", "client", { clientName: "Naturalia" }))).toBe("Naturalia");
    expect(pageTitle(page("c", "client", { title: "Natu — créas", clientName: "Naturalia" }))).toBe("Natu — créas");
    expect(pageTitle(page("f", "free"))).toBe("Page sans titre");
  });
  it("reads the body of POST /api/mo", () => {
    expect(parseCreatePage(undefined)).toEqual({ kind: "free" });
    expect(parseCreatePage({ kind: "free", title: "  Brief DA  " })).toEqual({ kind: "free", title: "Brief DA" });
    expect(parseCreatePage({ kind: "client", clientId: "cmtbhy0qi00a26lg06kpjqo33" })).toEqual({ kind: "client", clientId: "cmtbhy0qi00a26lg06kpjqo33" });
    expect(parseCreatePage({ kind: "client" })).toHaveProperty("error");
    expect(parseCreatePage({ kind: "client", clientId: "x y" })).toHaveProperty("error");
    expect(parseCreatePage({ kind: "home" })).toEqual({ kind: "home" });
    expect(parseCreatePage({ kind: "nope" })).toHaveProperty("error");
  });
});

describe("journal — the day's entries across pages", () => {
  const card = (id: string, extra: Partial<MoCard> = {}): MoCard => ({ id, type: "kpis", title: `Carte ${id}`, items: [{ label: "CPA", value: "1" }], x: 0, y: 0, w: 1, h: 1, turn: 0, at: "t", ...extra } as MoCard);
  const msg = (m: Partial<MoMessage> & Pick<MoMessage, "role" | "at">): MoMessage => ({ content: "", ...m });
  const boards: JournalBoard[] = [
    { id: "home", title: "Aujourd'hui", kind: "home", clientId: null, cards: [card("k1", { clientId: "nat", clientName: "Naturalia" }), card("fr", { type: "frame" } as Partial<MoCard>)], messages: [
      msg({ role: "user", at: "2026-10-28T07:59:00.000Z", content: "chiffres de naturalia" }),
      msg({ role: "assistant", at: "2026-10-28T08:00:05.000Z", say: "Naturalia ce mois-ci : CPA 12 €.", cardIds: ["fr", "k1"] }),
      msg({ role: "assistant", at: "2026-10-28T08:01:00.000Z", say: "Je n'ai rien à afficher.", cardIds: [] }),
      msg({ role: "action", at: "2026-10-28T09:30:00.000Z", content: "Gardée", action: { kind: "verdict", clientId: "cl", cardIds: ["zz"], label: "Gardée : visuel A (Cours Legendre)", at: "2026-10-28T09:30:00.000Z" } }),
      msg({ role: "action", at: "2026-10-27T23:30:00.000Z", content: "hier", action: { kind: "upload", cardIds: ["zz"], label: "Hier", at: "2026-10-27T23:30:00.000Z" } }),
    ] },
    { id: "cl", title: "Cours Legendre", kind: "client", clientId: "cl", cards: [card("p1")], messages: [
      msg({ role: "action", at: "2026-10-28T10:00:00.000Z", content: "", action: { kind: "publish_confirm", cardIds: ["p1"], label: "Publicité créée EN PAUSE", at: "2026-10-28T10:00:00.000Z" } }),
    ] },
  ];
  it("lists actions and turns with cards of the day only, newest first, with the client", () => {
    const range = dayRange("2026-10-28", 0)!;
    const entries = journalForDay(boards, range, new Map([["cl", "Cours Legendre"]]));
    expect(entries.map((e) => e.kind)).toEqual(["publish_confirm", "verdict", "cards"]);
    expect(entries[0]).toMatchObject({ boardId: "cl", boardKind: "client", clientId: "cl", clientName: "Cours Legendre", cardIds: ["p1"] });
    expect(entries[1]).toMatchObject({ clientId: "cl", clientName: "Cours Legendre", label: "Gardée : visuel A (Cours Legendre)" });
    // The turn's client comes from its cards (frames ignored), the label from what Mo said.
    expect(entries[2]).toMatchObject({ clientId: "nat", clientName: "Naturalia", label: "Naturalia ce mois-ci : CPA 12 €.", cardIds: ["fr", "k1"] });
  });
  it("the day follows the person's timezone offset", () => {
    // 23:30 UTC on the 27th is 00:30 on the 28th in Paris (UTC+1 → offset −60).
    const paris = journalForDay(boards, dayRange("2026-10-28", -60)!);
    expect(paris.some((e) => e.label === "Hier")).toBe(true);
    const utc = journalForDay(boards, dayRange("2026-10-28", 0)!);
    expect(utc.some((e) => e.label === "Hier")).toBe(false);
  });
  it("day ranges and the local day", () => {
    expect(dayRange("2026-10-28", 0)).toEqual({ start: "2026-10-28T00:00:00.000Z", end: "2026-10-29T00:00:00.000Z" });
    expect(dayRange("2026-10-28", -120)).toEqual({ start: "2026-10-27T22:00:00.000Z", end: "2026-10-28T22:00:00.000Z" });
    expect(dayRange("28/10/2026")).toBeNull();
    expect(localDay(new Date(2026, 9, 5))).toBe("2026-10-05");
  });
});
