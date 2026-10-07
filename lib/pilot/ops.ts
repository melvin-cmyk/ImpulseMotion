/**
 * Pilotage — what a consultant may change on an ad account, said precisely.
 *
 * A request names one object, one kind of change and the value wanted. It is
 * turned into an operation against the object as the platform holds it NOW
 * (prepareOperation): the field written, the value before and the value after,
 * both as the platform stores them (budgets in minor units). The preview, the
 * second confirmation, the journal, HQ and the undo all read these operations.
 *
 * Second confirmation (decided with Melvin, 2026-10-02): a budget raised by
 * more than 50 % or by more than 300 (account currency) a day, a whole
 * campaign stopped, any deletion.
 *
 * Platforms: Meta and Google Ads. The same three levels are used for both
 * (campaign, adset, ad); on Google Ads an « adset » is an ad group, and its
 * ads are not changed from here. What a platform cannot change on an object
 * is said by the object itself (budgetLock, endTimeLock), read by the adapter.
 *
 * Pure: no network, no database.
 */

import { canonicalTargeting, readTargeting, targetingDiff, type Targeting } from "@/lib/pilot/targeting";

export const PILOT_PLATFORMS = ["meta", "google"] as const;
export type PilotPlatform = (typeof PILOT_PLATFORMS)[number];
export const isPilotPlatform = (v: unknown): v is PilotPlatform => v === "meta" || v === "google";
export const PLATFORM_FR: Record<string, string> = { meta: "Meta", google: "Google Ads", tiktok: "TikTok Ads" };
/** Google Ads also has keywords: under an ad group (objectId « adGroupId~criterionId »), or negative under a campaign (« campaignId~criterionId »). */
export type PilotObjectType = "campaign" | "adset" | "ad" | "keyword";
export const KEYWORD_MATCH_TYPES = ["EXACT", "PHRASE", "BROAD"] as const;
export type KeywordMatchType = (typeof KEYWORD_MATCH_TYPES)[number];
export const MATCH_FR: Record<KeywordMatchType, string> = { EXACT: "exact", PHRASE: "expression", BROAD: "large" };
export type PilotStatus = "ACTIVE" | "PAUSED" | "DELETED";

export const PILOT_KINDS = [
  "set_status", "set_daily_budget", "set_lifetime_budget", "set_end_time", "set_start_time", "set_bid_amount", "set_target_cpa", "set_target_roas",
  "set_bid_strategy", "set_spend_cap", "rename", "create_ad", "duplicate", "add_keyword", "add_negative_keyword", "set_targeting",
] as const;
export type PilotKind = (typeof PILOT_KINDS)[number];

/** At most this many changes in one action: each is read, written and read again. */
export const PILOT_MAX_OPERATIONS = 25;
/** A preview older than this is prepared again: the account may have moved meanwhile. */
export const PILOT_DRAFT_TTL_MS = 30 * 60 * 1000;
/** Raise of a budget that asks for a second confirmation. */
export const DOUBLE_RAISE_RATIO = 1.5;
export const DOUBLE_RAISE_ABSOLUTE = 300;

/**
 * A new Meta ad (kind "create_ad", on an ad set): an image ad, created PAUSED
 * by lib/meta-write.ts createPausedAd. Checked again on the server (Page,
 * Instagram account, campaign of the ad set) before the preview.
 */
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
  /** The Studio créa visual, when the image comes from there. */
  studioAssetId?: string;
  /** Filled by the server at the preview: the campaign of the ad set. */
  campaignId?: string;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+$/, "").slice(0, max) : "");
const httpsOk = (v: string) => /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$|\?)/i.test(v);

/** Reads a NewAdSpec from the value of a request (JSON); the reason in French when it is not one. */
export function readNewAd(value: unknown): { ok: true; spec: NewAdSpec } | { ok: false; error: string } {
  let raw: Record<string, unknown>;
  try { raw = typeof value === "string" ? JSON.parse(value) : (value as Record<string, unknown>); } catch { return { ok: false, error: "Publicité illisible." }; }
  if (!raw || typeof raw !== "object") return { ok: false, error: "Publicité illisible." };
  const spec: NewAdSpec = {
    name: str(raw.name, 255).trim(),
    primaryText: str(raw.primaryText, 2000).trim(),
    headline: str(raw.headline, 255).trim() || undefined,
    description: str(raw.description, 255).trim() || undefined,
    linkUrl: str(raw.linkUrl, 2000).trim(),
    callToAction: str(raw.callToAction, 40).trim() || undefined,
    imageUrl: str(raw.imageUrl, 2000).trim(),
    pageId: str(raw.pageId, 30).trim(),
    instagramUserId: str(raw.instagramUserId, 30).trim() || undefined,
    studioAssetId: str(raw.studioAssetId, 40).trim() || undefined,
    campaignId: str(raw.campaignId, 30).trim() || undefined,
  };
  if (!spec.name) return { ok: false, error: "Donnez un nom à la publicité." };
  if (!spec.primaryText) return { ok: false, error: "Le texte principal de la publicité est vide." };
  if (!httpsOk(spec.linkUrl)) return { ok: false, error: "Le lien de la publicité doit commencer par https://." };
  if (!httpsOk(spec.imageUrl)) return { ok: false, error: "Choisissez une image (Studio créa ou image envoyée)." };
  if (!/^\d{5,25}$/.test(spec.pageId)) return { ok: false, error: "Choisissez la Page Facebook de la publicité." };
  if (spec.instagramUserId && !/^\d{5,25}$/.test(spec.instagramUserId)) return { ok: false, error: "Compte Instagram invalide." };
  return { ok: true, spec };
}

export interface PilotRequest {
  kind: PilotKind;
  objectType: PilotObjectType;
  objectId: string;
  /** set_status: ACTIVE | PAUSED | DELETED; budgets and bid: amount in the account currency; end time: ISO date; rename: text. */
  value: string | number;
}

/**
 * A copy of a campaign, an ad set or an ad (kind "duplicate", Meta): created
 * PAUSED with everything below it, under a new name.
 */
export interface CopySpec { name: string }

export function readCopy(value: unknown): { ok: true; spec: CopySpec } | { ok: false; error: string } {
  let raw: Record<string, unknown>;
  try { raw = typeof value === "string" ? JSON.parse(value) : (value as Record<string, unknown>); } catch { return { ok: false, error: "Copie illisible." }; }
  if (!raw || typeof raw !== "object") return { ok: false, error: "Copie illisible." };
  const name = str(raw.name, 400).replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, error: "Donnez un nom à la copie." };
  return { ok: true, spec: { name } };
}

/** A keyword to add (kind "add_keyword" on an ad group, "add_negative_keyword" on a campaign — Google Ads). */
export interface KeywordSpec { text: string; matchType: KeywordMatchType }

export function readKeyword(value: unknown): { ok: true; spec: KeywordSpec } | { ok: false; error: string } {
  let raw: Record<string, unknown>;
  try { raw = typeof value === "string" ? JSON.parse(value) : (value as Record<string, unknown>); } catch { return { ok: false, error: "Mot-clé illisible." }; }
  if (!raw || typeof raw !== "object") return { ok: false, error: "Mot-clé illisible." };
  const text = str(raw.text, 80).replace(/\s+/g, " ").trim().toLowerCase();
  const matchType = String(raw.matchType ?? "").toUpperCase() as KeywordMatchType;
  if (!text || text.length < 2) return { ok: false, error: "Le mot-clé est vide." };
  if (/[!@%,*"'()<>\[\]{}|\\]/.test(text)) return { ok: false, error: `Le mot-clé « ${text} » contient un caractère que Google Ads refuse.` };
  if (text.split(" ").length > 10) return { ok: false, error: "Un mot-clé a dix mots au plus." };
  if (!KEYWORD_MATCH_TYPES.includes(matchType)) return { ok: false, error: "Type de correspondance inconnu (exact, expression ou large)." };
  return { ok: true, spec: { text, matchType } };
}

/** « chaussures running » [expression] — the same in the tree, the preview and HQ. */
export const keywordText = (spec: KeywordSpec) => `« ${spec.text} » [${MATCH_FR[spec.matchType]}]`;

/** An object as the platform holds it now. Amounts in minor units. */
export interface PilotObjectState {
  id: string;
  type: PilotObjectType;
  accountId: string;
  name: string;
  /** Configured status (what a change writes). */
  status: string;
  /** What the platform does with it (ACTIVE, PAUSED, CAMPAIGN_PAUSED, …). */
  effectiveStatus: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  /** Campaign: stop_time; ad set: end_time. Google Ads: the end date (YYYY-MM-DD). */
  endTime: string | null;
  /** Meta: start_time; Google Ads: the start date (YYYY-MM-DD). */
  startTime?: string | null;
  bidAmount: number | null;
  /** Meta: LOWEST_COST_WITHOUT_CAP | LOWEST_COST_WITH_BID_CAP | COST_CAP | LOWEST_COST_WITH_MIN_ROAS, on the object that carries it; Google: the bidding strategy type. */
  bidStrategy?: string | null;
  /** Cost per result aimed at (Meta: bid_amount under COST_CAP; Google: target CPA), minor units. */
  targetCpa?: number | null;
  /** ROAS aimed at (Meta: ROAS floor; Google: target ROAS), as a ratio (3.5 = 350 %). */
  targetRoas?: number | null;
  /** Meta campaign: spend_cap, minor units. */
  spendCap?: number | null;
  /** Why the bidding targets of this object cannot be changed here; null when they can. */
  strategyLock?: string | null;
  /** A negative keyword (Google Ads, on a campaign): only removed, never paused nor bid on. */
  negative?: boolean;
  /** Meta ad set: the targeting spec as JSON, read when the object is read alone. */
  targeting?: string | null;
  parentName: string;
  /** Why the budget of this object cannot be changed here (a shared Google Ads budget); null when it can. */
  budgetLock?: string | null;
  /** Why the end date of this object cannot be changed here; null when it can. */
  endTimeLock?: string | null;
}

export type PilotValue = string | number | null;

export interface PreparedOperation {
  kind: PilotKind;
  objectType: PilotObjectType;
  objectId: string;
  objectName: string;
  parentName: string;
  /** Platform field written. */
  field: string;
  before: PilotValue;
  after: PilotValue;
  /** Why this one asks for a second confirmation; null when it does not. */
  double: string | null;
  /** Said in the preview: what cannot be put back afterwards. */
  irreversible: boolean;
}

export type Prepared = { ok: true; op: PreparedOperation } | { ok: false; error: string };

const ZERO_DECIMAL = new Set(["JPY", "KRW", "CLP", "COP", "CRC", "HUF", "ISK", "IDR", "PYG", "TWD", "VND"]);

/** Minor units per unit of the currency, as Meta counts budgets and bids. */
export const currencyOffset = (currency: string) => (ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100);

export const OBJECT_FR: Record<PilotObjectType, string> = { campaign: "Campagne", adset: "Ensemble de publicités", ad: "Annonce", keyword: "Mot-clé" };
const OBJECT_FR_GOOGLE: Record<PilotObjectType, string> = { campaign: "Campagne", adset: "Groupe d'annonces", ad: "Annonce", keyword: "Mot-clé" };
const OBJECT_FR_LOWER: Record<PilotObjectType, string> = { campaign: "la campagne", adset: "l'ensemble de publicités", ad: "l'annonce", keyword: "le mot-clé" };
const OBJECT_FR_LOWER_GOOGLE: Record<PilotObjectType, string> = { campaign: "la campagne", adset: "le groupe d'annonces", ad: "l'annonce", keyword: "le mot-clé" };

/** « Campagne », « Ensemble de publicités » (Meta) or « Groupe d'annonces » (Google Ads). */
export const objectLabel = (platform: string, type: string) =>
  (platform === "google" ? OBJECT_FR_GOOGLE : OBJECT_FR)[type as PilotObjectType] ?? type;
const objectLower = (platform: string, type: PilotObjectType) => (platform === "google" ? OBJECT_FR_LOWER_GOOGLE : OBJECT_FR_LOWER)[type];
const STATUS_FR: Record<string, string> = { ACTIVE: "active", PAUSED: "en pause", DELETED: "supprimée", ARCHIVED: "archivée" };

export const statusText = (status: string) => STATUS_FR[status] ?? status.toLowerCase();

export function money(minor: number | null | undefined, currency: string): string {
  if (minor === null || minor === undefined) return "—";
  const value = minor / currencyOffset(currency);
  try {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: value % 1 ? 2 : 0 }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

export function dateText(iso: string | null | undefined): string {
  if (!iso) return "aucune";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const isId = (id: unknown): id is string => typeof id === "string" && /^\d{5,25}$/.test(id);
/** A keyword is named by its ad group (or campaign, negative) and its criterion: « 123~456 ». */
export const isKeywordId = (id: unknown): id is string => typeof id === "string" && /^\d{1,25}~\d{1,25}$/.test(id);

/** YYYY-MM-DD of an instant in Paris (Google Ads dates are days). */
export const parisDayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** Reads a request sent by the page; null when it is not one. */
export function readRequest(raw: unknown): PilotRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!PILOT_KINDS.includes(r.kind as PilotKind)) return null;
  const objectType = r.objectType as PilotObjectType;
  if (objectType !== "campaign" && objectType !== "adset" && objectType !== "ad" && objectType !== "keyword") return null;
  if (objectType === "keyword" ? !isKeywordId(r.objectId) : !isId(r.objectId)) return null;
  if (typeof r.value !== "string" && typeof r.value !== "number") return null;
  return { kind: r.kind as PilotKind, objectType, objectId: r.objectId as string, value: r.value };
}

function amountOf(value: string | number): number | null {
  const n = typeof value === "number" ? value : Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Why a budget change asks for a second confirmation, or null. */
export function budgetDouble(before: number, after: number, currency: string): string | null {
  if (after <= before) return null;
  const offset = currencyOffset(currency);
  if (before <= 0 || after > before * DOUBLE_RAISE_RATIO) {
    const pct = before > 0 ? Math.round((after / before - 1) * 100) : null;
    return `hausse de budget de plus de 50 %${pct !== null ? ` (+${pct} %)` : ""}`;
  }
  if ((after - before) / offset > DOUBLE_RAISE_ABSOLUTE) return `hausse de budget de plus de ${DOUBLE_RAISE_ABSOLUTE} ${currency} (+${money(after - before, currency)})`;
  return null;
}

/** Why a change asks for a second confirmation, read on its values; null when it does not. */
export function doubleReason(op: { objectType: string; field: string; before: PilotValue; after: PilotValue }, currency: string): string | null {
  if (op.field === "status") {
    if (op.after === "DELETED") return "suppression";
    if (op.objectType === "campaign" && op.after === "PAUSED") return "arrêt d'une campagne entière";
    return null;
  }
  if (op.field === "daily_budget" || op.field === "lifetime_budget") return budgetDouble(Number(op.before) || 0, Number(op.after) || 0, currency);
  return null;
}

/**
 * The change asked, against the object as it is now. Refused (with the reason,
 * in French) when it would do nothing, or cannot be done on this object.
 */
export function prepareOperation(req: PilotRequest, state: PilotObjectState, currency: string, now: Date = new Date(), platform: PilotPlatform = "meta"): Prepared {
  const base = { kind: req.kind, objectType: req.objectType, objectId: req.objectId, objectName: state.name, parentName: state.parentName };
  const label = `${objectLower(platform, req.objectType)} « ${state.name} »`;
  if (state.type !== req.objectType) return { ok: false, error: `L'objet ${req.objectId} n'est pas ${objectLower(platform, req.objectType)} : rechargez la page.` };
  if (platform === "google" && req.objectType === "ad") return { ok: false, error: "Les annonces Google Ads ne se modifient pas encore ici : changez leur groupe d'annonces ou leur campagne." };
  if (req.objectType === "keyword") {
    if (platform !== "google") return { ok: false, error: "Les mots-clés n'existent que sur Google Ads." };
    if (req.kind !== "set_status" && req.kind !== "set_bid_amount") return { ok: false, error: `Un mot-clé se met en pause, s'active, change d'enchère ou se supprime : rien d'autre.` };
    if (state.negative && (req.kind !== "set_status" || String(req.value).toUpperCase() !== "DELETED")) return { ok: false, error: `${label} est un mot-clé négatif : il se supprime, c'est tout.` };
  }
  if (state.status === "DELETED" || state.status === "ARCHIVED") return { ok: false, error: `${label} est ${statusText(state.status)} : elle ne peut plus être modifiée.` };
  const offset = currencyOffset(currency);

  switch (req.kind) {
    case "set_status": {
      const value = String(req.value).toUpperCase();
      if (value !== "ACTIVE" && value !== "PAUSED" && value !== "DELETED") return { ok: false, error: `Statut inconnu pour ${label}.` };
      if (value === state.status) return { ok: false, error: `${label} est déjà ${statusText(value)}.` };
      const double = doubleReason({ objectType: req.objectType, field: "status", before: state.status, after: value }, currency);
      return { ok: true, op: { ...base, field: "status", before: state.status, after: value, double, irreversible: value === "DELETED" } };
    }
    case "set_daily_budget":
    case "set_lifetime_budget": {
      if (req.objectType === "ad") return { ok: false, error: "Une annonce n'a pas de budget : changez celui de son ensemble ou de sa campagne." };
      if (state.budgetLock) return { ok: false, error: `${label} : ${state.budgetLock}` };
      const daily = req.kind === "set_daily_budget";
      const before = daily ? state.dailyBudget : state.lifetimeBudget;
      if (!before) {
        const other = daily ? state.lifetimeBudget : state.dailyBudget;
        return {
          ok: false,
          error: other
            ? `${label} a un budget ${daily ? "total" : "journalier"}, pas ${daily ? "journalier" : "total"}.`
            : `${label} n'a pas de budget à ce niveau : il est porté par ${req.objectType === "campaign" ? "ses ensembles de publicités" : "sa campagne"}.`,
        };
      }
      const amount = amountOf(req.value);
      if (amount === null) return { ok: false, error: `Montant invalide pour ${label}.` };
      const after = Math.round(amount * offset);
      if (after < offset) return { ok: false, error: `Budget trop faible pour ${label}.` };
      if (after === before) return { ok: false, error: `${label} a déjà ce budget.` };
      return { ok: true, op: { ...base, field: daily ? "daily_budget" : "lifetime_budget", before, after, double: budgetDouble(before, after, currency), irreversible: false } };
    }
    case "set_end_time": {
      if (req.objectType === "ad") return { ok: false, error: "Une annonce n'a pas de date de fin : changez celle de son ensemble." };
      if (state.endTimeLock) return { ok: false, error: `${label} : ${state.endTimeLock}` };
      const when = new Date(String(req.value));
      if (Number.isNaN(when.getTime())) return { ok: false, error: `Date de fin invalide pour ${label}.` };
      if (when.getTime() <= now.getTime() + 60 * 60 * 1000) return { ok: false, error: `La date de fin de ${label} doit être dans plus d'une heure.` };
      if (platform === "google") {
        const day = parisDayOf(when);
        if (state.endTime === day) return { ok: false, error: `${label} a déjà cette date de fin.` };
        if (state.startTime && day < state.startTime) return { ok: false, error: `La date de fin de ${label} est avant sa date de début (${state.startTime}).` };
        return { ok: true, op: { ...base, field: "end_date", before: state.endTime, after: day, double: null, irreversible: false } };
      }
      const after = when.toISOString();
      if (state.endTime && new Date(state.endTime).getTime() === when.getTime()) return { ok: false, error: `${label} a déjà cette date de fin.` };
      return { ok: true, op: { ...base, field: req.objectType === "campaign" ? "stop_time" : "end_time", before: state.endTime, after, double: null, irreversible: false } };
    }
    case "set_bid_amount": {
      if (req.objectType !== "adset" && req.objectType !== "keyword") return { ok: false, error: `L'enchère se règle sur ${platform === "google" ? "un groupe d'annonces ou un mot-clé" : "un ensemble de publicités"}.` };
      if (!state.bidAmount && req.objectType !== "keyword") return { ok: false, error: `${label} n'a pas d'enchère manuelle (stratégie automatique) : rien à changer ici.` };
      if (state.strategyLock && req.objectType === "keyword") return { ok: false, error: `${label} : ${state.strategyLock}` };
      const amount = amountOf(req.value);
      if (amount === null) return { ok: false, error: `Montant d'enchère invalide pour ${label}.` };
      const after = Math.round(amount * offset);
      if (after === state.bidAmount) return { ok: false, error: `${label} a déjà cette enchère.` };
      return { ok: true, op: { ...base, field: "bid_amount", before: state.bidAmount, after, double: null, irreversible: false } };
    }
    case "set_targeting": {
      if (platform !== "meta" || req.objectType !== "adset") return { ok: false, error: "Le ciblage se règle sur un ensemble de publicités Meta." };
      const read = readTargeting(req.value);
      if (!read.ok) return { ok: false, error: `${label} : ${read.error}` };
      const after = JSON.stringify(read.targeting);
      if (state.targeting && canonicalTargeting(state.targeting) === canonicalTargeting(after)) return { ok: false, error: `${label} a déjà ce ciblage.` };
      return { ok: true, op: { ...base, field: "targeting", before: state.targeting ?? null, after, double: null, irreversible: false } };
    }
    case "add_keyword":
    case "add_negative_keyword": {
      const negative = req.kind === "add_negative_keyword";
      if (platform !== "google") return { ok: false, error: "Les mots-clés n'existent que sur Google Ads." };
      if (negative ? req.objectType !== "campaign" : req.objectType !== "adset") return { ok: false, error: negative ? "Un mot-clé négatif s'ajoute sur une campagne." : "Un mot-clé s'ajoute dans un groupe d'annonces." };
      const read = readKeyword(req.value);
      if (!read.ok) return { ok: false, error: read.error };
      return { ok: true, op: { ...base, field: negative ? "new_negative" : "new_keyword", before: null, after: JSON.stringify(read.spec), double: null, irreversible: false } };
    }
    case "create_ad": {
      if (platform !== "meta") return { ok: false, error: "La création de publicité n'existe que pour Meta pour le moment." };
      if (req.objectType !== "adset") return { ok: false, error: "Une publicité se crée dans un ensemble de publicités." };
      const read = readNewAd(req.value);
      if (!read.ok) return { ok: false, error: read.error };
      // Created PAUSED: nothing is spent before the consultant activates it, so no second confirmation.
      return { ok: true, op: { ...base, field: "new_ad", before: null, after: JSON.stringify(read.spec), double: null, irreversible: false } };
    }
    case "set_start_time": {
      if (req.objectType === "ad") return { ok: false, error: "Une annonce n'a pas de date de début : changez celle de son ensemble." };
      if (platform === "google" && req.objectType === "adset") return { ok: false, error: "Un groupe d'annonces n'a pas de date de début : changez celle de sa campagne." };
      const when = new Date(String(req.value));
      if (Number.isNaN(when.getTime())) return { ok: false, error: `Date de début invalide pour ${label}.` };
      if (when.getTime() <= now.getTime() + 60 * 60 * 1000) return { ok: false, error: `La date de début de ${label} doit être dans plus d'une heure.` };
      if (platform === "google") {
        const day = parisDayOf(when);
        if (state.startTime && state.startTime <= parisDayOf(now)) return { ok: false, error: `${label} a déjà commencé : Google Ads ne change plus sa date de début.` };
        if (state.startTime === day) return { ok: false, error: `${label} a déjà cette date de début.` };
        return { ok: true, op: { ...base, field: "start_date", before: state.startTime ?? null, after: day, double: null, irreversible: false } };
      }
      const after = when.toISOString();
      if (state.startTime && new Date(state.startTime).getTime() === when.getTime()) return { ok: false, error: `${label} a déjà cette date de début.` };
      return { ok: true, op: { ...base, field: "start_time", before: state.startTime ?? null, after, double: null, irreversible: false } };
    }
    case "set_spend_cap": {
      if (platform !== "meta" || req.objectType !== "campaign") return { ok: false, error: "Le plafond de dépense se règle sur une campagne Meta." };
      const amount = amountOf(req.value);
      if (amount === null) return { ok: false, error: `Plafond invalide pour ${label}.` };
      const after = Math.round(amount * offset);
      if (after < offset * 100) return { ok: false, error: `Plafond trop faible pour ${label} (100 ${currency} au moins).` };
      if (after === (state.spendCap ?? null)) return { ok: false, error: `${label} a déjà ce plafond.` };
      return { ok: true, op: { ...base, field: "spend_cap", before: state.spendCap ?? null, after, double: null, irreversible: false } };
    }
    case "set_target_cpa": {
      if (req.objectType === "ad") return { ok: false, error: "Le coût cible se règle sur une campagne ou un ensemble, pas sur une annonce." };
      if (state.strategyLock) return { ok: false, error: `${label} : ${state.strategyLock}` };
      if (platform === "meta" && !state.bidStrategy) return { ok: false, error: `${label} ne porte pas la stratégie d'enchère (elle est sur ${req.objectType === "adset" ? "sa campagne, budget centralisé" : "ses ensembles"}).` };
      const amount = amountOf(req.value);
      if (amount === null) return { ok: false, error: `Coût cible invalide pour ${label}.` };
      const after = Math.round(amount * offset);
      if (after < 1) return { ok: false, error: `Coût cible trop faible pour ${label}.` };
      if (after === (state.targetCpa ?? null)) return { ok: false, error: `${label} a déjà ce coût cible.` };
      return { ok: true, op: { ...base, field: platform === "google" ? "target_cpa" : "cost_cap", before: state.targetCpa ?? null, after, double: null, irreversible: false } };
    }
    case "set_target_roas": {
      if (req.objectType === "ad") return { ok: false, error: "Le ROAS cible se règle sur une campagne ou un ensemble, pas sur une annonce." };
      if (state.strategyLock) return { ok: false, error: `${label} : ${state.strategyLock}` };
      if (platform === "meta" && !state.bidStrategy) return { ok: false, error: `${label} ne porte pas la stratégie d'enchère (elle est sur ${req.objectType === "adset" ? "sa campagne, budget centralisé" : "ses ensembles"}).` };
      const ratio = amountOf(req.value);
      if (ratio === null || ratio > 1000) return { ok: false, error: `ROAS cible invalide pour ${label} (un multiplicateur : 3 = 300 %).` };
      const after = Math.round(ratio * 100) / 100;
      if (after === (state.targetRoas ?? null)) return { ok: false, error: `${label} a déjà ce ROAS cible.` };
      return { ok: true, op: { ...base, field: platform === "google" ? "target_roas" : "roas_floor", before: state.targetRoas ?? null, after, double: null, irreversible: false } };
    }
    case "set_bid_strategy": {
      if (platform !== "meta") return { ok: false, error: "La stratégie d'enchère Google Ads se change dans Google Ads pour le moment." };
      if (req.objectType === "ad") return { ok: false, error: "La stratégie d'enchère se règle sur une campagne ou un ensemble." };
      if (!state.bidStrategy) return { ok: false, error: `${label} ne porte pas la stratégie d'enchère.` };
      const value = String(req.value).toUpperCase() === "AUTO" ? "LOWEST_COST_WITHOUT_CAP" : String(req.value).toUpperCase();
      if (value !== "LOWEST_COST_WITHOUT_CAP") return { ok: false, error: "Seul le retour à l'enchère automatique (« AUTO ») se fait ici : un plafond se règle par le coût cible ou le ROAS cible." };
      if (value === state.bidStrategy) return { ok: false, error: `${label} est déjà en enchère automatique.` };
      return { ok: true, op: { ...base, field: "bid_strategy", before: state.bidStrategy, after: value, double: null, irreversible: false } };
    }
    case "duplicate": {
      if (platform !== "meta") return { ok: false, error: "La duplication n'existe que pour Meta pour le moment." };
      const read = readCopy(req.value);
      if (!read.ok) return { ok: false, error: read.error };
      if (read.spec.name === state.name) return { ok: false, error: `Donnez un autre nom que « ${state.name} » à la copie.` };
      // Created PAUSED: nothing is spent before the consultant activates it.
      return { ok: true, op: { ...base, field: "copy", before: null, after: JSON.stringify(read.spec), double: null, irreversible: false } };
    }
    case "rename": {
      const name = String(req.value).replace(/\s+/g, " ").trim();
      if (!name || name.length > 400) return { ok: false, error: `Nom invalide pour ${label}.` };
      if (name === state.name) return { ok: false, error: `${label} porte déjà ce nom.` };
      return { ok: true, op: { ...base, field: "name", before: state.name, after: name, double: null, irreversible: false } };
    }
  }
}

/** What a write of `field` puts back on the platform, as the re-read gives it. */
export function stateValue(state: PilotObjectState, field: string): PilotValue {
  switch (field) {
    case "status": return state.status;
    case "daily_budget": return state.dailyBudget;
    case "lifetime_budget": return state.lifetimeBudget;
    case "end_time":
    case "stop_time":
    case "end_date": return state.endTime;
    case "start_time":
    case "start_date": return state.startTime ?? null;
    case "bid_amount": return state.bidAmount;
    case "cost_cap":
    case "target_cpa": return state.targetCpa ?? null;
    case "roas_floor":
    case "target_roas": return state.targetRoas ?? null;
    case "bid_strategy": return state.bidStrategy ?? null;
    case "spend_cap": return state.spendCap ?? null;
    case "targeting": return state.targeting ?? null;
    case "name": return state.name;
    default: return null;
  }
}

/** The same value for the platform: dates compared as instants, the rest as they are. */
export function sameValue(field: string, a: PilotValue, b: PilotValue): boolean {
  if (a === null || b === null) return a === b;
  if (field === "end_time" || field === "stop_time" || field === "start_time") return new Date(String(a)).getTime() === new Date(String(b)).getTime();
  if (field === "targeting") return canonicalTargeting(a) === canonicalTargeting(b);
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return a === b;
}

/** The request that puts an operation back; null when nothing can (a deletion, a date that did not exist). */
export function inverseRequest(op: { kind: string; objectType: string; objectId: string; field: string; before: PilotValue; after: PilotValue }, currency: string): PilotRequest | null {
  // A new ad is not « put back »: it is created paused, and deleted from the tree if it must go.
  if (op.field === "new_ad" || op.field === "copy" || op.field === "new_keyword" || op.field === "new_negative" || op.before === null || op.after === "DELETED") return null;
  const kind = op.kind as PilotKind;
  const objectType = op.objectType as PilotObjectType;
  if (op.field === "daily_budget" || op.field === "lifetime_budget" || op.field === "bid_amount" || op.field === "cost_cap" || op.field === "target_cpa" || op.field === "spend_cap") {
    return { kind, objectType, objectId: op.objectId, value: Number(op.before) / currencyOffset(currency) };
  }
  // Putting a cap back after a return to automatic bidding is a cost cap again (same object, same value).
  if (op.field === "bid_strategy") return op.before === "LOWEST_COST_WITHOUT_CAP" ? { kind: "set_bid_strategy", objectType, objectId: op.objectId, value: "AUTO" } : null;
  return { kind, objectType, objectId: op.objectId, value: op.before };
}

const ICON: Record<PilotKind, string> = {
  set_status: "⏯",
  set_daily_budget: "💶",
  set_lifetime_budget: "💶",
  set_end_time: "📅",
  set_start_time: "📅",
  set_bid_amount: "🎯",
  set_target_cpa: "🎯",
  set_target_roas: "🎯",
  set_bid_strategy: "🎯",
  set_spend_cap: "💶",
  rename: "✏️",
  create_ad: "🆕",
  duplicate: "📋",
  add_keyword: "🔑",
  add_negative_keyword: "🚫",
  set_targeting: "🎯",
};

const parseTargeting = (v: PilotValue): Targeting | null => { try { const t = JSON.parse(String(v ?? "null")); return t && typeof t === "object" ? t : null; } catch { return null; } };

/** The text of a keyword of a "new_keyword" / "new_negative" operation. */
export function newKeywordText(value: PilotValue): string {
  const read = readKeyword(value);
  return read.ok ? keywordText(read.spec) : "mot-clé";
}

/** The name of the copy of a "copy" operation. */
export function copyName(value: PilotValue): string {
  const read = readCopy(value);
  return read.ok ? read.spec.name : "copie";
}

const STRATEGY_FR: Record<string, string> = {
  LOWEST_COST_WITHOUT_CAP: "enchère automatique",
  LOWEST_COST_WITH_BID_CAP: "plafond d'enchère",
  COST_CAP: "coût cible",
  LOWEST_COST_WITH_MIN_ROAS: "ROAS minimum",
};
export const strategyText = (v: string) => STRATEGY_FR[v] ?? v.toLowerCase().replace(/_/g, " ");

/** The name of the new ad of a "new_ad" operation. */
export function newAdName(value: PilotValue): string {
  const read = readNewAd(value);
  return read.ok ? read.spec.name : "publicité";
}

function valueText(field: string, value: PilotValue, currency: string): string {
  if (field === "new_ad") return value === null ? "—" : `« ${newAdName(value)} » (créée en pause)`;
  if (field === "copy") return value === null ? "—" : `« ${copyName(value)} » (créée en pause)`;
  if (field === "new_keyword" || field === "new_negative") return value === null ? "—" : newKeywordText(value);
  if (field === "targeting") return value === null ? "—" : "ciblage";
  if (value === null) return field === "end_time" || field === "stop_time" || field === "end_date" || field === "start_time" || field === "start_date" || field === "spend_cap" ? "aucune" : "—";
  switch (field) {
    case "status": return statusText(String(value));
    case "daily_budget": return `${money(Number(value), currency)}/jour`;
    case "lifetime_budget":
    case "bid_amount":
    case "cost_cap":
    case "target_cpa":
    case "spend_cap": return money(Number(value), currency);
    case "roas_floor":
    case "target_roas": return `${Number(value)}×`;
    case "bid_strategy": return strategyText(String(value));
    case "end_time":
    case "stop_time":
    case "start_time": return dateText(String(value));
    case "end_date":
    case "start_date": return `${String(value).slice(8, 10)}/${String(value).slice(5, 7)}/${String(value).slice(0, 4)}`;
    case "name": return `« ${value} »`;
    default: return String(value);
  }
}

const FIELD_FR: Record<string, string> = {
  status: "statut",
  daily_budget: "budget journalier",
  lifetime_budget: "budget total",
  end_time: "date de fin",
  stop_time: "date de fin",
  end_date: "date de fin",
  start_time: "date de début",
  start_date: "date de début",
  bid_amount: "enchère",
  cost_cap: "coût cible (cost cap)",
  target_cpa: "CPA cible",
  roas_floor: "ROAS minimum",
  target_roas: "ROAS cible",
  bid_strategy: "stratégie d'enchère",
  spend_cap: "plafond de dépense",
  name: "nom",
  new_ad: "nouvelle publicité",
  copy: "copie",
  new_keyword: "nouveau mot-clé",
  new_negative: "nouveau mot-clé négatif",
  targeting: "ciblage",
};

/** One line, the same in the preview, the journal and HQ: what, on which object, before → after. */
export function describeOperation(
  op: { kind: string; objectType: string; objectName: string; parentName?: string; field: string; before: PilotValue; after: PilotValue },
  currency: string,
  platform: string = "meta",
): string {
  const icon = op.kind === "set_status" ? (op.after === "PAUSED" ? "⏸" : op.after === "ACTIVE" ? "▶️" : "🗑") : ICON[op.kind as PilotKind] ?? "•";
  const object = `${objectLabel(platform, op.objectType)} « ${op.objectName} »${op.parentName ? ` (${op.parentName})` : ""}`;
  if (op.field === "new_ad") return `${icon} ${object} — nouvelle publicité ${valueText(op.field, op.after, currency)}`;
  if (op.field === "copy") return `${icon} ${object} — dupliqué en ${valueText(op.field, op.after, currency)}`;
  if (op.field === "targeting") {
    const after = parseTargeting(op.after);
    const lines = after ? targetingDiff(parseTargeting(op.before), after) : ["ciblage modifié"];
    return `${icon} ${object} — ciblage : ${lines.join(" ; ")}`;
  }
  if (op.field === "new_keyword") return `${icon} ${object} — mot-clé ajouté ${valueText(op.field, op.after, currency)}`;
  if (op.field === "new_negative") return `${icon} ${object} — mot-clé négatif ajouté ${valueText(op.field, op.after, currency)}`;
  return `${icon} ${object} — ${FIELD_FR[op.field] ?? op.field} : ${valueText(op.field, op.before, currency)} → ${valueText(op.field, op.after, currency)}`;
}

export const GOAL_METRICS = ["cpa", "roas", "spend", "conversions", "ctr", "cpm", "cpc", "other"] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];
export const GOAL_METRIC_FR: Record<GoalMetric, string> = {
  cpa: "CPA", roas: "ROAS", spend: "Dépense", conversions: "Conversions", ctr: "CTR", cpm: "CPM", cpc: "CPC", other: "Autre",
};

export interface PilotGoal { metric: GoalMetric | null; target: number | null; note: string }

export function readGoal(raw: unknown): PilotGoal {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const metric = GOAL_METRICS.includes(r.metric as GoalMetric) ? (r.metric as GoalMetric) : null;
  const t = typeof r.target === "number" ? r.target : typeof r.target === "string" && r.target.trim() ? Number(r.target.replace(",", ".")) : NaN;
  return { metric, target: Number.isFinite(t) ? t : null, note: typeof r.note === "string" ? r.note.trim().slice(0, 500) : "" };
}

export function goalText(goal: PilotGoal): string {
  const parts = [
    goal.metric ? `${GOAL_METRIC_FR[goal.metric]}${goal.target !== null ? ` visé : ${goal.target}` : ""}` : "",
    goal.note,
  ].filter(Boolean);
  return parts.join(" — ");
}
