import { describe, it, expect } from "vitest";
import { describeOperation, inverseRequest, newAdLabel, prepareOperation, readNewAd, readRequest, type PilotObjectState } from "@/lib/pilot/ops";
import { adSpecFromLegacy, adSpecMedia, carouselCardsError, metaAdSpecError, readAdSpec, type AdSpec, type CarouselCard } from "@/lib/pilot/ad-spec";
import { extractPilotProposals } from "@/lib/pilot/assistant";

const adset: PilotObjectState = { id: "120200000000001", type: "adset", accountId: "1668772300254268", name: "IA - Broad", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudget: 1000, lifetimeBudget: null, endTime: null, bidAmount: null, parentName: "Campagne A" };
/** The first shape (still produced by Mo). */
const legacy = { name: "Gourde plage", primaryText: "Fraîcheur garantie tout l'été", linkUrl: "https://naturalia.fr/gourde", imageUrl: "https://platform-outputs.agnes-ai.space/images/x.png", pageId: "123456789", callToAction: "SHOP_NOW" };
const video: AdSpec = {
  v: 2, platform: "meta", format: "video", name: "Gourde plage (vidéo)", linkUrl: "https://naturalia.fr/gourde", callToAction: "SHOP_NOW",
  texts: { primary: ["Fraîcheur garantie tout l'été"], headline: ["Nouveau"], description: [] },
  media: [{ kind: "video", url: "https://app.example.org/api/studio/media/video_abc123.mp4?exp=1&sig=0", studioAssetId: "asset1", thumbUrl: "https://app.example.org/api/studio/media/img_abc123.png?exp=1&sig=0" }],
  identity: { pageId: "123456789" },
};

const card = (n: number, extra: Partial<CarouselCard> = {}): CarouselCard => ({ media: { kind: "image", url: `https://cdn.example.org/${n}.jpg` }, link: `https://naturalia.fr/p/${n}`, headline: `Carte ${n}`, description: "Bio", ...extra });
const carousel: AdSpec = {
  v: 2, platform: "meta", format: "carousel", name: "Gourdes (carrousel)", linkUrl: "https://naturalia.fr/gourdes", callToAction: "SHOP_NOW",
  texts: { primary: ["Trois gourdes, trois tailles"], headline: [], description: [] },
  media: [],
  cards: [card(1), card(2), { media: { kind: "video", url: "https://app.example.org/api/studio/media/video_abc.mp4?exp=1&sig=0", studioAssetId: "vid1", thumbUrl: "https://app.example.org/api/studio/media/img_abc.png?exp=1&sig=0" }, link: "https://naturalia.fr/p/3", headline: "En vidéo" }],
  options: { multiShareOptimized: false, endCard: true },
  identity: { pageId: "123456789" },
};
const withCards = (cards: unknown[]) => readAdSpec({ ...carousel, cards } as unknown as Record<string, unknown>);

describe("Pilotage — nouvelle publicité Meta (AdSpec v2 et première forme)", () => {
  it("lit la première forme (image) comme un AdSpec v2 et refuse ce qui manque", () => {
    const read = readNewAd(JSON.stringify(legacy));
    expect(read).toMatchObject({ ok: true, spec: { v: 2, format: "image", name: "Gourde plage", identity: { pageId: "123456789" }, texts: { primary: ["Fraîcheur garantie tout l'été"] } } });
    if (read.ok) expect(read.spec.media).toEqual([{ kind: "image", url: legacy.imageUrl }]);
    expect(readNewAd(JSON.stringify({ ...legacy, linkUrl: "http://x.fr" }))).toMatchObject({ ok: false });
    expect(readNewAd(JSON.stringify({ ...legacy, imageUrl: "" }))).toMatchObject({ ok: false, error: "Choisissez une image (Studio créa ou image envoyée)." });
    expect(readNewAd(JSON.stringify({ ...legacy, pageId: "" }))).toMatchObject({ ok: false, error: "Choisissez la Page Facebook de la publicité." });
    expect(readNewAd("pas du json")).toMatchObject({ ok: false });
    expect(adSpecFromLegacy({ ...legacy, studioAssetId: "a1", campaignId: "987654321" })).toMatchObject({ ok: true, spec: { campaignId: "987654321", media: [{ studioAssetId: "a1" }] } });
  });

  it("lit un AdSpec v2 vidéo, garde la vignette et l'identifiant Meta, refuse un format fermé", () => {
    const read = readNewAd(JSON.stringify({ ...video, mediaId: "pm_1", media: [{ ...video.media[0], remoteId: "1234567890123" }] }));
    expect(read).toMatchObject({ ok: true, spec: { format: "video", mediaId: "pm_1", media: [{ kind: "video", remoteId: "1234567890123", thumbUrl: video.media[0].thumbUrl, studioAssetId: "asset1" }] } });
    expect(readAdSpec({ ...video, format: "dynamic" } as unknown as Record<string, unknown>)).toMatchObject({ ok: false, error: /dynamique/ });
    // A video spec switched to carousel has no cards: refused by the card count, not by the format.
    expect(readAdSpec({ ...video, format: "carousel" } as unknown as Record<string, unknown>)).toMatchObject({ ok: false, error: /2 cartes au moins/ });
    expect(readAdSpec({ ...video, v: 3 } as unknown as Record<string, unknown>)).toMatchObject({ ok: false });
    expect(readAdSpec({ ...video, media: [] } as unknown as Record<string, unknown>)).toMatchObject({ ok: false, error: /Choisissez une vidéo/ });
    // Several texts are not an image/video ad.
    expect(readAdSpec({ ...video, texts: { primary: ["a", "b"] } } as unknown as Record<string, unknown>)).toMatchObject({ ok: true, spec: { texts: { primary: ["a"] } } });
  });

  it("règles Meta vidéo : mp4 ou vidéo du Studio, vignette obligatoire, liens publics", () => {
    expect(metaAdSpecError(video)).toBeNull();
    expect(metaAdSpecError({ ...video, media: [{ ...video.media[0], thumbUrl: undefined }] })).toMatch(/vignette/);
    expect(metaAdSpecError({ ...video, media: [{ kind: "video", url: "https://cdn.example.org/page.html", thumbUrl: video.media[0].thumbUrl }] })).toMatch(/mp4/);
    expect(metaAdSpecError({ ...video, media: [{ kind: "video", url: "https://cdn.example.org/clip.MP4?x=1", thumbUrl: video.media[0].thumbUrl }] })).toBeNull();
    expect(metaAdSpecError({ ...video, media: [{ ...video.media[0], thumbUrl: "https://192.168.1.4/t.png" }] })).toMatch(/Vignette refusée/);
    expect(metaAdSpecError({ ...video, media: [{ ...video.media[0], kind: "image" }] })).toMatch(/ne correspond pas/);
    expect(metaAdSpecError({ ...video, callToAction: "LIKE_PAGE" })).toMatch(/Bouton d'action inconnu/);
    expect(metaAdSpecError({ ...video, linkUrl: "https://intranet.local/x" })).toMatch(/Lien refusé/);
    expect(metaAdSpecError({ ...video, texts: { ...video.texts, headline: ["x".repeat(256)] } })).toMatch(/Titre trop long/);
    const image = adSpecFromLegacy(legacy);
    expect(image.ok && metaAdSpecError(image.spec)).toBeNull();
  });

  it("une opération sur un ensemble Meta, sans seconde confirmation (créée en pause), jamais sur Google ni une campagne", () => {
    const req = readRequest({ kind: "create_ad", objectType: "adset", objectId: adset.id, value: JSON.stringify(legacy) })!;
    const p = prepareOperation(req, adset, "EUR", new Date(), "meta");
    expect(p).toMatchObject({ ok: true, op: { field: "new_ad", before: null, double: null, irreversible: false } });
    expect(prepareOperation(req, adset, "EUR", new Date(), "google").ok).toBe(false);
    expect(prepareOperation({ ...req, objectType: "campaign" }, { ...adset, type: "campaign" }, "EUR").ok).toBe(false);
    if (!p.ok) return;
    expect(describeOperation(p.op, "EUR")).toBe("🆕 Ensemble de publicités « IA - Broad » (Campagne A) — nouvelle publicité « Gourde plage » (créée en pause)");
    expect(inverseRequest(p.op, "EUR")).toBeNull();
  });

  it("une vidéo se décrit « nouvelle publicité vidéo » dans l'aperçu, le journal et HQ", () => {
    const req = readRequest({ kind: "create_ad", objectType: "adset", objectId: adset.id, value: JSON.stringify(video) })!;
    const p = prepareOperation(req, adset, "EUR", new Date(), "meta");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(newAdLabel(p.op.after)).toBe("nouvelle publicité vidéo");
    expect(describeOperation(p.op, "EUR")).toBe("🆕 Ensemble de publicités « IA - Broad » (Campagne A) — nouvelle publicité vidéo « Gourde plage (vidéo) » (créée en pause)");
  });

  it("l'IA ne peut pas proposer de création", () => {
    const text = '```pilot\n{"platform":"meta","accountId":"1","requests":[{"kind":"create_ad","objectType":"adset","objectId":"120200000000001","value":"{}"}]}\n```';
    expect(extractPilotProposals(text)[0]).toMatchObject({ ok: false });
  });

  it("lit un carrousel v2 : cartes dans l'ordre, options, média de chaque carte ; 1 carte et 11 cartes refusées", () => {
    const read = readAdSpec(carousel as unknown as Record<string, unknown>);
    expect(read).toMatchObject({ ok: true, spec: { format: "carousel", media: [], options: { multiShareOptimized: false, endCard: true }, cards: [{ headline: "Carte 1" }, { headline: "Carte 2" }, { media: { kind: "video", studioAssetId: "vid1" }, headline: "En vidéo" }] } });
    if (read.ok) {
      expect(adSpecMedia(read.spec).map((m) => m.kind)).toEqual(["image", "image", "video"]);
      expect(metaAdSpecError(read.spec)).toBeNull();
    }
    // Options absent: Meta's defaults (order kept, end card shown); a video card keeps its PilotMedia id.
    expect(readAdSpec({ ...carousel, options: undefined, cards: [card(1), { ...carousel.cards![2], media: { ...carousel.cards![2].media, mediaId: "pm_9", remoteId: "1234567890123" } }] } as unknown as Record<string, unknown>))
      .toMatchObject({ ok: true, spec: { options: { multiShareOptimized: false, endCard: true }, cards: [{}, { media: { mediaId: "pm_9", remoteId: "1234567890123" } }] } });
    expect(withCards([card(1)])).toMatchObject({ ok: false, error: "Un carrousel compte 2 cartes au moins (10 au plus)." });
    expect(withCards([])).toMatchObject({ ok: false, error: /2 cartes au moins/ });
    expect(withCards(Array.from({ length: 11 }, (_, i) => card(i + 1)))).toMatchObject({ ok: false, error: "Un carrousel compte 10 cartes au plus." });
    expect(withCards(Array.from({ length: 10 }, (_, i) => card(i + 1)))).toMatchObject({ ok: true });
    // A card without media is not a card.
    expect(withCards([card(1), { link: "https://naturalia.fr/p/2" }])).toMatchObject({ ok: false, error: /2 cartes au moins/ });
  });

  it("règles Meta carrousel : liens https par carte, vignette des vidéos, titres ≤ 35 et distincts, lien « voir plus » obligatoire", () => {
    expect(carouselCardsError(carousel.cards!)).toBeNull();
    expect(carouselCardsError([card(1), card(2, { headline: "carte 1" })])).toBe("Deux cartes portent le même titre « carte 1 » : donnez-leur des titres différents.");
    expect(carouselCardsError([card(1, { headline: undefined }), card(2, { headline: undefined })])).toBeNull();
    expect(carouselCardsError([card(1), card(2, { link: "" })])).toBe("Carte 2 : donnez-lui un lien (https://).");
    expect(carouselCardsError([card(1), card(2, { link: "http://naturalia.fr/p/2" })])).toMatch(/Carte 2 : lien refusé/);
    expect(carouselCardsError([card(1), card(2, { media: { kind: "image", url: "https://192.168.0.9/x.jpg" } })])).toMatch(/Carte 2 : image refusée/);
    expect(carouselCardsError([card(1), card(2, { media: { kind: "video", url: "https://cdn.example.org/clip.mp4" } })])).toMatch(/Carte 2 : choisissez une vignette/);
    expect(carouselCardsError([card(1), card(2, { media: { kind: "video", url: "https://cdn.example.org/page.html", thumbUrl: "https://cdn.example.org/t.jpg" } })])).toMatch(/Carte 2 : l'adresse doit être celle d'un fichier mp4/);
    expect(carouselCardsError([card(1), card(2, { headline: "x".repeat(36) })])).toBe("Carte 2 : titre trop long (35 caractères au plus).");
    expect(carouselCardsError([card(1), card(2, { description: "x".repeat(31) })])).toBe("Carte 2 : description trop longue (30 caractères au plus).");
    expect(carouselCardsError([card(1), card(2, { callToAction: "FLY" })])).toBe("Carte 2 : bouton d'action inconnu.");
    expect(metaAdSpecError({ ...carousel, linkUrl: "" })).toMatch(/lien de la publicité doit commencer par https/);
    expect(metaAdSpecError({ ...carousel, linkUrl: "https://intranet.local/x" })).toMatch(/Lien « voir plus » refusé/);
    expect(metaAdSpecError({ ...carousel, texts: { primary: ["a", "b"], headline: [], description: [] } })).toMatch(/un seul texte principal/);
    expect(metaAdSpecError({ ...carousel, cards: [card(1)] })).toMatch(/2 cartes au moins/);
  });

  it("un carrousel se décrit « nouvelle publicité carrousel (3 cartes) » dans l'aperçu, le journal et HQ", () => {
    const req = readRequest({ kind: "create_ad", objectType: "adset", objectId: adset.id, value: JSON.stringify(carousel) })!;
    const p = prepareOperation(req, adset, "EUR", new Date(), "meta");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(newAdLabel(p.op.after)).toBe("nouvelle publicité carrousel (3 cartes)");
    expect(describeOperation(p.op, "EUR")).toBe("🆕 Ensemble de publicités « IA - Broad » (Campagne A) — nouvelle publicité carrousel (3 cartes) « Gourdes (carrousel) » (créée en pause)");
    expect(inverseRequest(p.op, "EUR")).toBeNull();
  });
});
