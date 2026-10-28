/**
 * Pilotage — what a new ad is made of (AdSpec v2), on every platform and in
 * every format, and the pure rules each format must meet before anything is
 * asked to a platform.
 *
 * Stored as JSON in the « new_ad » operation (PilotOperation.afterJson). A
 * JSON without `v` is the first shape (NewAdSpec: one Meta image ad, flat
 * fields, still produced by Mo): readNewAd (lib/pilot/ops.ts) turns it into an
 * AdSpec, so drafts, the journal, HQ and the undo read one model.
 *
 * Lot 1: Meta image and video. Lot 2: Meta carousel (2 to 10 cards, each an
 * image or a video with its thumbnail, its own link, headline, description and
 * button; the « see more » link is the spec's linkUrl). Lot 4: Meta dynamic
 * creative (asset_feed_spec): up to 10 images and 10 videos in `media`, up to
 * 5 primary texts / headlines / descriptions in `texts`, up to 5 buttons in
 * `callToActions`, ONE link; Meta assembles the combinations. Only an ad set
 * created in dynamic creative and still empty takes it (checked on Meta by
 * lib/pilot/new-ad.ts, not here).
 *
 * Pure: no network, no database.
 */

import { CALL_TO_ACTIONS, DYNAMIC_LIMITS, MAX_AD_NAME_CHARS, MAX_HEADLINE_CHARS, MAX_PRIMARY_TEXT_CHARS, publicHttpsUrlError } from "@/lib/meta-write";

export { DYNAMIC_LIMITS };

export const AD_FORMATS = ["image", "video", "carousel", "dynamic"] as const;
export type AdFormat = (typeof AD_FORMATS)[number];
/** Formats a platform takes from here today. */
export const META_FORMATS_OPEN: ReadonlySet<AdFormat> = new Set<AdFormat>(["image", "video", "carousel", "dynamic"]);
export const FORMAT_FR: Record<AdFormat, string> = { image: "image", video: "vidéo", carousel: "carrousel", dynamic: "dynamique" };

export interface MediaRef {
  kind: "image" | "video";
  /** Public https address the platform downloads the file from (a signed relay link for a Studio asset). */
  url: string;
  /** The Studio asset (CreativeAsset.id) the file comes from, when it does: the server mints a fresh link from it. */
  studioAssetId?: string;
  /** The platform's id of the media once uploaded (Meta video_id; the image hash of a dynamic creative). Set by the server. */
  remoteId?: string;
  /** Video: its thumbnail (public https), mandatory on Meta. */
  thumbUrl?: string;
  /** Video: the Studio image the thumbnail comes from (the source image of the Studio video, or one chosen). */
  thumbStudioAssetId?: string;
  /** Video of a carousel card or of a dynamic creative: the PilotMedia row following its upload (an image or video ad keeps it on the spec, `mediaId`). Set by the server. */
  mediaId?: string;
}

/** Carousel: 2 to 10 cards (3 or more advised), in the order shown unless Meta is let to optimise it. */
export const CAROUSEL_CARDS = { min: 2, max: 10 } as const;
/** Meta cuts longer card texts on most placements: refused here rather than truncated there. */
export const CAROUSEL_HEADLINE_MAX = 35;
export const CAROUSEL_DESCRIPTION_MAX = 30;

export interface CarouselCard {
  /** An image, or a video with its thumbnail (the card's picture). */
  media: MediaRef;
  /** Where the card leads (https). */
  link: string;
  /** Card title (child_attachments[].name), ≈ 35 characters. */
  headline?: string;
  /** Card description (child_attachments[].description), ≈ 30 characters. */
  description?: string;
  /** Card button; the ad's button when absent. */
  callToAction?: string;
}

export interface CarouselOptions {
  /** true = Meta shows the best-performing cards first; false (default) = the order given is kept. */
  multiShareOptimized: boolean;
  /** The end card with the Page's picture and the « see more » link (Meta's default: shown). */
  endCard: boolean;
}

export interface AdSpec {
  v: 2;
  platform: "meta";
  format: AdFormat;
  name: string;
  /** The one link of the ad (a dynamic creative has exactly one too). */
  linkUrl: string;
  callToAction?: string;
  /** Dynamic: the buttons Meta may pick (0 to 5); `callToAction` is unused then. */
  callToActions?: string[];
  /** One value each for image, video and carousel; 1 to 5 primary texts, 0 to 5 headlines and descriptions for dynamic. */
  texts: { primary: string[]; headline: string[]; description: string[] };
  /** One media for image and video; empty for a carousel (the cards carry theirs); up to 10 images and 10 videos for dynamic. */
  media: MediaRef[];
  /** Carousel: its cards, in order. */
  cards?: CarouselCard[];
  /** Carousel: order and end card. */
  options?: CarouselOptions;
  identity: { pageId: string; instagramUserId?: string };
  /** Set by the server at the preview: the campaign of the ad set. */
  campaignId?: string;
  /** Set by the server: the PilotMedia row following the upload of the video (image/video ad; a carousel keeps one per video card, MediaRef.mediaId). */
  mediaId?: string;
}

/** The first shape (one Meta image ad), still produced by Mo and kept readable. */
export interface NewAdSpec {
  name: string;
  primaryText: string;
  headline?: string;
  description?: string;
  linkUrl: string;
  callToAction?: string;
  /** Public https URL Meta downloads the image from. */
  imageUrl: string;
  pageId: string;
  instagramUserId?: string;
  studioAssetId?: string;
  campaignId?: string;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+$/, "").slice(0, max) : "");
const list = (v: unknown, max: number, each: number): string[] =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map((x) => str(x, each).trim()).filter(Boolean).slice(0, max);
const id = (v: unknown) => str(v, 30).trim();
const isMetaId = (v: string) => /^\d{5,25}$/.test(v);
export const httpsOk = (v: string) => /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$|\?)/i.test(v);
/** A video file as Meta reads it: mp4 (or mov) by its path, whatever the query string. */
export const looksLikeVideoUrl = (v: string) => { try { return /\.(mp4|mov|m4v)$/i.test(new URL(v).pathname); } catch { return false; } };

type Read = { ok: true; spec: AdSpec } | { ok: false; error: string };

function readMedia(raw: unknown, kind: "image" | "video"): MediaRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const url = str(r.url, 2000).trim();
  if (!url) return null;
  const media: MediaRef = { kind, url };
  const asset = str(r.studioAssetId, 40).trim();
  if (asset) media.studioAssetId = asset;
  // A Meta id (digits) or the hash of an image (32 hexadecimal characters).
  const remote = str(r.remoteId, 40).trim();
  if (/^[a-z0-9]{5,40}$/i.test(remote)) media.remoteId = remote;
  const thumb = str(r.thumbUrl, 2000).trim();
  if (thumb) media.thumbUrl = thumb;
  const thumbAsset = str(r.thumbStudioAssetId, 40).trim();
  if (thumbAsset) media.thumbStudioAssetId = thumbAsset;
  const mediaId = str(r.mediaId, 40).trim();
  if (mediaId) media.mediaId = mediaId;
  return media;
}

/** A card of a carousel from a parsed JSON object; null when it has no media. The media kind is the card's own (image unless said video). */
function readCard(raw: unknown): CarouselCard | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const m = r.media && typeof r.media === "object" ? (r.media as Record<string, unknown>) : null;
  const media = readMedia(m, m?.kind === "video" ? "video" : "image");
  if (!media) return null;
  const card: CarouselCard = { media, link: str(r.link, 2000).trim() };
  const headline = str(r.headline, CAROUSEL_HEADLINE_MAX + 20).trim();
  if (headline) card.headline = headline;
  const description = str(r.description, CAROUSEL_DESCRIPTION_MAX + 20).trim();
  if (description) card.description = description;
  const cta = str(r.callToAction, 40).trim();
  if (cta) card.callToAction = cta;
  return card;
}

/** The order and end-card options of a carousel; Meta's defaults when absent (order kept, end card shown). */
function readOptions(raw: unknown): CarouselOptions {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { multiShareOptimized: r.multiShareOptimized === true, endCard: r.endCard !== false };
}

/** The media of an ad, whatever its format: the one of an image or video ad, those of the cards of a carousel (in order). */
export const adSpecMedia = (spec: AdSpec): MediaRef[] => (spec.format === "carousel" ? (spec.cards ?? []).map((c) => c.media) : spec.media);

/** Reads an AdSpec v2 from a parsed JSON object; the reason in French when it is not one. */
export function readAdSpec(raw: Record<string, unknown>): Read {
  if (raw.v !== 2) return { ok: false, error: "Publicité illisible (version inconnue)." };
  if (raw.platform !== undefined && raw.platform !== "meta") return { ok: false, error: "Seule la création Meta est ouverte pour le moment." };
  const format = str(raw.format, 20).trim() as AdFormat;
  if (!AD_FORMATS.includes(format)) return { ok: false, error: "Format de publicité inconnu (image ou vidéo)." };
  if (!META_FORMATS_OPEN.has(format)) return { ok: false, error: `Le format ${FORMAT_FR[format]} n'est pas encore ouvert : image ou vidéo.` };
  const texts = raw.texts && typeof raw.texts === "object" ? (raw.texts as Record<string, unknown>) : {};
  const identity = raw.identity && typeof raw.identity === "object" ? (raw.identity as Record<string, unknown>) : {};
  const dynamic = format === "dynamic";
  const mediaKind = format === "video" ? "video" : "image";
  const rawMedia = Array.isArray(raw.media) ? raw.media : [];
  // Dynamic: each media is of its own kind; one beyond the maximum is kept so that « 11 images » is refused by name, not silently cut.
  const media = format === "carousel" ? []
    : dynamic ? rawMedia.map((m) => readMedia(m, m && typeof m === "object" && (m as Record<string, unknown>).kind === "video" ? "video" : "image")).filter((m): m is MediaRef => !!m).slice(0, DYNAMIC_LIMITS.images + DYNAMIC_LIMITS.videos + 1)
    : rawMedia.map((m) => readMedia(m, mediaKind)).filter((m): m is MediaRef => !!m).slice(0, 1);
  const textMax = dynamic ? DYNAMIC_LIMITS.bodies + 1 : 1;
  const ctas = dynamic ? list(raw.callToActions, DYNAMIC_LIMITS.callToActions + 1, 40) : [];
  // One card beyond the maximum is kept so that « 11 cards » is refused by name, not silently cut to 10.
  const cards = format === "carousel" ? (Array.isArray(raw.cards) ? raw.cards : []).map(readCard).filter((c): c is CarouselCard => !!c).slice(0, CAROUSEL_CARDS.max + 1) : undefined;
  const spec: AdSpec = {
    v: 2, platform: "meta", format,
    name: str(raw.name, MAX_AD_NAME_CHARS).trim(),
    linkUrl: str(raw.linkUrl, 2000).trim(),
    callToAction: dynamic ? ctas[0] : str(raw.callToAction, 40).trim() || undefined,
    ...(dynamic ? { callToActions: ctas } : {}),
    texts: { primary: list(texts.primary, textMax, MAX_PRIMARY_TEXT_CHARS), headline: list(texts.headline, textMax, MAX_HEADLINE_CHARS), description: list(texts.description, textMax, MAX_HEADLINE_CHARS) },
    media,
    ...(format === "carousel" ? { cards, options: readOptions(raw.options) } : {}),
    identity: { pageId: id(identity.pageId), instagramUserId: id(identity.instagramUserId) || undefined },
    campaignId: id(raw.campaignId) || undefined,
    mediaId: str(raw.mediaId, 40).trim() || undefined,
  };
  const bad = adSpecShapeError(spec);
  return bad ? { ok: false, error: bad } : { ok: true, spec };
}

/** The first shape → an AdSpec (Meta image). */
export function adSpecFromLegacy(raw: Record<string, unknown>): Read {
  const imageUrl = str(raw.imageUrl, 2000).trim();
  const spec: AdSpec = {
    v: 2, platform: "meta", format: "image",
    name: str(raw.name, MAX_AD_NAME_CHARS).trim(),
    linkUrl: str(raw.linkUrl, 2000).trim(),
    callToAction: str(raw.callToAction, 40).trim() || undefined,
    texts: { primary: list(raw.primaryText, 1, MAX_PRIMARY_TEXT_CHARS), headline: list(raw.headline, 1, MAX_HEADLINE_CHARS), description: list(raw.description, 1, MAX_HEADLINE_CHARS) },
    media: imageUrl ? [{ kind: "image", url: imageUrl, ...(str(raw.studioAssetId, 40).trim() ? { studioAssetId: str(raw.studioAssetId, 40).trim() } : {}) }] : [],
    identity: { pageId: id(raw.pageId), instagramUserId: id(raw.instagramUserId) || undefined },
    campaignId: id(raw.campaignId) || undefined,
  };
  const bad = adSpecShapeError(spec);
  return bad ? { ok: false, error: bad } : { ok: true, spec };
}

/** What the form must have filled, said to the person; null when complete. */
function adSpecShapeError(spec: AdSpec): string | null {
  if (!spec.name) return "Donnez un nom à la publicité.";
  if (!spec.texts.primary[0]) return "Le texte principal de la publicité est vide.";
  if (!httpsOk(spec.linkUrl)) return "Le lien de la publicité doit commencer par https://.";
  const media = spec.media[0];
  if (spec.format === "image" && (!media || !httpsOk(media.url))) return "Choisissez une image (Studio créa ou image envoyée).";
  if (spec.format === "video" && (!media || !httpsOk(media.url))) return "Choisissez une vidéo (Studio créa ou adresse https d'un mp4).";
  if (spec.format === "carousel") {
    const cards = spec.cards ?? [];
    if (cards.length < CAROUSEL_CARDS.min) return `Un carrousel compte ${CAROUSEL_CARDS.min} cartes au moins (${CAROUSEL_CARDS.max} au plus).`;
    if (cards.length > CAROUSEL_CARDS.max) return `Un carrousel compte ${CAROUSEL_CARDS.max} cartes au plus.`;
  }
  if (spec.format === "dynamic" && !spec.media.some((m) => httpsOk(m.url))) return "Choisissez au moins une image ou une vidéo pour la publicité dynamique.";
  if (!isMetaId(spec.identity.pageId)) return "Choisissez la Page Facebook de la publicité.";
  if (spec.identity.instagramUserId && !isMetaId(spec.identity.instagramUserId)) return "Compte Instagram invalide.";
  return null;
}

/**
 * The rules of the format on Meta, checked before the preview and again
 * before the send. Null when the spec can be sent, the reason otherwise.
 *
 *   image  texts 255 / 2000 / 255, public https links (image and landing)
 *   video  an mp4 by its address (or a Studio video), a thumbnail (image_url
 *          is mandatory in practice), same texts (the LIKE_PAGE button, which
 *          refuses a title and a description, is not offered here)
 *   carousel  one primary text, a public « see more » link, 2 to 10 cards
 *          (carouselCardsError); 1:1 images ≥ 458 px advised, checked by Meta
 *   dynamic  dynamicSpecError: ≤ 10 images, ≤ 10 videos (each with its
 *          thumbnail), 1–5 texts, ≤ 5 titles and descriptions, ≤ 5 distinct
 *          buttons, one link; no customization rules
 * Ratio and width (16:9 to 9:16, ≥ 1200 px advised) need the file: Meta checks them.
 */
export function metaAdSpecError(spec: AdSpec): string | null {
  const shape = adSpecShapeError(spec);
  if (shape) return shape;
  if (spec.platform !== "meta") return "Seule la création Meta est ouverte pour le moment.";
  if (!META_FORMATS_OPEN.has(spec.format)) return `Le format ${FORMAT_FR[spec.format]} n'est pas encore ouvert.`;
  if (spec.name.length > MAX_AD_NAME_CHARS) return `Nom de publicité trop long (${MAX_AD_NAME_CHARS} caractères au plus).`;
  if (spec.format === "dynamic") return dynamicSpecError(spec);
  if (spec.texts.primary.length !== 1 || spec.texts.headline.length > 1 || spec.texts.description.length > 1) return spec.format === "carousel" ? "Un carrousel porte un seul texte principal (les titres et descriptions sont ceux des cartes)." : "Une publicité image ou vidéo porte un seul texte, un seul titre et une seule description.";
  if (spec.texts.primary[0].length > MAX_PRIMARY_TEXT_CHARS) return `Texte principal trop long (${MAX_PRIMARY_TEXT_CHARS} caractères au plus).`;
  if ((spec.texts.headline[0]?.length ?? 0) > MAX_HEADLINE_CHARS) return `Titre trop long (${MAX_HEADLINE_CHARS} caractères au plus).`;
  if ((spec.texts.description[0]?.length ?? 0) > MAX_HEADLINE_CHARS) return `Description trop longue (${MAX_HEADLINE_CHARS} caractères au plus).`;
  const link = publicHttpsUrlError(spec.linkUrl);
  if (link) return `Lien ${spec.format === "carousel" ? "« voir plus » " : ""}refusé : ${link}.`;
  if (spec.callToAction !== undefined && !(CALL_TO_ACTIONS as readonly string[]).includes(spec.callToAction)) return "Bouton d'action inconnu.";
  if (spec.format === "carousel") return carouselCardsError(spec.cards ?? []);
  if (spec.media.length !== 1) return "Une publicité image ou vidéo porte un seul média.";
  const media = spec.media[0];
  if (media.kind !== (spec.format === "video" ? "video" : "image")) return "Le média ne correspond pas au format de la publicité.";
  const url = publicHttpsUrlError(media.url);
  if (url) return `${spec.format === "video" ? "Vidéo" : "Image"} refusée : ${url}.`;
  if (spec.format === "video") {
    if (!media.studioAssetId && !looksLikeVideoUrl(media.url)) return "Vidéo refusée : l'adresse doit être celle d'un fichier mp4 (ou une vidéo du Studio).";
    if (!media.thumbUrl) return "Choisissez une vignette pour la vidéo (image du Studio ou image envoyée) : Meta l'exige.";
    const thumb = publicHttpsUrlError(media.thumbUrl);
    if (thumb) return `Vignette refusée : ${thumb}.`;
    // LIKE_PAGE (which refuses a title and a description on a video) is not among CALL_TO_ACTIONS: nothing to check.
  }
  return null;
}

/**
 * The cards of a carousel on Meta: 2 to 10; each with a public https link, a
 * public image (a video card: an mp4 or a Studio video, and its thumbnail as
 * the picture of the card), a title ≤ 35 and a description ≤ 30 characters,
 * a known button; two cards never bear the same title. Null when fine.
 */
export function carouselCardsError(cards: CarouselCard[]): string | null {
  if (cards.length < CAROUSEL_CARDS.min) return `Un carrousel compte ${CAROUSEL_CARDS.min} cartes au moins (${CAROUSEL_CARDS.max} au plus).`;
  if (cards.length > CAROUSEL_CARDS.max) return `Un carrousel compte ${CAROUSEL_CARDS.max} cartes au plus.`;
  const names = new Set<string>();
  for (const [i, card] of cards.entries()) {
    const n = i + 1;
    if (!card.link) return `Carte ${n} : donnez-lui un lien (https://).`;
    const link = publicHttpsUrlError(card.link);
    if (link) return `Carte ${n} : lien refusé : ${link}.`;
    if (card.media.kind !== "image" && card.media.kind !== "video") return `Carte ${n} : média inconnu.`;
    const url = publicHttpsUrlError(card.media.url);
    if (url) return `Carte ${n} : ${card.media.kind === "video" ? "vidéo" : "image"} refusée : ${url}.`;
    if (card.media.kind === "video") {
      if (!card.media.studioAssetId && !looksLikeVideoUrl(card.media.url)) return `Carte ${n} : l'adresse doit être celle d'un fichier mp4 (ou une vidéo du Studio).`;
      if (!card.media.thumbUrl) return `Carte ${n} : choisissez une vignette pour la vidéo (image du Studio ou image envoyée) : Meta l'exige.`;
      const thumb = publicHttpsUrlError(card.media.thumbUrl);
      if (thumb) return `Carte ${n} : vignette refusée : ${thumb}.`;
    }
    if ((card.headline?.length ?? 0) > CAROUSEL_HEADLINE_MAX) return `Carte ${n} : titre trop long (${CAROUSEL_HEADLINE_MAX} caractères au plus).`;
    if ((card.description?.length ?? 0) > CAROUSEL_DESCRIPTION_MAX) return `Carte ${n} : description trop longue (${CAROUSEL_DESCRIPTION_MAX} caractères au plus).`;
    if (card.callToAction !== undefined && !(CALL_TO_ACTIONS as readonly string[]).includes(card.callToAction)) return `Carte ${n} : bouton d'action inconnu.`;
    if (card.headline) {
      const key = card.headline.trim().toLowerCase();
      if (names.has(key)) return `Deux cartes portent le même titre « ${card.headline} » : donnez-leur des titres différents.`;
      names.add(key);
    }
  }
  return null;
}

/** A media of a dynamic creative (or of a video ad): public https; a video is an mp4 or a Studio video with a thumbnail. Null when fine. */
function mediaError(media: MediaRef, label: string): string | null {
  if (media.kind !== "image" && media.kind !== "video") return `${label} : média inconnu.`;
  const url = publicHttpsUrlError(media.url);
  if (url) return `${label} refusée : ${url}.`;
  if (media.kind === "video") {
    if (!media.studioAssetId && !looksLikeVideoUrl(media.url)) return `${label} : l'adresse doit être celle d'un fichier mp4 (ou une vidéo du Studio).`;
    if (!media.thumbUrl) return `${label} : choisissez une vignette (image du Studio ou image envoyée) : Meta l'exige.`;
    const thumb = publicHttpsUrlError(media.thumbUrl);
    if (thumb) return `${label} : vignette refusée : ${thumb}.`;
  }
  return null;
}

/** The images and the videos of a dynamic creative, apart. */
export const dynamicMedia = (spec: Pick<AdSpec, "media">) => ({ images: spec.media.filter((m) => m.kind === "image"), videos: spec.media.filter((m) => m.kind === "video") });

/** How many combinations Meta may assemble (visuals × texts × titles × descriptions × buttons, empty lists counting for one). */
export function dynamicCombinations(spec: Pick<AdSpec, "media" | "texts" | "callToActions">): number {
  const one = (n: number) => Math.max(1, n);
  return one(spec.media.length) * one(spec.texts.primary.length) * one(spec.texts.headline.length) * one(spec.texts.description.length) * one(spec.callToActions?.length ?? 0);
}

/**
 * The rules of a dynamic creative on Meta: at least one media, ≤ 10 images
 * and ≤ 10 videos (each public, a video with its thumbnail), 1 to 5 primary
 * texts, ≤ 5 headlines and descriptions (bounded as an image ad's), ≤ 5
 * distinct known buttons (NO_BUTTON has no place in a feed), one public link.
 * Null when fine.
 */
export function dynamicSpecError(spec: AdSpec): string | null {
  const { images, videos } = dynamicMedia(spec);
  if (!spec.media.length) return "Choisissez au moins une image ou une vidéo pour la publicité dynamique.";
  if (images.length > DYNAMIC_LIMITS.images) return `Une publicité dynamique porte ${DYNAMIC_LIMITS.images} images au plus.`;
  if (videos.length > DYNAMIC_LIMITS.videos) return `Une publicité dynamique porte ${DYNAMIC_LIMITS.videos} vidéos au plus.`;
  for (const [i, m] of images.entries()) { const bad = mediaError(m, `Image ${i + 1}`); if (bad) return bad; }
  for (const [i, m] of videos.entries()) { const bad = mediaError(m, `Vidéo ${i + 1}`); if (bad) return bad; }
  if (!spec.texts.primary.length) return "Écrivez au moins un texte principal.";
  if (spec.texts.primary.length > DYNAMIC_LIMITS.bodies) return `Une publicité dynamique porte ${DYNAMIC_LIMITS.bodies} textes principaux au plus.`;
  if (spec.texts.headline.length > DYNAMIC_LIMITS.titles) return `Une publicité dynamique porte ${DYNAMIC_LIMITS.titles} titres au plus.`;
  if (spec.texts.description.length > DYNAMIC_LIMITS.descriptions) return `Une publicité dynamique porte ${DYNAMIC_LIMITS.descriptions} descriptions au plus.`;
  for (const [label, values, max] of [["Texte principal", spec.texts.primary, MAX_PRIMARY_TEXT_CHARS], ["Titre", spec.texts.headline, MAX_HEADLINE_CHARS], ["Description", spec.texts.description, MAX_HEADLINE_CHARS]] as const) {
    for (const [i, v] of values.entries()) if (v.length > max) return `${label} ${i + 1} trop long${label === "Description" ? "ue" : ""} (${max} caractères au plus).`;
  }
  const link = publicHttpsUrlError(spec.linkUrl);
  if (link) return `Lien refusé : ${link}.`;
  const ctas = spec.callToActions ?? [];
  if (ctas.length > DYNAMIC_LIMITS.callToActions) return `Une publicité dynamique porte ${DYNAMIC_LIMITS.callToActions} boutons au plus.`;
  for (const cta of ctas) if (!(CALL_TO_ACTIONS as readonly string[]).includes(cta) || cta === "NO_BUTTON") return `Bouton d'action inconnu${cta === "NO_BUTTON" ? " : « sans bouton » n'a pas sa place dans une publicité dynamique" : ""}.`;
  if (new Set(ctas).size !== ctas.length) return "Deux boutons identiques : gardez-en un seul.";
  return null;
}

/** The texts of an image or video ad, one each. */
export const adTextsOf = (spec: AdSpec) => ({
  primaryText: spec.texts.primary[0] ?? "",
  headline: spec.texts.headline[0] || undefined,
  description: spec.texts.description[0] || undefined,
});
