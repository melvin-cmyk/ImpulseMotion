/**
 * Meta Marketing API — the only writes of the application: ads created PAUSED
 * for the routines (step meta.create_ads).
 *
 * What this module can do, and nothing more:
 *   - create an ad creative (link ad, image given by URL) and an ad in an
 *     existing ad set, the ad being PAUSED;
 *   - pause an ad it has just created, when the re-read says it is not paused.
 * It cannot activate, change a budget or a bid, edit or delete anything. No
 * function takes a status: `status=PAUSED` is written by metaGraphPost
 * (lib/meta-api.ts), whose targets and fields are a closed list.
 *
 * Every function that writes starts with assertWriteGuard(guard): only the
 * engine of a live run holds a guard.
 *
 * Errors are `MetaWriteError`, already cleaned: no token, no raw Meta payload.
 *   refused    nothing was sent, or Meta refused: nothing was created
 *   uncertain  a POST timed out or lost the network: outcome unknown, never retried
 *   not_paused the ad exists but is not confirmed PAUSED (a pause was attempted)
 *   infra      a read failed (network, quota, token): nothing was created
 *
 * First version: image only. A video needs an upload of its own
 * (POST /act_X/advideos with file_url), processed asynchronously by Meta, and a
 * thumbnail; it is not done here.
 *
 * Docs: https://developers.facebook.com/docs/marketing-api/reference/ad-account/adcreatives/
 *       https://developers.facebook.com/docs/marketing-api/reference/ad-creative-link-data/
 *       https://developers.facebook.com/docs/marketing-api/reference/ad-account/ads/
 */

import { getMetaSystemToken, getMetaTokens, isMetaWriteUncertain, metaGraphGetOnce, metaGraphPost } from "@/lib/meta-api";
import { isMetaApiError } from "@/lib/meta-errors";
import { metaAccountDigits } from "@/lib/routines/accounts";
import { assertWriteGuard } from "@/lib/routines/write-guard-check";
import type { WriteGuard } from "@/lib/routines/types";

// ── Errors ───────────────────────────────────────────────────────────────────

export type MetaWriteErrorKind = "refused" | "uncertain" | "not_paused" | "infra";

export class MetaWriteError extends Error {
  readonly name = "MetaWriteError";
  kind: MetaWriteErrorKind;
  /** Ad that exists on Meta despite the error (not_paused). */
  adId?: string;
  creativeId?: string;

  constructor(kind: MetaWriteErrorKind, message: string, ids: { adId?: string; creativeId?: string } = {}) {
    super(cleanMetaMessage(message));
    this.kind = kind;
    this.adId = ids.adId;
    this.creativeId = ids.creativeId;
  }
}

export function isMetaWriteError(err: unknown): err is MetaWriteError {
  return err instanceof MetaWriteError || (!!err && typeof err === "object" && (err as { name?: string }).name === "MetaWriteError");
}

const MAX_MESSAGE_CHARS = 300;

/** Text safe to store and to show: no token, no query string carrying one, bounded. */
export function cleanMetaMessage(message: unknown): string {
  let text = typeof message === "string" ? message : message instanceof Error ? message.message : String(message ?? "");
  for (const token of getMetaTokens()) {
    if (token.length >= 8) text = text.split(token).join("[jeton]");
  }
  text = text
    .replace(/(access_token|appsecret_proof|client_secret)\s*["']?\s*[=:]\s*["']?[^\s&"',}]+/gi, "$1=[masqué]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [masqué]")
    .replace(/\bEA[A-Za-z0-9]{30,}\b/g, "[jeton]")
    .replace(/\s*Please read the Graph API documentation at \S+/gi, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

/** Any error of a read → MetaWriteError: Meta said no (refused) or could not be reached (infra). */
function fromReadError(err: unknown, what: string): MetaWriteError {
  if (isMetaWriteError(err)) return err;
  if (isMetaApiError(err)) {
    const definite = err.kind === "invalid" || err.kind === "permission";
    return new MetaWriteError(definite ? "refused" : "infra", `${what} : ${err.message} (code ${err.code})`);
  }
  return new MetaWriteError("infra", `${what} : ${err instanceof Error ? err.message : String(err)}`);
}

// ── Inputs ───────────────────────────────────────────────────────────────────

const ID_RE = /^\d{5,25}$/;

export function isMetaId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

/**
 * Digits of the ad account, by the rule shared with the creation of the
 * routine (lib/routines/accounts.ts); empty when the id is not one, which
 * every caller below refuses.
 */
const bareAccount = (accountId: string) => metaAccountDigits(accountId) ?? "";

/** Buttons accepted on a link ad (subset of AdCreativeLinkDataCallToAction.type). */
export const CALL_TO_ACTIONS = [
  "LEARN_MORE", "SHOP_NOW", "SIGN_UP", "SUBSCRIBE", "DOWNLOAD", "BOOK_NOW", "BOOK_TRAVEL", "CONTACT_US",
  "GET_OFFER", "GET_QUOTE", "APPLY_NOW", "ORDER_NOW", "BUY_NOW", "DONATE_NOW", "SEE_MORE", "WATCH_MORE", "NO_BUTTON",
] as const;
export type CallToAction = (typeof CALL_TO_ACTIONS)[number];

export function isCallToAction(value: unknown): value is CallToAction {
  return typeof value === "string" && (CALL_TO_ACTIONS as readonly string[]).includes(value);
}

export const MAX_AD_NAME_CHARS = 255;
export const MAX_PRIMARY_TEXT_CHARS = 2000;
export const MAX_HEADLINE_CHARS = 255;
export const MAX_URL_CHARS = 2000;

const INTERNAL_SUFFIXES = [
  ".local", ".localhost", ".internal", ".intranet", ".lan", ".home", ".corp", ".private",
  ".test", ".example", ".invalid", ".arpa", ".onion",
];

/**
 * Null when the URL can be handed to Meta, the reason otherwise. https only,
 * public host name only: no IP address (private or not), no single-label or
 * internal name, no credentials, no port other than 443. The application never
 * fetches the URL: the check keeps internal addresses out of what is sent.
 */
export function publicHttpsUrlError(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "adresse vide";
  const raw = value.trim();
  if (raw.length > MAX_URL_CHARS) return `adresse trop longue (${MAX_URL_CHARS} caractères au plus)`;
  if (/[\s\u0000-\u001f\\]/.test(raw)) return "adresse invalide (espace ou caractère interdit)";
  if (!/^https:\/\//i.test(raw)) return "seules les adresses https:// sont acceptées";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "adresse invalide";
  }
  if (url.protocol !== "https:") return "seules les adresses https:// sont acceptées";
  if (url.username || url.password) return "adresse avec identifiants refusée";
  if (url.port && url.port !== "443") return "port non standard refusé";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "adresse sans nom d'hôte";
  if (host.startsWith("[") || host.includes(":")) return "adresse IP refusée : un nom de domaine public est attendu";
  if (/^\d+(\.\d+){3}$/.test(host) || /^[\d.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return "adresse IP refusée : un nom de domaine public est attendu";
  }
  if (!host.includes(".")) return "nom d'hôte interne refusé";
  if (host === "localhost" || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return "nom d'hôte interne refusé";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return "nom d'hôte invalide";
  if (!/[a-z]/.test(host.split(".").pop() ?? "")) return "nom d'hôte invalide";
  return null;
}

/** What one ad is made of. No status, no budget, no bid: there is nothing to pass. */
export interface PausedAdInput {
  accountId: string;
  campaignId: string;
  adsetId: string;
  pageId: string;
  /** Instagram account of the ad (object_story_spec.instagram_user_id). */
  instagramUserId?: string;
  name: string;
  primaryText: string;
  headline?: string;
  description?: string;
  linkUrl: string;
  callToAction?: string;
  /** Public https URL of the image; Meta downloads it, the application never does. */
  imageUrl: string;
}

export interface PausedAdResult {
  adId: string;
  creativeId: string;
  status: "PAUSED";
}

/** Null when the input can be sent, the reason otherwise. No network. */
export function pausedAdInputError(input: PausedAdInput): string | null {
  if (!input || typeof input !== "object") return "publicité invalide";
  if (!bareAccount(String(input.accountId ?? ""))) return "compte publicitaire invalide";
  if (!isMetaId(input.campaignId)) return "identifiant de campagne invalide";
  if (!isMetaId(input.adsetId)) return "identifiant d'ensemble de publicités invalide";
  if (!isMetaId(input.pageId)) return "identifiant de page invalide";
  if (input.instagramUserId !== undefined && !isMetaId(input.instagramUserId)) return "identifiant de compte Instagram invalide";
  if (typeof input.name !== "string" || !input.name.trim()) return "nom de publicité vide";
  if (input.name.length > MAX_AD_NAME_CHARS) return `nom de publicité trop long (${MAX_AD_NAME_CHARS} caractères au plus)`;
  if (typeof input.primaryText !== "string" || !input.primaryText.trim()) return "texte principal vide";
  if (input.primaryText.length > MAX_PRIMARY_TEXT_CHARS) return `texte principal trop long (${MAX_PRIMARY_TEXT_CHARS} caractères au plus)`;
  for (const [label, value] of [["titre", input.headline], ["description", input.description]] as const) {
    if (value === undefined) continue;
    if (typeof value !== "string") return `${label} invalide`;
    if (value.length > MAX_HEADLINE_CHARS) return `${label} trop long (${MAX_HEADLINE_CHARS} caractères au plus)`;
  }
  const link = publicHttpsUrlError(input.linkUrl);
  if (link) return `lien refusé : ${link}`;
  const image = publicHttpsUrlError(input.imageUrl);
  if (image) return `image refusée : ${image}`;
  if (input.callToAction !== undefined && !isCallToAction(input.callToAction)) return "bouton d'action inconnu";
  return null;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface AdsetCheck {
  adsetId: string;
  name: string;
  accountId: string;
  campaignId: string;
  status: string;
}

/**
 * Re-reads the ad set and compares it with the account AND the campaign of the
 * routine. Throws `refused` on any difference: the caller must not write.
 */
export async function verifyAdsetInAccount(accountId: string, campaignId: string, adsetId: string): Promise<AdsetCheck> {
  const account = bareAccount(String(accountId ?? ""));
  if (!account) throw new MetaWriteError("refused", "Compte publicitaire invalide");
  if (!isMetaId(campaignId)) throw new MetaWriteError("refused", "Identifiant de campagne invalide");
  if (!isMetaId(adsetId)) throw new MetaWriteError("refused", "Identifiant d'ensemble de publicités invalide");

  let data: { id?: string; name?: string; account_id?: string; campaign_id?: string; status?: string };
  try {
    data = await metaGraphGetOnce(`/${adsetId}`, getMetaSystemToken(), { fields: "id,name,account_id,campaign_id,status" });
  } catch (err) {
    throw fromReadError(err, `Ensemble de publicités ${adsetId} illisible`);
  }
  if (String(data?.id ?? "") !== adsetId) throw new MetaWriteError("refused", `Ensemble de publicités ${adsetId} introuvable`);
  if (bareAccount(String(data.account_id ?? "")) !== account) {
    throw new MetaWriteError("refused", `L'ensemble de publicités ${adsetId} n'appartient pas au compte de la routine`);
  }
  if (String(data.campaign_id ?? "") !== campaignId) {
    throw new MetaWriteError("refused", `L'ensemble de publicités ${adsetId} n'appartient pas à la campagne ${campaignId}`);
  }
  return { adsetId, name: data.name ?? adsetId, accountId: `act_${account}`, campaignId, status: data.status ?? "UNKNOWN" };
}

export interface CampaignCheck { campaignId: string; name: string; accountId: string; status: string }

/** The campaign exists and belongs to the account. Throws `refused` otherwise. */
export async function verifyCampaignInAccount(accountId: string, campaignId: string): Promise<CampaignCheck> {
  const account = bareAccount(String(accountId ?? ""));
  if (!account) throw new MetaWriteError("refused", "Compte publicitaire invalide");
  if (!isMetaId(campaignId)) throw new MetaWriteError("refused", "Identifiant de campagne invalide");
  let data: { id?: string; name?: string; account_id?: string; status?: string };
  try {
    data = await metaGraphGetOnce(`/${campaignId}`, getMetaSystemToken(), { fields: "id,name,account_id,status" });
  } catch (err) {
    throw fromReadError(err, `Campagne ${campaignId} illisible`);
  }
  if (String(data?.id ?? "") !== campaignId) throw new MetaWriteError("refused", `Campagne ${campaignId} introuvable`);
  if (bareAccount(String(data.account_id ?? "")) !== account) {
    throw new MetaWriteError("refused", `La campagne ${campaignId} n'appartient pas au compte de la routine`);
  }
  return { campaignId, name: data.name ?? campaignId, accountId: `act_${account}`, status: data.status ?? "UNKNOWN" };
}

export interface ExistingAd { id: string; name: string; status: string; effectiveStatus: string }

const FIND_PAGE_SIZE = 200;
const FIND_MAX_PAGES = 10;

/**
 * Ad of the ad set bearing exactly this name, or null. Meta filters on
 * "contains"; the exact comparison is done here. Deleted and archived ads are
 * not listed by Meta. Throws when the ad set cannot be read: not knowing is
 * not "no such ad".
 */
export async function findAdByName(adsetId: string, name: string): Promise<ExistingAd | null> {
  if (!isMetaId(adsetId)) throw new MetaWriteError("refused", "Identifiant d'ensemble de publicités invalide");
  const wanted = String(name ?? "").trim();
  if (!wanted) throw new MetaWriteError("refused", "Nom de publicité vide");
  const params: Record<string, string> = {
    fields: "id,name,status,effective_status",
    filtering: JSON.stringify([{ field: "name", operator: "CONTAIN", value: wanted }]),
    limit: String(FIND_PAGE_SIZE),
  };
  let after: string | undefined;
  try {
    for (let page = 0; page < FIND_MAX_PAGES; page++) {
      const data = await metaGraphGetOnce<{
        data?: Array<{ id?: string; name?: string; status?: string; effective_status?: string }>;
        paging?: { cursors?: { after?: string }; next?: string };
      }>(`/${adsetId}/ads`, getMetaSystemToken(), after ? { ...params, after } : params);
      for (const ad of Array.isArray(data.data) ? data.data : []) {
        if (ad.id && String(ad.name ?? "").trim() === wanted) {
          return { id: ad.id, name: wanted, status: ad.status ?? "UNKNOWN", effectiveStatus: ad.effective_status ?? "UNKNOWN" };
        }
      }
      after = data.paging?.next ? data.paging.cursors?.after : undefined;
      if (!after) return null;
    }
  } catch (err) {
    throw fromReadError(err, `Publicités de l'ensemble ${adsetId} illisibles`);
  }
  throw new MetaWriteError("infra", `Trop de publicités portent un nom proche de « ${wanted} » dans l'ensemble ${adsetId}`);
}

/**
 * One ad, read by its id: what the routine does with an item whose ad is
 * known (RoutineItem.externalId) instead of looking for a name. Null when
 * Meta says the ad does not exist (deleted). Throws `infra` when Meta could
 * not be reached: not knowing is not "no such ad".
 */
export async function readAdById(adId: string): Promise<(ExistingAd & { adsetId: string }) | null> {
  if (!isMetaId(adId)) throw new MetaWriteError("refused", "Identifiant de publicité invalide");
  let data: { id?: string; name?: string; status?: string; effective_status?: string; adset_id?: string };
  try {
    data = await metaGraphGetOnce(`/${adId}`, getMetaSystemToken(), { fields: "id,name,status,effective_status,adset_id" });
  } catch (err) {
    const e = fromReadError(err, `Publicité ${adId} illisible`);
    // Meta answers « does not exist » with an invalid-request error: the ad is gone, or out of reach of the token.
    if (e.kind === "refused") return null;
    throw e;
  }
  if (String(data?.id ?? "") !== adId) return null;
  return {
    id: adId, name: String(data.name ?? ""), status: data.status ?? "UNKNOWN",
    effectiveStatus: data.effective_status ?? "UNKNOWN", adsetId: String(data.adset_id ?? ""),
  };
}

export interface PromotablePage { id: string; name: string }

/**
 * Pages the ad account can promote, for the form that creates a routine. Read
 * only. `complete` is false when Meta holds more than one page of them.
 */
export async function listPromotablePages(accountId: string): Promise<{ pages: PromotablePage[]; complete: boolean }> {
  const account = bareAccount(String(accountId ?? ""));
  if (!account) throw new MetaWriteError("refused", "Compte publicitaire invalide");
  let data: { data?: Array<{ id?: string; name?: string }>; paging?: { next?: string } };
  try {
    data = await metaGraphGetOnce(`/act_${account}/promote_pages`, getMetaSystemToken(), { fields: "id,name", limit: "200" });
  } catch (err) {
    throw fromReadError(err, "Pages du compte publicitaire illisibles");
  }
  const pages = (Array.isArray(data?.data) ? data.data : [])
    .filter((p) => isMetaId(p?.id))
    .map((p) => ({ id: String(p.id), name: String(p.name ?? p.id).slice(0, 120) }));
  return { pages, complete: !data?.paging?.next };
}

const PROMOTE_MAX_PAGES = 10;

/**
 * The Page is one of those the ad account can promote. Throws `refused` when
 * it is not: the token of the agency reads the Pages of many clients, and an
 * ad of a client must never leave under the Page of another. Throws `infra`
 * when the list could not be read, or not to its end: not knowing is not yes.
 */
export async function verifyPagePromotable(accountId: string, pageId: string): Promise<PromotablePage> {
  const account = bareAccount(String(accountId ?? ""));
  if (!account) throw new MetaWriteError("refused", "Compte publicitaire invalide");
  if (!isMetaId(pageId)) throw new MetaWriteError("refused", "Identifiant de page invalide");
  let after: string | undefined;
  try {
    for (let page = 0; page < PROMOTE_MAX_PAGES; page++) {
      const data = await metaGraphGetOnce<{ data?: Array<{ id?: string; name?: string }>; paging?: { cursors?: { after?: string }; next?: string } }>(
        `/act_${account}/promote_pages`, getMetaSystemToken(), { fields: "id,name", limit: "200", ...(after ? { after } : {}) });
      const found = (Array.isArray(data?.data) ? data.data : []).find((p) => p?.id === pageId);
      if (found) return { id: pageId, name: String(found.name ?? pageId).slice(0, 120) };
      after = data?.paging?.next ? data.paging.cursors?.after : undefined;
      if (!after) {
        throw new MetaWriteError("refused", `La Page ${pageId} n'est pas de celles que le compte publicitaire de la routine peut promouvoir : aucune publicité n'est créée sous cette Page`);
      }
    }
  } catch (err) {
    throw fromReadError(err, "Pages du compte publicitaire illisibles");
  }
  throw new MetaWriteError("infra", `Pages du compte publicitaire trop nombreuses pour y chercher la Page ${pageId}`);
}

export interface InstagramCheck {
  /** true = the accounts of the ad account could be listed; false = the token cannot read them. */
  readable: boolean;
  /** true = listed; false = the list was read to its end without it; null = not known. */
  allowed: boolean | null;
  note: string | null;
}

/**
 * Instagram account given for the ads, against those of the ad account. Never
 * throws. The system-user token often cannot read them (verified 2026-09-29
 * for the edges of a Page): `readable` is then false, nothing is concluded
 * and Meta decides at creation.
 */
export async function checkInstagramActor(accountId: string, instagramUserId: string): Promise<InstagramCheck> {
  const account = bareAccount(String(accountId ?? ""));
  if (!account || !isMetaId(instagramUserId)) return { readable: true, allowed: false, note: "Identifiant de compte Instagram invalide" };
  try {
    const data = await metaGraphGetOnce<{ data?: Array<{ id?: string }>; paging?: { next?: string } }>(
      `/act_${account}/instagram_accounts`, getMetaSystemToken(), { fields: "id", limit: "200" });
    if (!Array.isArray(data?.data)) return { readable: false, allowed: null, note: `Compte Instagram ${instagramUserId} non vérifié : la liste des comptes Instagram du compte publicitaire n'est pas lisible (Meta tranchera à la création)` };
    if (data.data.some((a) => a?.id === instagramUserId)) return { readable: true, allowed: true, note: null };
    if (data.paging?.next) return { readable: true, allowed: null, note: `Compte Instagram ${instagramUserId} non vérifié : le compte publicitaire en a plus de 200 (Meta tranchera à la création)` };
    return { readable: true, allowed: false, note: `Le compte Instagram ${instagramUserId} n'est pas de ceux du compte publicitaire de la routine : aucune publicité n'est créée sous ce compte` };
  } catch (err) {
    return { readable: false, allowed: null, note: `Compte Instagram ${instagramUserId} non vérifié : ${fromReadError(err, "liste des comptes Instagram illisible avec le jeton de l'agence").message} (Meta tranchera à la création)` };
  }
}

export interface IdentityCheck {
  /** true = readable with the token; false = Meta refused; null = could not be checked. */
  pageReadable: boolean | null;
  pageName?: string;
  /** true = among the Pages the ad account can promote; false = not listed; null = could not be checked. */
  pagePromotable: boolean | null;
  /** true = already used by a creative of the account; null = not asked or not confirmed. Never false: see below. */
  instagramKnown: boolean | null;
  notes: string[];
}

/**
 * Read-only check of the Page and of the Instagram account given for the ads.
 * Never throws: what could not be verified is said in `notes`.
 *
 * The Instagram account cannot be read with a system-user token (its edges ask
 * for a Page token; verified 2026-09-29). The only confirmation available is
 * finding it on a recent creative of the same ad account; not finding it
 * proves nothing, Meta decides at creation.
 */
export async function checkAdIdentity(accountId: string, pageId: string, instagramUserId?: string): Promise<IdentityCheck> {
  const out: IdentityCheck = { pageReadable: null, pagePromotable: null, instagramKnown: null, notes: [] };
  const account = bareAccount(String(accountId ?? ""));
  if (!account || !isMetaId(pageId) || (instagramUserId !== undefined && !isMetaId(instagramUserId))) {
    out.pageReadable = false;
    out.notes.push("Identifiant de compte, de page ou de compte Instagram invalide");
    return out;
  }
  const token = getMetaSystemToken();
  try {
    const page = await metaGraphGetOnce<{ id?: string; name?: string }>(`/${pageId}`, token, { fields: "id,name" });
    out.pageReadable = String(page?.id ?? "") === pageId;
    out.pageName = page?.name;
    if (!out.pageReadable) out.notes.push(`Page ${pageId} introuvable`);
  } catch (err) {
    const e = fromReadError(err, `Page ${pageId} illisible`);
    out.pageReadable = e.kind === "refused" ? false : null;
    out.notes.push(e.message);
  }
  if (out.pageReadable === false) return out;
  try {
    const pages = await metaGraphGetOnce<{ data?: Array<{ id?: string }>; paging?: { next?: string } }>(
      `/act_${account}/promote_pages`, token, { fields: "id", limit: "200" });
    const listed = (pages.data ?? []).some((p) => p.id === pageId);
    // Beyond one page of 200 the absence proves nothing.
    out.pagePromotable = listed ? true : pages.paging?.next ? null : false;
    if (out.pagePromotable === false) out.notes.push(`Page ${pageId} absente des pages que le compte publicitaire peut promouvoir`);
  } catch (err) {
    out.notes.push(fromReadError(err, "Pages du compte publicitaire illisibles").message);
  }
  if (instagramUserId) {
    try {
      const creatives = await metaGraphGetOnce<{ data?: Array<{ instagram_user_id?: string }> }>(
        `/act_${account}/adcreatives`, token, { fields: "instagram_user_id", limit: "100" });
      if ((creatives.data ?? []).some((c) => c.instagram_user_id === instagramUserId)) out.instagramKnown = true;
      else out.notes.push(`Compte Instagram ${instagramUserId} non confirmé : aucun visuel récent du compte ne l'utilise (Meta tranchera à la création)`);
    } catch (err) {
      out.notes.push(fromReadError(err, "Compte Instagram non vérifié").message);
    }
  }
  return out;
}

// ── Write ────────────────────────────────────────────────────────────────────

/** Any error of a POST → MetaWriteError. */
function fromWriteError(err: unknown, what: string, ids: { adId?: string; creativeId?: string } = {}): MetaWriteError {
  if (isMetaWriteError(err)) return err;
  if (isMetaWriteUncertain(err)) return new MetaWriteError("uncertain", `${what} : issue inconnue (expiration ou coupure réseau), aucune nouvelle tentative`, ids);
  if (isMetaApiError(err)) {
    const retryLater = err.kind === "auth" || err.kind === "rate_limit";
    return new MetaWriteError(retryLater ? "infra" : "refused", `${what} refusée par Meta : ${err.message} (code ${err.code}${err.subcode ? `/${err.subcode}` : ""})`, ids);
  }
  return new MetaWriteError("refused", `${what} : ${err instanceof Error ? err.message : String(err)}`, ids);
}

/** Best effort: asks Meta to pause the ad. True when Meta confirmed. */
async function tryPause(guard: WriteGuard, adId: string): Promise<boolean> {
  try {
    const res = await metaGraphPost<{ success?: boolean }>(guard, { kind: "pause_ad", adId }, getMetaSystemToken());
    return res?.success === true;
  } catch {
    return false;
  }
}

/**
 * Creates one ad, PAUSED, in the ad set of the routine: creative first, then
 * the ad, then a re-read of the ad. The ad set is re-read and compared with
 * the account and the campaign before anything is sent.
 *
 * Does not check that an ad of the same name exists: the caller does, with
 * findAdByName, because it has to tell "created" from "already there".
 */
export async function createPausedAd(guard: WriteGuard, input: PausedAdInput): Promise<PausedAdResult> {
  assertWriteGuard(guard);
  const invalid = pausedAdInputError(input);
  if (invalid) throw new MetaWriteError("refused", `Publicité refusée : ${invalid}`);
  const account = bareAccount(input.accountId);
  await verifyAdsetInAccount(account, input.campaignId, input.adsetId);

  const token = getMetaSystemToken();
  const linkData: Record<string, unknown> = {
    link: input.linkUrl.trim(),
    message: input.primaryText,
    picture: input.imageUrl.trim(),
  };
  if (input.headline?.trim()) linkData.name = input.headline;
  if (input.description?.trim()) linkData.description = input.description;
  if (input.callToAction && input.callToAction !== "NO_BUTTON") {
    linkData.call_to_action = { type: input.callToAction, value: { link: input.linkUrl.trim() } };
  } else if (input.callToAction === "NO_BUTTON") {
    linkData.call_to_action = { type: "NO_BUTTON" };
  }
  const story: Record<string, unknown> = { page_id: input.pageId, link_data: linkData };
  if (input.instagramUserId) story.instagram_user_id = input.instagramUserId;

  let creativeId: string;
  try {
    const res = await metaGraphPost<{ id?: string }>(guard, { kind: "adcreative", accountId: account }, token, {
      name: input.name,
      object_story_spec: JSON.stringify(story),
    });
    creativeId = String(res?.id ?? "");
  } catch (err) {
    throw fromWriteError(err, "Création du visuel");
  }
  if (!isMetaId(creativeId)) throw new MetaWriteError("uncertain", "Création du visuel : réponse de Meta sans identifiant");

  let adId: string;
  try {
    const res = await metaGraphPost<{ id?: string }>(guard, { kind: "ad", accountId: account }, token, {
      name: input.name,
      adset_id: input.adsetId,
      creative: JSON.stringify({ creative_id: creativeId }),
    });
    adId = String(res?.id ?? "");
  } catch (err) {
    throw fromWriteError(err, "Création de la publicité", { creativeId });
  }
  if (!isMetaId(adId)) throw new MetaWriteError("uncertain", "Création de la publicité : réponse de Meta sans identifiant", { creativeId });

  // Trust nothing: the ad is read back, and paused if it is not.
  let seen: { id?: string; status?: string; adset_id?: string } | null = null;
  let readError = "";
  try {
    seen = await metaGraphGetOnce(`/${adId}`, token, { fields: "id,status,effective_status,adset_id" });
  } catch (err) {
    readError = fromReadError(err, "relecture impossible").message;
  }
  if (seen?.status === "PAUSED") return { adId, creativeId, status: "PAUSED" };

  const paused = await tryPause(guard, adId);
  const found = seen ? `statut relu « ${String(seen.status ?? "inconnu")} »` : readError;
  throw new MetaWriteError(
    "not_paused",
    `Publicité ${adId} créée mais non confirmée en pause (${found}). Mise en pause ${paused ? "demandée et acceptée par Meta" : "tentée sans confirmation"} : à vérifier dans le gestionnaire de publicités.`,
    { adId, creativeId },
  );
}
