import { describe, expect, it } from "vitest";
import { applyCardUpdates, describeCards, parseMoAnswer, type MoCard } from "@/lib/mo/model";
import { periodRange, frMetrics, shortName } from "@/lib/mo/tools";
import { deriveMetrics } from "@/lib/ads-warehouse/query";

const at = "2026-10-28T10:00:00.000Z";
const board: MoCard[] = [
  { id: "abc123", type: "creatives", title: "Créas", subtitle: "Meta", x: 0, y: 0, w: 660, h: 440, z: 1, turn: 0, at, items: [{ name: "UGC Lisa", adId: "120", metrics: {} }] },
  { id: "def456", type: "note", title: "Note", x: 700, y: 0, w: 440, h: 320, z: 2, turn: 0, at, markdown: "x" },
];

describe("Mo — update and remove cards", () => {
  it("parses update / remove next to cards", () => {
    const a = parseMoAnswer('```mo\n{"say":"Voilà.","cards":[],"update":[{"id":"abc123","type":"creatives","items":[{"name":"UGC Lisa","adId":"120","image":"/api/studio/assets/ckx12345/file?inline=1","metrics":{"CPL":"13,3 €"}}]}],"remove":["def456"]}\n```');
    expect(a.updates).toHaveLength(1);
    expect(a.remove).toEqual(["def456"]);
    expect(a.say).toBe("Voilà.");
    const items = (a.updates[0] as { items: Array<{ image?: string; adId?: string }> }).items;
    expect(items[0].image).toBe("/api/studio/assets/ckx12345/file?inline=1");
    expect(items[0].adId).toBe("120");
  });
  it("rewrites the card in place and drops the removed one", () => {
    const a = parseMoAnswer('{"say":"ok","update":[{"id":"abc123","type":"creatives","items":[{"name":"UGC Lisa","metrics":{"CPL":"13,3 €"}}]}],"remove":["def456"]}');
    const r = applyCardUpdates(board, a, 3, at);
    expect(r.cards.map((c) => c.id)).toEqual(["abc123"]);
    expect(r.touched.sort()).toEqual(["abc123", "def456"]);
    const c = r.cards[0] as Extract<MoCard, { type: "creatives" }>;
    expect(c.items[0].metrics.CPL).toBe("13,3 €");
    expect(c.x).toBe(0); expect(c.w).toBe(660); expect(c.turn).toBe(3); expect(c.title).toBe("Créas");
  });
  it("retitles without touching the content", () => {
    const a = parseMoAnswer('{"say":"ok","update":[{"id":"def456","title":"Lecture"}]}');
    const r = applyCardUpdates(board, a, 1, at);
    const n = r.cards.find((c) => c.id === "def456") as Extract<MoCard, { type: "note" }>;
    expect(n.title).toBe("Lecture"); expect(n.markdown).toBe("x");
  });
  it("ignores unknown ids and rejects foreign images", () => {
    const a = parseMoAnswer('{"say":"ok","update":[{"id":"zzz999","type":"note","markdown":"m"}],"cards":[{"type":"creatives","title":"t","items":[{"name":"a","image":"http://evil/x.png","metrics":{}}]}]}');
    expect(applyCardUpdates(board, a, 1, at).cards).toHaveLength(2);
    expect((a.cards[0] as { items: Array<{ image?: string }> }).items[0].image).toBeUndefined();
  });
  it("describes what the cards hold", () => {
    const d = describeCards(board);
    expect(d).toContain("UGC Lisa [ad 120]");
  });
});

describe("Mo — periods said out loud (Paris, Monday → Sunday)", () => {
  const wed = new Date("2026-10-28T13:00:00Z"); // mercredi
  it("this week / last week / yesterday", () => {
    expect(periodRange({ period: "this_week" }, wed)).toMatchObject({ since: "2026-10-26", until: "2026-10-28" });
    expect(periodRange({ period: "last_week" }, wed)).toMatchObject({ since: "2026-10-19", until: "2026-10-25" });
    expect(periodRange({ period: "yesterday" }, wed)).toMatchObject({ since: "2026-10-27", until: "2026-10-27" });
    expect(periodRange({ period: "last_month" }, wed)).toMatchObject({ since: "2026-09-01", until: "2026-09-30" });
    expect(periodRange({}, wed)).toMatchObject({ since: "2026-10-22", until: "2026-10-28" });
  });
  it("explicit dates win, in order", () => {
    expect(periodRange({ since: "2026-10-05", until: "2026-10-01" }, wed)).toMatchObject({ since: "2026-10-01", until: "2026-10-05" });
  });
  it("formats metrics in French, no invented ratio", () => {
    const m = deriveMetrics({ spend: 412.4, impressions: 22000, reach: 0, clicks: 500, linkClicks: 400, conversions: 31, conversionValue: 0, purchases: 0, purchaseValue: 0, leads: 31, videoPlays: 0, video3s: 0, thruPlays: 0, p25: 0, p50: 0, p75: 0, p100: 0 }, null);
    const fr = frMetrics(m, "EUR");
    expect(fr["Dépense"]).toMatch(/412/);
    expect(fr.CPL).toMatch(/13,3/);
    expect(fr.ROAS).toBeUndefined();
  });
});

describe("Mo — readable ad names", () => {
  it("keeps the format and the telling parts of the naming convention", () => {
    const a = shortName("SGL_IMG_S-Pulse_V-CAD_C-Parent_Visu-Fille_Co-Checklist_M-AiderMonEnfant");
    expect(a).toContain("IMG");
    expect(a).toContain("Aider Mon Enfant");
    expect(a.length).toBeLessThanOrEqual(60);
    expect(shortName("Vidéo UGC Lisa - Copie")).toBe("Vidéo UGC Lisa");
    console.log(a, "|", shortName("SGL_UGC_S-Autre_V-Ingénieur_C-Parent_Visu-Pancarte_H-3RaisonsDe - Copie"));
  });
});
