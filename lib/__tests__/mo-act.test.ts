import { describe, expect, it, vi } from "vitest";
import { ActError, cardClientOf, cardPeriodOf, dropClientOf, fileKindOf, hitTestCard, parseActRequest, publishCardSpec, runMoAct, warehouseAdOf, withItemPatch, type ActClient, type ActDeps, type PreparedPublish } from "@/lib/mo/act";
import type { MoCard, MoCardSpec } from "@/lib/mo/model";

const at = "2026-10-28T10:00:00.000Z";
const clients: ActClient[] = [
  { id: "d_cl", clientId: "ac_cl", name: "Cours Legendre", dashboardId: "d_cl" },
  { id: "d_nat", clientId: "ac_nat", name: "Naturalia", dashboardId: "d_nat" },
  { id: "ac_nodash", clientId: "ac_nodash", name: "LPEV", dashboardId: null },
];
const creas: Extract<MoCard, { type: "creatives" }> = {
  id: "abc123", type: "creatives", title: "Créas Cours Legendre — cette semaine", subtitle: "Meta · Cours Legendre · 2026-10-26 → 2026-10-28", clientId: "d_cl", clientName: "Cours Legendre",
  x: 100, y: 200, w: 660, h: 440, z: 3, turn: 0, at,
  items: [
    { name: "UGC Lisa", adId: "120001", image: "/api/mo/ad-image/meta/120001", metrics: { Dépense: "120 €" } },
    { name: "Proposition 2", assetId: "ckasset0000000001", image: "/api/studio/assets/ckasset0000000001/file?inline=1", metrics: {} },
    { name: "La Fourche · depuis le 3 oct.", adId: "adlib:555", image: "https://scontent.example/x.jpg", metrics: { Format: "image" }, note: "Bio pas cher" },
  ],
};

describe("Mo act — reading the request", () => {
  it("accepts each action with its fields", () => {
    expect(parseActRequest({ action: "verdict", cardId: "abc123", item: 1, verdict: "keep" })).toEqual({ action: "verdict", cardId: "abc123", item: 1, verdict: "keep" });
    expect(parseActRequest({ action: "verdict", cardId: "abc123", item: 0, verdict: null, said: "retire" })).toMatchObject({ verdict: null, said: "retire" });
    expect(parseActRequest({ action: "creative_metrics", cardId: "abc123", period: "this_week" })).toEqual({ action: "creative_metrics", cardId: "abc123", period: "this_week" });
    expect(parseActRequest({ action: "open_editor", cardId: "abc123", item: 2, editor: "photocraft" })).toMatchObject({ editor: "photocraft" });
    expect(parseActRequest({ action: "competitor_ads", query: "La Fourche", clientId: "d_cl" })).toEqual({ action: "competitor_ads", query: "La Fourche", clientId: "d_cl" });
    expect(parseActRequest({ action: "publish_prepare", cardId: "abc123", item: 1, adsetId: "12345678", linkUrl: "https://x.fr" })).toMatchObject({ adsetId: "12345678", linkUrl: "https://x.fr" });
    expect(parseActRequest({ action: "publish_prepare", cardId: "abc123", item: 1, adsetId: "abc" })).not.toHaveProperty("adsetId");
    expect(parseActRequest({ action: "publish_confirm", cardId: "abc123", primaryText: "Hello" })).toEqual({ action: "publish_confirm", cardId: "abc123", primaryText: "Hello" });
    expect(parseActRequest({ action: "upload", name: "visuel.png", mime: "image/png", bytes: 1200, data: "data:image/png;base64,AAAA", x: 10.4, y: 20 })).toMatchObject({ action: "upload", name: "visuel.png", x: 10.4, y: 20 });
  });
  it("refuses what it cannot run", () => {
    expect(parseActRequest(null)).toHaveProperty("error");
    expect(parseActRequest({ action: "nope" })).toEqual({ error: "Action inconnue." });
    expect(parseActRequest({ action: "verdict", cardId: "!!", item: 0, verdict: "keep" })).toEqual({ error: "Carte inconnue." });
    expect(parseActRequest({ action: "verdict", cardId: "abc123", item: -1, verdict: "keep" })).toHaveProperty("error");
    expect(parseActRequest({ action: "verdict", cardId: "abc123", item: 0, verdict: "maybe" })).toHaveProperty("error");
    expect(parseActRequest({ action: "open_editor", cardId: "abc123", item: 0, editor: "paint" })).toHaveProperty("error");
    expect(parseActRequest({ action: "competitor_ads", query: "x" })).toHaveProperty("error");
    expect(parseActRequest({ action: "upload", name: "a.exe", mime: "application/octet-stream", bytes: 10, data: "AAAA", x: 0, y: 0 })).toHaveProperty("error");
    expect(parseActRequest({ action: "upload", name: "a.png", mime: "image/png", bytes: 21 * 1024 * 1024, data: "AAAA", x: 0, y: 0 })).toEqual({ error: "Fichier trop lourd (20 Mo au plus)." });
    expect(parseActRequest({ action: "upload", name: "a.png", mime: "image/png", bytes: 10, data: "", x: 0, y: 0 })).toEqual({ error: "Fichier vide." });
  });
  it("tells a visual from a brief", () => {
    expect(fileKindOf("image/png", "a.png")).toBe("image");
    expect(fileKindOf("", "photo.JPG")).toBe("image");
    expect(fileKindOf("application/pdf", "brief.pdf")).toBe("brief");
    expect(fileKindOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "brief.docx")).toBe("brief");
    expect(fileKindOf("text/csv", "data.csv")).toBeNull();
  });
});

describe("Mo act — cards", () => {
  it("finds the card's client by id, else by its title", () => {
    expect(cardClientOf(creas, clients)?.id).toBe("d_cl");
    expect(cardClientOf({ title: "Chiffres Naturalia · ce mois-ci", subtitle: "Meta" }, clients)?.id).toBe("d_nat");
    expect(cardClientOf({ title: "Pubs La Fourche en ce moment" }, clients)).toBeNull();
  });
  it("hit-tests the topmost card under a drop and falls back to the latest client card", () => {
    const other: MoCard = { id: "def456", type: "note", title: "Note", x: 0, y: 0, w: 440, h: 320, z: 9, turn: 0, at: "2026-10-28T11:00:00.000Z", markdown: "x" };
    const nat: MoCard = { id: "ghi789", type: "kpis", title: "Naturalia — 7 jours", clientId: "d_nat", x: 2000, y: 0, w: 440, h: 220, z: 1, turn: 0, at: "2026-10-28T12:00:00.000Z", items: [{ label: "CPA", value: "1" }] };
    expect(hitTestCard([creas, other], { x: 600, y: 400 })?.id).toBe("abc123");
    expect(hitTestCard([creas, other], { x: 150, y: 250 })?.id).toBe("def456");
    expect(hitTestCard([creas, other], { x: 50, y: 50 })?.id).toBe("def456");
    expect(hitTestCard([creas, other], { x: 5000, y: 5000 })).toBeNull();
    expect(dropClientOf([creas, other, nat], { x: 600, y: 400 }, clients)?.id).toBe("d_cl");
    expect(dropClientOf([creas, other, nat], { x: 5000, y: 5000 }, clients)?.id).toBe("d_nat");
    expect(dropClientOf([other], { x: 5000, y: 5000 }, clients)).toBeNull();
  });
  it("reads the period of a card, the platform of a warehouse ad, writes a verdict on one visual", () => {
    expect(cardPeriodOf(creas)).toEqual({ since: "2026-10-26", until: "2026-10-28" });
    expect(cardPeriodOf({ subtitle: "Meta" })).toBeNull();
    expect(warehouseAdOf(creas.items[0])).toEqual({ platform: "meta", adId: "120001" });
    expect(warehouseAdOf({ adId: "google:77" })).toEqual({ platform: "google", adId: "77" });
    expect(warehouseAdOf(creas.items[1])).toBeNull();
    expect(warehouseAdOf(creas.items[2])).toBeNull();
    const kept = withItemPatch(creas, 1, { verdict: "keep", templateId: "tpl1" }) as typeof creas;
    expect(kept.items[1]).toMatchObject({ verdict: "keep", templateId: "tpl1" });
    expect(kept.items[0].verdict).toBeUndefined();
    const undone = withItemPatch(kept, 1, { verdict: null }) as typeof creas;
    expect(undone.items[1].verdict).toBeUndefined();
    expect(undone.items[1].templateId).toBe("tpl1");
  });
  it("builds the « À publier » card from a prepared publication", () => {
    const prepared: PreparedPublish = { actionId: "act_1", writes_open: true, hq: "la publication sera consignée dans la fiche HQ du client", texts_from: "UGC Lisa", summary: { account: "CL (act_1)", adset: "Prospection large", adsetId: "12345678", page: "Cours Legendre", pageId: "99999999", name: "Mo · x", primaryText: "Texte", headline: "Titre", link: "https://cours.fr", cta: "LEARN_MORE", image: "/api/studio/assets/ckasset0000000001/file?inline=1" } };
    const spec = publishCardSpec(prepared, { clientId: "d_cl", clientName: "Cours Legendre", assetId: "ckasset0000000001", adsetId: "12345678", ref: "abc123", pilotage: "/pilotage?dashboardId=d_cl" });
    expect(spec).toMatchObject({ type: "action", kind: "publish", status: "to_confirm", actionId: "act_1", adsetId: "12345678", pageId: "99999999", primaryText: "Texte", headline: "Titre", linkUrl: "https://cours.fr", cta: "LEARN_MORE", textsFrom: "UGC Lisa", writesOpen: true, ref: "abc123", clientId: "d_cl" });
    const noCta = publishCardSpec({ ...prepared, summary: { ...prepared.summary, cta: "(bouton par défaut)", headline: null } }, { clientId: "d_cl", clientName: "CL", assetId: "a", adsetId: "12345678", pilotage: "/pilotage" });
    expect(noCta).not.toHaveProperty("cta");
    expect(noCta).not.toHaveProperty("headline");
  });
});

/** A board in memory and fakes for every dependency; each test overrides what it watches. */
function fakeDeps(cards: MoCard[], over: Partial<ActDeps> = {}) {
  const store = { cards: cards.map((c) => ({ ...c })), journal: [] as Array<{ kind: string; label: string; cardIds: string[]; content?: string }> };
  const deps: ActDeps = {
    loadCards: async () => store.cards,
    rewriteCard: async (id, fn) => { let out: MoCard | null = null; store.cards = store.cards.map((c) => { if (c.id !== id) return c; out = fn(c) ?? c; return out; }); return out; },
    placeCard: async (spec: MoCardSpec, at) => { const card = { ...spec, id: `new${store.cards.length}`, x: at.x, y: at.y, w: 560, h: 560, z: 10, turn: 0, at: "t" } as MoCard; store.cards.push(card); return card; },
    journal: async (a, content) => { store.journal.push({ kind: a.kind, label: a.label, cardIds: a.cardIds, content }); },
    clients: async () => clients,
    assetFeedback: vi.fn(async () => ({ ok: true as const, hq: { ok: true } })),
    keepTemplate: vi.fn(async () => ({ templateId: "tpl_own" })),
    creativeMetrics: vi.fn(async () => ({ updated_cards: ["abc123"], items: [{ found: true }] })),
    metaTargets: vi.fn(async () => ({ targets: [{ adsetId: "12345678", adset: "Prospection", campaign: "C", spend_30d: 900, status: "ACTIVE" }] })),
    metaPublishAd: vi.fn(async () => ({})),
    competitorAds: vi.fn(async () => ({ posted_card: "cmp1", count: 3 })),
    openEditor: vi.fn(async () => ({ ok: true as const, path: "/design/dsg1?ask=x" })),
    createAsset: vi.fn(async () => ({ ok: true as const, assetId: "ckasset0000000009" })),
    assetBytes: vi.fn(async () => ({ buf: Buffer.from("png"), mimeType: "image/png" })),
    adImageBytes: vi.fn(async () => ({ buf: Buffer.from("jpg"), mimeType: "image/jpeg" })),
    driveUpload: vi.fn(async () => ({ link: "https://drive.google.com/file/d/xyz" })),
    ...over,
  };
  return { deps, store };
}

const prepared = (actionId: string): PreparedPublish => ({ actionId, writes_open: true, hq: "ok", summary: { account: "CL", adset: "Prospection", adsetId: "12345678", page: "Page CL", pageId: "99999999", name: "Mo · x", primaryText: "Texte", headline: null, link: "https://cours.fr", cta: "(bouton par défaut)", image: "/api/studio/assets/ckasset0000000001/file?inline=1" } });

describe("Mo act — verdicts", () => {
  it("keeps a generated visual: feedback on the asset, badge on the card, a journal line", async () => {
    const { deps, store } = fakeDeps([creas]);
    const r = await runMoAct({ action: "verdict", cardId: "abc123", item: 1, verdict: "keep", said: "garde celle-là" }, deps, "Mel");
    expect(deps.assetFeedback).toHaveBeenCalledWith("ckasset0000000001", "keep");
    expect(deps.keepTemplate).not.toHaveBeenCalled();
    expect((store.cards[0] as typeof creas).items[1].verdict).toBe("keep");
    expect(r.say).toContain("Gardée");
    expect(r.hq).toEqual({ ok: true });
    expect(store.journal[0]).toMatchObject({ kind: "verdict", cardIds: ["abc123"], content: "garde celle-là" });
    expect(store.journal[0].label).toContain("Cours Legendre");
    // The same verdict again undoes it.
    await runMoAct({ action: "verdict", cardId: "abc123", item: 1, verdict: "keep" }, deps, "Mel");
    expect(deps.assetFeedback).toHaveBeenLastCalledWith("ckasset0000000001", null);
    expect((store.cards[0] as typeof creas).items[1].verdict).toBeUndefined();
  });
  it("keeps a warehouse ad as a template « own » of the client (keep_template with adId), a cut just marks it", async () => {
    const { deps, store } = fakeDeps([creas]);
    await runMoAct({ action: "verdict", cardId: "abc123", item: 0, verdict: "keep" }, deps, "Mel");
    expect(deps.keepTemplate).toHaveBeenCalledWith({ adId: "meta:120001", client: "d_cl", analyse: false });
    expect((store.cards[0] as typeof creas).items[0]).toMatchObject({ verdict: "keep", templateId: "tpl_own" });
    await runMoAct({ action: "verdict", cardId: "abc123", item: 2, verdict: "cut" }, deps, "Mel");
    expect(deps.keepTemplate).toHaveBeenCalledTimes(1);
    expect((store.cards[0] as typeof creas).items[2].verdict).toBe("cut");
    expect(deps.assetFeedback).not.toHaveBeenCalled();
  });
  it("keeps a competitor ad with its library id and picture", async () => {
    const { deps } = fakeDeps([creas]);
    await runMoAct({ action: "verdict", cardId: "abc123", item: 2, verdict: "keep" }, deps, "Mel");
    expect(deps.keepTemplate).toHaveBeenCalledWith(expect.objectContaining({ libraryId: "adlib:555", imageUrl: "https://scontent.example/x.jpg", brand: "La Fourche", body: "Bio pas cher" }));
  });
  it("refuses an unknown card or visual", async () => {
    const { deps } = fakeDeps([creas]);
    await expect(runMoAct({ action: "verdict", cardId: "zzz999", item: 0, verdict: "keep" }, deps, "Mel")).rejects.toBeInstanceOf(ActError);
    await expect(runMoAct({ action: "verdict", cardId: "abc123", item: 9, verdict: "keep" }, deps, "Mel")).rejects.toThrow(/plus sur la carte/);
  });
});

describe("Mo act — figures, editors, Drive, competitors", () => {
  it("puts the figures under the visuals over the card's own period, without the model", async () => {
    const { deps, store } = fakeDeps([creas]);
    const r = await runMoAct({ action: "creative_metrics", cardId: "abc123", said: "mets les chiffres dessous" }, deps, "Mel");
    expect(deps.creativeMetrics).toHaveBeenCalledWith({ client: "d_cl", adIds: ["120001"], since: "2026-10-26", until: "2026-10-28" });
    expect(r.cardIds).toEqual(["abc123"]);
    expect(store.journal[0]).toMatchObject({ kind: "creative_metrics", content: "mets les chiffres dessous" });
  });
  it("opens an asset in FigCraft, a warehouse ad through a template first", async () => {
    const { deps, store } = fakeDeps([creas]);
    const a = await runMoAct({ action: "open_editor", cardId: "abc123", item: 1, editor: "figcraft" }, deps, "Mel");
    expect(deps.openEditor).toHaveBeenCalledWith({ editor: "figcraft", assetId: "ckasset0000000001", clientId: "ac_cl" });
    expect(a.open).toBe("/design/dsg1?ask=x");
    await runMoAct({ action: "open_editor", cardId: "abc123", item: 0, editor: "photocraft" }, deps, "Mel");
    expect(deps.keepTemplate).toHaveBeenCalledWith({ adId: "meta:120001", client: "d_cl", analyse: false });
    expect(deps.openEditor).toHaveBeenLastCalledWith({ editor: "photocraft", templateId: "tpl_own", clientId: "ac_cl" });
    expect((store.cards[0] as typeof creas).items[0].templateId).toBe("tpl_own");
  });
  it("copies a visual in the client's Drive « Créas » and keeps the link on the card", async () => {
    const { deps, store } = fakeDeps([creas]);
    const r = await runMoAct({ action: "drive", cardId: "abc123", item: 1 }, deps, "Mel");
    expect(deps.driveUpload).toHaveBeenCalledWith("d_cl", "creas", expect.objectContaining({ mimeType: "image/png" }));
    expect((store.cards[0] as typeof creas).items[1].link).toBe("https://drive.google.com/file/d/xyz");
    expect(r.say).toContain("Drive");
    const again = await runMoAct({ action: "drive", cardId: "abc123", item: 1 }, deps, "Mel");
    expect(again.say).toContain("déjà");
    expect(deps.driveUpload).toHaveBeenCalledTimes(1);
  });
  it("looks up a brand's ads and tags the posted card with the client", async () => {
    const { deps, store } = fakeDeps([creas, { id: "cmp1", type: "creatives", title: "Pubs La Fourche en ce moment", x: 0, y: 0, w: 1, turn: 0, at, items: [] }]);
    const r = await runMoAct({ action: "competitor_ads", query: "La Fourche", clientId: "d_nat" }, deps, "Mel");
    expect(r.cardIds).toEqual(["cmp1"]);
    expect(store.cards[1].clientId).toBe("d_nat");
    expect(r.say).toContain("3 pubs");
  });
});

describe("Mo act — publication (prepare, confirm)", () => {
  it("prepares with the only live ad set, puts the « À publier » card beside the visual, nothing sent", async () => {
    const { deps, store } = fakeDeps([creas], { metaPublishAd: vi.fn(async () => prepared("act_1") as unknown as Record<string, unknown>) });
    const r = await runMoAct({ action: "publish_prepare", cardId: "abc123", item: 1 }, deps, "Mel");
    expect(deps.metaTargets).toHaveBeenCalledWith({ client: "d_cl" });
    expect(deps.metaPublishAd).toHaveBeenCalledTimes(1);
    expect(deps.metaPublishAd).toHaveBeenCalledWith(expect.objectContaining({ client: "d_cl", assetId: "ckasset0000000001", adsetId: "12345678" }));
    expect((deps.metaPublishAd as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty("confirm");
    expect(r.card).toMatchObject({ type: "action", kind: "publish", status: "to_confirm", actionId: "act_1", x: 100 + 660 + 40, y: 200, ref: "abc123" });
    expect(store.journal[0].kind).toBe("publish_prepare");
  });
  it("asks which ad set when several are live, and refuses a warehouse ad", async () => {
    const { deps } = fakeDeps([creas], { metaTargets: vi.fn(async () => ({ targets: [{ adsetId: "11111111", adset: "A", campaign: "C", spend_30d: 10, status: "ACTIVE" }, { adsetId: "22222222", adset: "B", campaign: "C", spend_30d: 5, status: "PAUSED" }] })) });
    const r = await runMoAct({ action: "publish_prepare", cardId: "abc123", item: 1 }, deps, "Mel");
    expect(r.needs?.adset.map((t) => t.adsetId)).toEqual(["11111111", "22222222"]);
    expect(deps.metaPublishAd).not.toHaveBeenCalled();
    await expect(runMoAct({ action: "publish_prepare", cardId: "abc123", item: 0 }, deps, "Mel")).rejects.toThrow(/annonce déjà diffusée/);
  });
  it("confirms: the ad is created PAUSED (executeAction mocked behind meta_publish_ad confirm), the card says so", async () => {
    const publish = vi.fn(async (args: Record<string, unknown>) => (args.confirm ? { status: "done", adId: "9876543210", paused: true, pilotage: "/pilotage?dashboardId=d_cl" } : prepared("act_1") as unknown as Record<string, unknown>));
    const { deps, store } = fakeDeps([creas], { metaPublishAd: publish });
    const prep = await runMoAct({ action: "publish_prepare", cardId: "abc123", item: 1, adsetId: "12345678" }, deps, "Mel");
    const cardId = prep.card!.id;
    const r = await runMoAct({ action: "publish_confirm", cardId }, deps, "Mel");
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ confirm: true, actionId: "act_1", client: "d_cl" }));
    const card = store.cards.find((c) => c.id === cardId) as Extract<MoCard, { type: "action" }>;
    expect(card).toMatchObject({ status: "sent", adId: "9876543210" });
    expect(r.say).toMatch(/en pause/);
    expect(store.journal.at(-1)).toMatchObject({ kind: "publish_confirm" });
    expect(store.journal.at(-1)!.label).toContain("EN PAUSE");
    await expect(runMoAct({ action: "publish_confirm", cardId }, deps, "Mel")).rejects.toThrow(/déjà partie/);
  });
  it("edited texts are prepared again before the send; a refused send leaves the card « failed » with the reason", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const publish = vi.fn(async (args: Record<string, unknown>) => { calls.push(args); if (args.confirm) throw new Error("Les écritures Meta ne sont pas ouvertes sur cette application (PILOT_WRITES)."); return prepared(`act_${calls.length}`) as unknown as Record<string, unknown>; });
    const { deps, store } = fakeDeps([creas], { metaPublishAd: publish });
    const prep = await runMoAct({ action: "publish_prepare", cardId: "abc123", item: 1, adsetId: "12345678" }, deps, "Mel");
    const cardId = prep.card!.id;
    await expect(runMoAct({ action: "publish_confirm", cardId, primaryText: "Nouveau texte", linkUrl: "https://cours.fr/promo" }, deps, "Mel")).rejects.toThrow(/PILOT_WRITES/);
    // 1 = prepare, 2 = re-prepare with the new texts, 3 = confirm with the new actionId.
    expect(calls).toHaveLength(3);
    expect(calls[1]).toMatchObject({ primaryText: "Nouveau texte", linkUrl: "https://cours.fr/promo", adsetId: "12345678", pageId: "99999999" });
    expect(calls[2]).toMatchObject({ confirm: true, actionId: "act_2" });
    const card = store.cards.find((c) => c.id === cardId) as Extract<MoCard, { type: "action" }>;
    expect(card).toMatchObject({ status: "failed", actionId: "act_2", primaryText: "Nouveau texte", linkUrl: "https://cours.fr/promo" });
    expect(card.error).toMatch(/PILOT_WRITES/);
    expect(store.journal.at(-1)!.label).toContain("échec");
  });
});

describe("Mo act — dropped files", () => {
  const png = { action: "upload" as const, name: "visuel-DA.png", mime: "image/png", bytes: 3, data: "data:image/png;base64,cG5n", x: 150, y: 250 };
  it("a visual dropped on a client's card: asset of the client, Drive « Créas », a file card where it was dropped", async () => {
    const { deps, store } = fakeDeps([creas]);
    const r = await runMoAct(png, deps, "Mel");
    expect(deps.createAsset).toHaveBeenCalledWith({ clientId: "ac_cl", image: png.data, name: "visuel-DA" });
    expect(deps.driveUpload).toHaveBeenCalledWith("d_cl", "creas", expect.objectContaining({ name: "visuel-DA.png", mimeType: "image/png" }));
    expect(r.card).toMatchObject({ type: "file", name: "visuel-DA.png", assetId: "ckasset0000000009", image: "/api/studio/assets/ckasset0000000009/file?inline=1", link: "https://drive.google.com/file/d/xyz", folder: "creas", clientId: "d_cl", x: 150, y: 250 });
    expect(store.journal[0].kind).toBe("upload");
  });
  it("a brief goes to Drive « Briefs »; no client → 428 so the browser asks", async () => {
    const { deps } = fakeDeps([creas]);
    const r = await runMoAct({ action: "upload", name: "brief.pdf", mime: "application/pdf", bytes: 3, data: "cGRm", x: 150, y: 250, clientId: "d_nat" }, deps, "Mel");
    expect(deps.driveUpload).toHaveBeenCalledWith("d_nat", "briefs", expect.objectContaining({ name: "brief.pdf", mimeType: "application/pdf" }));
    expect(deps.createAsset).not.toHaveBeenCalled();
    expect(r.card).toMatchObject({ type: "file", folder: "briefs", link: "https://drive.google.com/file/d/xyz" });
    const empty = fakeDeps([]);
    await expect(runMoAct(png, empty.deps, "Mel")).rejects.toMatchObject({ status: 428 });
    await expect(runMoAct({ ...png, clientId: "ac_nodash" }, empty.deps, "Mel")).resolves.toMatchObject({ say: expect.stringContaining("Drive : client sans dossier Drive") });
  });
});
