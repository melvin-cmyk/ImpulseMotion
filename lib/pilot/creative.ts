/**
 * Pilotage — the texts of an ad, as Pilotage reads and rewrites them.
 *
 *   Meta       an ad shows a creative; a creative is never edited, so new texts
 *              mean a NEW creative (same Page, image or video, link) that the ad
 *              is switched to (kind "set_ad_texts", field "ad_texts"); the old
 *              creative stays, and putting it back is one write (kind
 *              "set_ad_creative", field "creative"). Only image (link_data) and
 *              video (video_data) ads: a carousel or a dynamic ad is edited in
 *              Ads Manager.
 *   Google Ads a responsive search ad is immutable: new headlines or descriptions
 *              mean a NEW ad in the ad group, the old one paused (kind
 *              "set_rsa_texts", field "rsa").
 *
 * Pure: no network, no database.
 */

// Self-contained (read by the page too): the same limits as lib/meta-write.ts, kept in step by its tests.
export const CALL_TO_ACTIONS = [
  "LEARN_MORE", "SHOP_NOW", "SIGN_UP", "SUBSCRIBE", "DOWNLOAD", "BOOK_NOW", "BOOK_TRAVEL", "CONTACT_US",
  "GET_OFFER", "GET_QUOTE", "APPLY_NOW", "ORDER_NOW", "BUY_NOW", "DONATE_NOW", "SEE_MORE", "WATCH_MORE", "NO_BUTTON",
] as const;
export const MAX_PRIMARY_TEXT_CHARS = 2000;
export const MAX_HEADLINE_CHARS = 255;

/** Null when the URL can be handed to a platform (public https host), the reason otherwise. */
export function publicHttpsUrlError(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "adresse vide";
  const raw = value.trim();
  if (raw.length > 2000 || /[\s\u0000-\u001f\\]/.test(raw)) return "adresse invalide";
  let url: URL;
  try { url = new URL(raw); } catch { return "adresse invalide"; }
  if (url.protocol !== "https:") return "seules les adresses https:// sont acceptées";
  if (url.username || url.password || (url.port && url.port !== "443")) return "adresse refusée";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || /\.(local|localhost|internal|lan|test|example|invalid|onion)$/.test(host)) return "nom d'hôte refusé";
  if (!/[a-z]/.test(host.split(".").pop() ?? "")) return "nom d'hôte invalide";
  return null;
}

// ── Meta ─────────────────────────────────────────────────────────────────

export interface MetaAdTexts {
  /** link (image) | video */
  kind: "link" | "video";
  primaryText: string;
  headline: string;
  description: string;
  linkUrl: string;
  callToAction: string;
}

/** What the current creative holds, with what is carried over unchanged to the new one. */
export interface MetaAdCreative extends MetaAdTexts {
  creativeId: string;
  creativeName: string;
  pageId: string;
  instagramUserId: string;
  /** link_data: image_hash or picture; video_data: video_id and its image. */
  imageHash: string;
  picture: string;
  videoId: string;
  videoImageUrl: string;
  videoImageHash: string;
}

type Story = { page_id?: string; instagram_user_id?: string; instagram_actor_id?: string; link_data?: Record<string, unknown>; video_data?: Record<string, unknown> };

const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/** The creative of an ad as Pilotage edits it; null when it is not an image or video ad with a link. */
export function readMetaCreative(creative: { id?: string; name?: string; object_story_spec?: Story } | null | undefined): MetaAdCreative | null {
  const story = creative?.object_story_spec;
  if (!creative?.id || !story || !story.page_id) return null;
  if (story.link_data) {
    const d = story.link_data;
    const cta = d.call_to_action as { type?: string } | undefined;
    return {
      kind: "link", creativeId: s(creative.id), creativeName: s(creative.name), pageId: s(story.page_id), instagramUserId: s(story.instagram_user_id ?? story.instagram_actor_id),
      primaryText: s(d.message), headline: s(d.name), description: s(d.description), linkUrl: s(d.link), callToAction: s(cta?.type) || "NO_BUTTON",
      imageHash: s(d.image_hash), picture: s(d.picture), videoId: "", videoImageUrl: "", videoImageHash: "",
    };
  }
  if (story.video_data) {
    const d = story.video_data;
    const cta = d.call_to_action as { type?: string; value?: { link?: string } } | undefined;
    return {
      kind: "video", creativeId: s(creative.id), creativeName: s(creative.name), pageId: s(story.page_id), instagramUserId: s(story.instagram_user_id ?? story.instagram_actor_id),
      primaryText: s(d.message), headline: s(d.title), description: s(d.link_description), linkUrl: s(cta?.value?.link), callToAction: s(cta?.type) || "NO_BUTTON",
      imageHash: "", picture: "", videoId: s(d.video_id), videoImageUrl: s(d.image_url), videoImageHash: s(d.image_hash),
    };
  }
  return null;
}

/** Reads the new texts asked (JSON or object); the reason in French when they cannot be sent. */
export function readMetaAdTexts(value: unknown): { ok: true; texts: MetaAdTexts } | { ok: false; error: string } {
  let raw: Record<string, unknown>;
  try { raw = typeof value === "string" ? JSON.parse(value) : (value as Record<string, unknown>); } catch { return { ok: false, error: "Textes illisibles." }; }
  if (!raw || typeof raw !== "object") return { ok: false, error: "Textes illisibles." };
  const texts: MetaAdTexts = {
    kind: raw.kind === "video" ? "video" : "link",
    primaryText: s(raw.primaryText).replace(/\s+$/, "").slice(0, MAX_PRIMARY_TEXT_CHARS + 1),
    headline: s(raw.headline).trim().slice(0, MAX_HEADLINE_CHARS + 1),
    description: s(raw.description).trim().slice(0, MAX_HEADLINE_CHARS + 1),
    linkUrl: s(raw.linkUrl).trim(),
    callToAction: s(raw.callToAction).trim() || "NO_BUTTON",
  };
  if (!texts.primaryText.trim()) return { ok: false, error: "Le texte principal est vide." };
  if (texts.primaryText.length > MAX_PRIMARY_TEXT_CHARS) return { ok: false, error: `Texte principal trop long (${MAX_PRIMARY_TEXT_CHARS} caractères au plus).` };
  if (texts.headline.length > MAX_HEADLINE_CHARS || texts.description.length > MAX_HEADLINE_CHARS) return { ok: false, error: `Titre ou description trop long (${MAX_HEADLINE_CHARS} caractères au plus).` };
  const link = publicHttpsUrlError(texts.linkUrl);
  if (link) return { ok: false, error: `Lien refusé : ${link}.` };
  if (!(CALL_TO_ACTIONS as readonly string[]).includes(texts.callToAction)) return { ok: false, error: "Bouton d'action inconnu." };
  return { ok: true, texts };
}

/** The object_story_spec of the new creative: the current one with the new texts, nothing else moved. */
export function metaStoryWithTexts(current: MetaAdCreative, texts: MetaAdTexts): Record<string, unknown> {
  const cta = texts.callToAction === "NO_BUTTON" ? { type: "NO_BUTTON" } : { type: texts.callToAction, value: { link: texts.linkUrl } };
  const story: Record<string, unknown> = { page_id: current.pageId };
  if (current.instagramUserId) story.instagram_user_id = current.instagramUserId;
  if (current.kind === "video") {
    const d: Record<string, unknown> = { video_id: current.videoId, message: texts.primaryText, call_to_action: cta };
    if (texts.headline) d.title = texts.headline;
    if (texts.description) d.link_description = texts.description;
    if (current.videoImageHash) d.image_hash = current.videoImageHash; else if (current.videoImageUrl) d.image_url = current.videoImageUrl;
    story.video_data = d;
  } else {
    const d: Record<string, unknown> = { link: texts.linkUrl, message: texts.primaryText, call_to_action: cta };
    if (texts.headline) d.name = texts.headline;
    if (texts.description) d.description = texts.description;
    if (current.imageHash) d.image_hash = current.imageHash; else if (current.picture) d.picture = current.picture;
    story.link_data = d;
  }
  return story;
}

const clip = (v: string, n = 60) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);

/** What changes between two sets of Meta texts, in French. */
export function metaTextsDiff(before: Partial<MetaAdTexts> | null, after: MetaAdTexts): string[] {
  const out: string[] = [];
  const b = before ?? {};
  if ((b.primaryText ?? "") !== after.primaryText) out.push(`texte principal « ${clip(b.primaryText ?? "")} » → « ${clip(after.primaryText)} »`);
  if ((b.headline ?? "") !== after.headline) out.push(`titre « ${b.headline ?? ""} » → « ${after.headline} »`);
  if ((b.description ?? "") !== after.description) out.push(`description « ${b.description ?? ""} » → « ${after.description} »`);
  if ((b.linkUrl ?? "") !== after.linkUrl) out.push(`lien ${b.linkUrl || "—"} → ${after.linkUrl}`);
  if ((b.callToAction ?? "") !== after.callToAction) out.push(`bouton ${b.callToAction || "—"} → ${after.callToAction}`);
  return out;
}

// ── Google Ads (responsive search ads) ────────────────────────────────────

export const RSA_HEADLINE_MAX = 30;
export const RSA_DESCRIPTION_MAX = 90;
export const RSA_HEADLINES = { min: 3, max: 15 };
export const RSA_DESCRIPTIONS = { min: 2, max: 4 };
export const RSA_PINS = ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3", "DESCRIPTION_1", "DESCRIPTION_2"] as const;

export interface RsaAsset { text: string; pinnedField?: string }
export interface RsaSpec {
  headlines: RsaAsset[];
  descriptions: RsaAsset[];
  finalUrls: string[];
  path1: string;
  path2: string;
}

const asset = (v: unknown): RsaAsset | null => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const text = s(o.text).replace(/\s+/g, " ").trim();
  if (!text) return null;
  const pin = s(o.pinnedField ?? o.pinned_field).toUpperCase();
  return (RSA_PINS as readonly string[]).includes(pin) ? { text, pinnedField: pin } : { text };
};

/** The responsive search ad as GAQL gives it (ad_group_ad.ad.responsive_search_ad, final_urls). */
export function readRsaFromAd(ad: Record<string, unknown> | null | undefined): RsaSpec | null {
  const rsa = (ad?.responsiveSearchAd ?? ad?.responsive_search_ad) as Record<string, unknown> | undefined;
  if (!rsa) return null;
  const headlines = (Array.isArray(rsa.headlines) ? rsa.headlines : []).map(asset).filter((a): a is RsaAsset => !!a);
  const descriptions = (Array.isArray(rsa.descriptions) ? rsa.descriptions : []).map(asset).filter((a): a is RsaAsset => !!a);
  const urls = (ad?.finalUrls ?? ad?.final_urls) as unknown;
  return { headlines, descriptions, finalUrls: Array.isArray(urls) ? urls.map(s).filter(Boolean) : [], path1: s(rsa.path1), path2: s(rsa.path2) };
}

/** Reads a new RSA asked (JSON or object); the reason in French when Google would refuse it. */
export function readRsa(value: unknown): { ok: true; spec: RsaSpec } | { ok: false; error: string } {
  let raw: Record<string, unknown>;
  try { raw = typeof value === "string" ? JSON.parse(value) : (value as Record<string, unknown>); } catch { return { ok: false, error: "Annonce illisible." }; }
  if (!raw || typeof raw !== "object") return { ok: false, error: "Annonce illisible." };
  const headlines = (Array.isArray(raw.headlines) ? raw.headlines : []).map(asset).filter((a): a is RsaAsset => !!a);
  const descriptions = (Array.isArray(raw.descriptions) ? raw.descriptions : []).map(asset).filter((a): a is RsaAsset => !!a);
  const finalUrls = (Array.isArray(raw.finalUrls) ? raw.finalUrls : []).map(s).map((u) => u.trim()).filter(Boolean);
  const path1 = s(raw.path1).trim(), path2 = s(raw.path2).trim();
  if (headlines.length < RSA_HEADLINES.min || headlines.length > RSA_HEADLINES.max) return { ok: false, error: `Entre ${RSA_HEADLINES.min} et ${RSA_HEADLINES.max} titres.` };
  if (descriptions.length < RSA_DESCRIPTIONS.min || descriptions.length > RSA_DESCRIPTIONS.max) return { ok: false, error: `Entre ${RSA_DESCRIPTIONS.min} et ${RSA_DESCRIPTIONS.max} descriptions.` };
  const longH = headlines.find((h) => h.text.length > RSA_HEADLINE_MAX);
  if (longH) return { ok: false, error: `Titre trop long (${RSA_HEADLINE_MAX} caractères au plus) : « ${longH.text} ».` };
  const longD = descriptions.find((d) => d.text.length > RSA_DESCRIPTION_MAX);
  if (longD) return { ok: false, error: `Description trop longue (${RSA_DESCRIPTION_MAX} caractères au plus) : « ${clip(longD.text, 40)} ».` };
  if (new Set(headlines.map((h) => h.text.toLowerCase())).size !== headlines.length) return { ok: false, error: "Deux titres identiques." };
  if (headlines.some((h) => h.pinnedField?.startsWith("DESCRIPTION")) || descriptions.some((d) => d.pinnedField?.startsWith("HEADLINE"))) return { ok: false, error: "Épinglage incohérent (titre épinglé en description ou l'inverse)." };
  if (!finalUrls.length) return { ok: false, error: "Il faut une URL finale." };
  for (const u of finalUrls) { const e = publicHttpsUrlError(u); if (e) return { ok: false, error: `URL finale refusée : ${e}.` }; }
  if (path1.length > 15 || path2.length > 15 || /[\s/]/.test(path1 + path2)) return { ok: false, error: "Chemins d'affichage : 15 caractères au plus, sans espace ni « / »." };
  if (path2 && !path1) return { ok: false, error: "Le second chemin demande le premier." };
  return { ok: true, spec: { headlines, descriptions, finalUrls, path1, path2 } };
}

/** The ad as the Google Ads mutate takes it (adGroupAds create). */
export function rsaCreateAd(spec: RsaSpec): Record<string, unknown> {
  const rsa: Record<string, unknown> = {
    headlines: spec.headlines.map((h) => (h.pinnedField ? { text: h.text, pinnedField: h.pinnedField } : { text: h.text })),
    descriptions: spec.descriptions.map((d) => (d.pinnedField ? { text: d.text, pinnedField: d.pinnedField } : { text: d.text })),
  };
  if (spec.path1) rsa.path1 = spec.path1;
  if (spec.path2) rsa.path2 = spec.path2;
  return { responsiveSearchAd: rsa, finalUrls: spec.finalUrls };
}

/** What changes between two responsive search ads, in French. */
export function rsaDiff(before: RsaSpec | null, after: RsaSpec): string[] {
  const out: string[] = [];
  const b = before ?? { headlines: [], descriptions: [], finalUrls: [], path1: "", path2: "" };
  const list = (label: string, was: RsaAsset[], now: RsaAsset[]) => {
    const w = new Set(was.map((a) => a.text)), n = new Set(now.map((a) => a.text));
    const added = now.filter((a) => !w.has(a.text)).map((a) => `« ${a.text} »`), removed = was.filter((a) => !n.has(a.text)).map((a) => `« ${a.text} »`);
    if (added.length || removed.length) out.push(`${label} ${added.length ? `+ ${added.join(", ")}` : ""}${added.length && removed.length ? " ; " : ""}${removed.length ? `− ${removed.join(", ")}` : ""}`);
    else if (JSON.stringify(was.map((a) => a.pinnedField ?? "")) !== JSON.stringify(now.map((a) => a.pinnedField ?? ""))) out.push(`${label} : épinglage modifié`);
  };
  list("titres", b.headlines, after.headlines);
  list("descriptions", b.descriptions, after.descriptions);
  if (b.finalUrls.join(" ") !== after.finalUrls.join(" ")) out.push(`URL ${b.finalUrls.join(" ") || "—"} → ${after.finalUrls.join(" ")}`);
  if (`${b.path1}/${b.path2}` !== `${after.path1}/${after.path2}`) out.push(`chemin /${b.path1}/${b.path2} → /${after.path1}/${after.path2}`);
  return out;
}

/** « 8 titres, 4 descriptions » — how the tree names a responsive search ad. */
export const rsaSummary = (spec: RsaSpec) => `${spec.headlines.length} titre${spec.headlines.length > 1 ? "s" : ""}, ${spec.descriptions.length} description${spec.descriptions.length > 1 ? "s" : ""}`;
