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

export const PILOT_PLATFORMS = ["meta", "google"] as const;
export type PilotPlatform = (typeof PILOT_PLATFORMS)[number];
export const isPilotPlatform = (v: unknown): v is PilotPlatform => v === "meta" || v === "google";
export const PLATFORM_FR: Record<string, string> = { meta: "Meta", google: "Google Ads", tiktok: "TikTok Ads" };
export type PilotObjectType = "campaign" | "adset" | "ad";
export type PilotStatus = "ACTIVE" | "PAUSED" | "DELETED";

export const PILOT_KINDS = ["set_status", "set_daily_budget", "set_lifetime_budget", "set_end_time", "set_bid_amount", "rename", "create_ad"] as const;
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
  /** Campaign: stop_time; ad set: end_time. */
  endTime: string | null;
  bidAmount: number | null;
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

export const OBJECT_FR: Record<PilotObjectType, string> = { campaign: "Campagne", adset: "Ensemble de publicités", ad: "Annonce" };
const OBJECT_FR_GOOGLE: Record<PilotObjectType, string> = { campaign: "Campagne", adset: "Groupe d'annonces", ad: "Annonce" };
const OBJECT_FR_LOWER: Record<PilotObjectType, string> = { campaign: "la campagne", adset: "l'ensemble de publicités", ad: "l'annonce" };
const OBJECT_FR_LOWER_GOOGLE: Record<PilotObjectType, string> = { campaign: "la campagne", adset: "le groupe d'annonces", ad: "l'annonce" };

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

/** Reads a request sent by the page; null when it is not one. */
export function readRequest(raw: unknown): PilotRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!PILOT_KINDS.includes(r.kind as PilotKind)) return null;
  if (r.objectType !== "campaign" && r.objectType !== "adset" && r.objectType !== "ad") return null;
  if (!isId(r.objectId)) return null;
  if (typeof r.value !== "string" && typeof r.value !== "number") return null;
  return { kind: r.kind as PilotKind, objectType: r.objectType, objectId: r.objectId, value: r.value };
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
      const after = when.toISOString();
      if (state.endTime && new Date(state.endTime).getTime() === when.getTime()) return { ok: false, error: `${label} a déjà cette date de fin.` };
      return { ok: true, op: { ...base, field: req.objectType === "campaign" ? "stop_time" : "end_time", before: state.endTime, after, double: null, irreversible: false } };
    }
    case "set_bid_amount": {
      if (req.objectType !== "adset") return { ok: false, error: `L'enchère se règle sur ${platform === "google" ? "un groupe d'annonces" : "un ensemble de publicités"}.` };
      if (!state.bidAmount) return { ok: false, error: `${label} n'a pas d'enchère manuelle (stratégie automatique) : rien à changer ici.` };
      const amount = amountOf(req.value);
      if (amount === null) return { ok: false, error: `Montant d'enchère invalide pour ${label}.` };
      const after = Math.round(amount * offset);
      if (after === state.bidAmount) return { ok: false, error: `${label} a déjà cette enchère.` };
      return { ok: true, op: { ...base, field: "bid_amount", before: state.bidAmount, after, double: null, irreversible: false } };
    }
    case "create_ad": {
      if (platform !== "meta") return { ok: false, error: "La création de publicité n'existe que pour Meta pour le moment." };
      if (req.objectType !== "adset") return { ok: false, error: "Une publicité se crée dans un ensemble de publicités." };
      const read = readNewAd(req.value);
      if (!read.ok) return { ok: false, error: read.error };
      // Created PAUSED: nothing is spent before the consultant activates it, so no second confirmation.
      return { ok: true, op: { ...base, field: "new_ad", before: null, after: JSON.stringify(read.spec), double: null, irreversible: false } };
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
    case "stop_time": return state.endTime;
    case "bid_amount": return state.bidAmount;
    case "name": return state.name;
    default: return null;
  }
}

/** The same value for the platform: dates compared as instants, the rest as they are. */
export function sameValue(field: string, a: PilotValue, b: PilotValue): boolean {
  if (a === null || b === null) return a === b;
  if (field === "end_time" || field === "stop_time") return new Date(String(a)).getTime() === new Date(String(b)).getTime();
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return a === b;
}

/** The request that puts an operation back; null when nothing can (a deletion, a date that did not exist). */
export function inverseRequest(op: { kind: string; objectType: string; objectId: string; field: string; before: PilotValue; after: PilotValue }, currency: string): PilotRequest | null {
  // A new ad is not « put back »: it is created paused, and deleted from the tree if it must go.
  if (op.field === "new_ad" || op.before === null || op.after === "DELETED") return null;
  const kind = op.kind as PilotKind;
  const objectType = op.objectType as PilotObjectType;
  if (op.field === "daily_budget" || op.field === "lifetime_budget" || op.field === "bid_amount") {
    return { kind, objectType, objectId: op.objectId, value: Number(op.before) / currencyOffset(currency) };
  }
  return { kind, objectType, objectId: op.objectId, value: op.before };
}

const ICON: Record<PilotKind, string> = {
  set_status: "⏯",
  set_daily_budget: "💶",
  set_lifetime_budget: "💶",
  set_end_time: "📅",
  set_bid_amount: "🎯",
  rename: "✏️",
  create_ad: "🆕",
};

/** The name of the new ad of a "new_ad" operation. */
export function newAdName(value: PilotValue): string {
  const read = readNewAd(value);
  return read.ok ? read.spec.name : "publicité";
}

function valueText(field: string, value: PilotValue, currency: string): string {
  if (field === "new_ad") return value === null ? "—" : `« ${newAdName(value)} » (créée en pause)`;
  if (value === null) return field === "end_time" || field === "stop_time" ? "aucune" : "—";
  switch (field) {
    case "status": return statusText(String(value));
    case "daily_budget": return `${money(Number(value), currency)}/jour`;
    case "lifetime_budget":
    case "bid_amount": return money(Number(value), currency);
    case "end_time":
    case "stop_time": return dateText(String(value));
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
  bid_amount: "enchère",
  name: "nom",
  new_ad: "nouvelle publicité",
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
