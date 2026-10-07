/**
 * Pilotage — the changes made on an ad account as the platform's own log
 * tells them, whoever made them: Meta « activities », Google Ads
 * « change_event ». Each entry of those logs is turned into one or more
 * PlatformChange rows (one per field) that the page, the J+7 / J+14 analyses
 * and HQ read the same way as a Pilotage operation: object, field, value
 * before, value after, one line in French.
 *
 * Meta's log keeps the legacy names: CAMPAIGN_GROUP is a campaign, CAMPAIGN an
 * ad set, ADGROUP an ad. Budgets come in minor units (centimes), as Pilotage
 * stores them. Google gives the old and the new resource with the changed
 * fields; budgets are in micros, converted to minor units here.
 *
 * Pure: no network, no database.
 */

import { createHash } from "node:crypto";
import { money, objectLabel, statusText, type PilotValue } from "@/lib/pilot/ops";

export type ChangeObjectType = "campaign" | "adset" | "ad" | "account" | "other";
export type ChangeSource = "impulsemotion" | "external" | "automated";
export type ChangeField =
  | "daily_budget" | "lifetime_budget" | "budget" | "status" | "name" | "bid" | "bid_strategy" | "targeting" | "schedule"
  | "optimization" | "spend_cap" | "creative" | "keyword" | "settings" | "created" | "deleted" | "other";

/** A change as it is stored (before the ids the database gives it). */
export interface ChangeDraft {
  platform: "meta" | "google";
  accountId: string;
  currency: string;
  externalId: string;
  at: Date;
  actorName: string;
  actorEmail: string | null;
  via: string;
  source: ChangeSource;
  objectType: ChangeObjectType;
  objectId: string;
  objectName: string;
  /** The campaign of an ad set or an ad, when the log says it. */
  campaignId: string | null;
  eventType: string;
  field: ChangeField;
  before: PilotValue;
  after: PilotValue;
  line: string;
  significant: boolean;
  raw: unknown;
}

/** Fields worth a J+7 / J+14 analysis: they move the delivery. A rename does not. */
export const SIGNIFICANT_FIELDS = new Set<ChangeField>([
  "daily_budget", "lifetime_budget", "budget", "status", "bid", "bid_strategy", "targeting", "schedule", "optimization", "spend_cap", "creative", "keyword", "settings", "deleted",
]);

export const FIELD_FR: Record<ChangeField, string> = {
  daily_budget: "budget journalier",
  lifetime_budget: "budget total",
  budget: "budget",
  status: "statut",
  name: "nom",
  bid: "enchère",
  bid_strategy: "stratégie d'enchère",
  targeting: "ciblage",
  schedule: "dates / planification",
  optimization: "optimisation",
  spend_cap: "plafond de dépense",
  creative: "créa",
  keyword: "mots-clés",
  settings: "réglages",
  created: "création",
  deleted: "suppression",
  other: "autre réglage",
};

export const SOURCE_FR: Record<ChangeSource, string> = {
  impulsemotion: "ImpulseMotion",
  external: "hors ImpulseMotion",
  automated: "automatique",
};

const ICON: Record<ChangeField, string> = {
  daily_budget: "💶", lifetime_budget: "💶", budget: "💶", status: "⏯", name: "✏️", bid: "🎯", bid_strategy: "🎯", targeting: "🎯",
  schedule: "📅", optimization: "⚙️", spend_cap: "💶", creative: "🖼", keyword: "🔑", settings: "⚙️", created: "🆕", deleted: "🗑", other: "•",
};

/**
 * Text as the database takes it: no NUL, no half of a surrogate pair (an
 * emoji cut in two by a fixed-length slice makes the whole batch unreadable
 * for the query engine), cut on whole code points.
 */
export function safeText(v: unknown, max = 100_000): string {
  const s = typeof v === "string" ? v : v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  const clean = s.replace(/\u0000/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "").replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1");
  if (clean.length <= max) return clean;
  const points = Array.from(clean);
  return `${points.slice(0, Math.max(0, max - 1)).join("")}…`;
}

const short = (v: unknown, max = 160): string => safeText(v, max);

/** The value as the line says it: a budget as money, a status in French, a date in Paris time, the rest as it is. */
export function changeValueText(field: ChangeField, value: PilotValue, currency: string): string {
  if (value === null || value === "") return "—";
  switch (field) {
    case "daily_budget": return `${money(Number(value), currency)}/jour`;
    case "lifetime_budget":
    case "budget":
    case "spend_cap":
    case "bid": return typeof value === "number" ? money(value, currency) : String(value);
    case "status": return String(value) === "PENDING_REVIEW" ? "en attente d'examen" : statusText(String(value));
    case "name": return `« ${value} »`;
    case "creative": return /https?:\/\//.test(String(value)) ? "visuel modifié" : short(value, 120);
    default: return short(value, 120);
  }
}

/** One line, the same in the page, the analyses and HQ. */
export function describeChange(c: Pick<ChangeDraft, "platform" | "objectType" | "objectName" | "field" | "before" | "after" | "currency" | "eventType">): string {
  const icon = c.field === "status" ? (String(c.after).toUpperCase() === "PAUSED" ? "⏸" : String(c.after).toUpperCase() === "ACTIVE" ? "▶️" : "⏯") : ICON[c.field];
  const object = c.objectType === "account" ? "Compte" : c.objectType === "other" ? "Objet" : objectLabel(c.platform, c.objectType);
  const name = c.objectName ? ` « ${c.objectName} »` : "";
  if (c.field === "created") return `${icon} ${object}${name} — créé(e)`;
  if (c.field === "deleted") return `${icon} ${object}${name} — supprimé(e)`;
  const label = FIELD_FR[c.field] + (c.field === "other" && c.eventType ? ` (${humanEvent(c.eventType)})` : "");
  if (c.before === null && c.after === null) return `${icon} ${object}${name} — ${label}`;
  return `${icon} ${object}${name} — ${label} : ${changeValueText(c.field, c.before, c.currency)} → ${changeValueText(c.field, c.after, c.currency)}`;
}

/** « update_ad_set_target_spec » → « update ad set target spec ». */
export const humanEvent = (eventType: string) => eventType.replace(/[_.]/g, " ").trim();

// ── Meta ─────────────────────────────────────────────────────────────────

export interface MetaActivity {
  event_type?: string;
  event_time?: string;
  object_type?: string;
  object_name?: string;
  object_id?: string;
  actor_name?: string;
  actor_id?: string;
  application_name?: string;
  application_id?: string;
  extra_data?: string;
}

/** Application names of ImpulseMotion's own Meta apps: a change through them was made from here. */
export function metaOwnApps(env: string | undefined = process.env.META_APP_NAMES): Set<string> {
  return new Set((env ?? "impulsemcplimite").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

const META_OBJECT: Record<string, ChangeObjectType> = {
  CAMPAIGN_GROUP: "campaign", CAMPAIGN: "adset", ADGROUP: "ad", AD_ACCOUNT: "account", ACCOUNT: "account",
};

/** Events that say nothing a consultant changed: reviews, learning phase, billing, delivery states. */
const META_NOISE = /review|learning_stage|billing|funding|spend_limit_reached|budget_spent|_to_be_set_after|ad_account_add_user|ad_account_remove_user|add_images|edit_images|set_business_information|ad_account_billing|charge|decline|conversion_event|boost|first_delivery|delivery_event/i;
/** The platform itself as the actor: its own transitions (an ad approved, a delivery started) are not someone's change. */
const META_SELF = /^(meta|facebook|instagram)(\s+ads?)?$/i;

function metaField(eventType: string, extra: Record<string, unknown>): ChangeField {
  const e = eventType.toLowerCase();
  if (/^create_/.test(e)) return "created";
  if (/^delete_/.test(e)) return "deleted";
  if (/budget_optimization|delivery_type/.test(e)) return "settings";
  if (/budget/.test(e)) {
    const kind = String((extra.new_value as Record<string, unknown> | undefined)?.additional_value ?? (extra.old_value as Record<string, unknown> | undefined)?.additional_value ?? "");
    if (/jour|daily|day|täglich|diario/i.test(kind)) return "daily_budget";
    if (/total|lifetime|durée|vie/i.test(kind)) return "lifetime_budget";
    return "budget";
  }
  if (/run_status|stop_delivery|status$/.test(e)) return "status";
  if (/name$/.test(e)) return "name";
  if (/bid_strategy|bidding|bid_type/.test(e)) return "bid_strategy";
  if (/bid/.test(e)) return "bid";
  if (/target_spec|targets_spec|audience|keywords|placement|location/.test(e)) return "targeting";
  if (/duration|schedul|run_dates|start_time|end_time/.test(e)) return "schedule";
  if (/optimization_goal|optimization|min_spend_target/.test(e)) return "optimization";
  if (/spend_cap/.test(e)) return "spend_cap";
  if (/creative|image|video/.test(e)) return "creative";
  return "other";
}

const unwrap = (v: unknown, which: "old_value" | "new_value"): PilotValue => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const inner = o[which] ?? o.value ?? o.amount;
    if (inner !== undefined && inner !== null) return typeof inner === "number" ? inner : short(inner);
    return short(o, 200);
  }
  return typeof v === "number" ? v : short(v, 200);
};

/** Meta's run status strings (locale of the token's user) and codes, read as Pilotage statuses when they can be. */
function metaStatus(v: PilotValue): PilotValue {
  if (v === null) return null;
  const s = String(v).trim().toLowerCase();
  if (/^(actif|active|activ|en cours)$/.test(s)) return "ACTIVE";
  // « En attente de traitement » / « pending process »: the person set it active, Meta is still applying it.
  if (/attente de traitement|pending process|in process|processing/.test(s)) return "ACTIVE";
  if (/^(inactif|inactive|paused|en pause|pausiert)$/.test(s)) return "PAUSED";
  if (/^(supprim|deleted|archiv)/.test(s)) return "DELETED";
  if (/attente d.examen|pending review|in review|en révision/.test(s)) return "PENDING_REVIEW";
  return v;
}

/** The activity's time and content, hashed: Meta gives no id to an activity. */
export function metaActivityId(accountId: string, a: MetaActivity): string {
  const h = createHash("sha1").update([accountId, a.event_time, a.event_type, a.object_id, a.actor_id, a.extra_data ?? ""].join("|")).digest("hex").slice(0, 24);
  return `meta:${accountId}:${h}`;
}

export function fromMetaActivity(accountId: string, currency: string, a: MetaActivity, ownApps: Set<string> = metaOwnApps()): ChangeDraft | null {
  const eventType = String(a.event_type ?? "");
  const at = new Date(String(a.event_time ?? ""));
  if (!eventType || Number.isNaN(at.getTime()) || META_NOISE.test(eventType)) return null;
  let extra: Record<string, unknown> = {};
  // Ids come as bare numbers beyond 2^53 (campaign_id): quoted before parsing so no digit is lost.
  try { const parsed = JSON.parse((a.extra_data ?? "{}").replace(/:\s*(\d{16,})(?=\s*[,}\]])/g, ':"$1"')); if (parsed && typeof parsed === "object") extra = parsed; } catch { /* kept raw */ }
  const field = metaField(eventType, extra);
  const objectType = META_OBJECT[String(a.object_type ?? "").toUpperCase()] ?? "other";
  const actor = String(a.actor_name ?? "").trim();
  let before = field === "created" ? null : unwrap(extra.old_value, "old_value");
  let after = field === "deleted" ? null : unwrap(extra.new_value, "new_value");
  if (field === "status") {
    before = metaStatus(before); after = metaStatus(after);
    // Meta moving an ad through its review (pending → active) is not a change someone made; the same state twice says nothing.
    if (META_SELF.test(actor) || before === after || before === "PENDING_REVIEW" || after === "PENDING_REVIEW") return null;
  }
  if ((field === "daily_budget" || field === "lifetime_budget" || field === "budget") && typeof before !== "number" && typeof after !== "number") {
    // Not an amount (an « unlimited » marker, a schedule): said as text, not judged.
  }
  const budgetCurrency = String((extra.new_value as Record<string, unknown> | undefined)?.currency ?? (extra.old_value as Record<string, unknown> | undefined)?.currency ?? currency) || currency;
  const app = String(a.application_name ?? "").trim();
  const automated = /automat|règle|regle|rule|système|system/i.test(actor) || META_SELF.test(actor);
  const source: ChangeSource = ownApps.has(app.toLowerCase()) ? "impulsemotion" : automated ? "automated" : "external";
  const draft: ChangeDraft = {
    platform: "meta", accountId, currency: budgetCurrency,
    externalId: metaActivityId(accountId, a), at,
    actorName: actor || (source === "impulsemotion" ? "ImpulseMotion" : "inconnu"), actorEmail: null,
    via: app ? (source === "impulsemotion" ? "ImpulseMotion" : app) : "Gestionnaire de publicités",
    source,
    objectType, objectId: String(a.object_id ?? ""), objectName: String(a.object_name ?? ""),
    campaignId: extra.campaign_id !== undefined && extra.campaign_id !== null ? String(extra.campaign_id) : null,
    eventType, field, before, after, line: "", significant: SIGNIFICANT_FIELDS.has(field) && objectType !== "account",
    raw: extra,
  };
  draft.line = describeChange(draft);
  return draft;
}

// ── Google Ads ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const get = (o: Row, key: string): unknown => (o[key] !== undefined ? o[key] : o[camel(key)]);

const GOOGLE_RESOURCE: Record<string, { key: string; objectType: ChangeObjectType; field?: ChangeField }> = {
  CAMPAIGN: { key: "campaign", objectType: "campaign" },
  CAMPAIGN_BUDGET: { key: "campaignBudget", objectType: "campaign" },
  AD_GROUP: { key: "adGroup", objectType: "adset" },
  AD_GROUP_AD: { key: "adGroupAd", objectType: "ad", field: "creative" },
  AD_GROUP_CRITERION: { key: "adGroupCriterion", objectType: "adset", field: "keyword" },
  CAMPAIGN_CRITERION: { key: "campaignCriterion", objectType: "campaign", field: "targeting" },
  AD_GROUP_BID_MODIFIER: { key: "adGroupBidModifier", objectType: "adset", field: "bid" },
  CAMPAIGN_ASSET: { key: "campaignAsset", objectType: "campaign", field: "creative" },
  AD_GROUP_ASSET: { key: "adGroupAsset", objectType: "adset", field: "creative" },
  ASSET: { key: "asset", objectType: "other", field: "creative" },
  CAMPAIGN_ASSET_SET: { key: "campaignAssetSet", objectType: "campaign", field: "creative" },
  CUSTOMER_ASSET: { key: "customerAsset", objectType: "account", field: "creative" },
  FEED: { key: "feed", objectType: "other" },
  FEED_ITEM: { key: "feedItem", objectType: "other" },
  AD: { key: "ad", objectType: "ad", field: "creative" },
};

const GOOGLE_CLIENT_FR: Record<string, string> = {
  GOOGLE_ADS_WEB_CLIENT: "Google Ads (interface)",
  GOOGLE_ADS_API: "API Google Ads",
  GOOGLE_ADS_AUTOMATED_RULE: "règle automatique",
  GOOGLE_ADS_SCRIPTS: "script Google Ads",
  GOOGLE_ADS_EDITOR: "Google Ads Editor",
  GOOGLE_ADS_MOBILE_APP: "appli mobile Google Ads",
  GOOGLE_ADS_RECOMMENDATIONS: "recommandation appliquée",
  GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION: "recommandations auto-appliquées",
  GOOGLE_ADS_BULK_UPLOAD: "import en masse",
  SEARCH_ADS_360_SYNC: "Search Ads 360",
  INTERNAL_TOOL: "outil interne Google",
  OTHER: "autre",
};

function googleField(resourceType: string, changedField: string, fallback: ChangeField | undefined): ChangeField {
  const f = changedField.toLowerCase();
  if (/^status$/.test(f)) return "status";
  if (/^name$/.test(f)) return "name";
  if (/total_amount_micros|totalamountmicros/.test(f)) return "lifetime_budget";
  if (/amount_micros|amountmicros/.test(f) && resourceType === "CAMPAIGN_BUDGET") return "daily_budget";
  if (/cpc_bid|cpm_bid|cpv_bid|bid_micros|bidmicros|bid_modifier|bidmodifier/.test(f)) return "bid";
  if (/target_cpa|target_roas|bidding_strategy|maximize_conv|maximize_clicks|manual_cpc|target_spend|targetcpa|targetroas|biddingstrategy/.test(f)) return "bid_strategy";
  if (/start_date|end_date|ad_schedule|startdate|enddate/.test(f)) return "schedule";
  if (/geo_target|location|network_settings|audience|language|device|criterion|keyword|negative/.test(f)) return resourceType === "AD_GROUP_CRITERION" ? "keyword" : "targeting";
  if (/optimization|conversion_action|optimizationgoal/.test(f)) return "optimization";
  if (/ad\.|headline|description|final_url|finalurl|asset|responsive/.test(f)) return "creative";
  if (/campaign_budget$|campaignbudget$/.test(f)) return "budget";
  return fallback ?? "settings";
}

/** Reads a dotted field path (« target_spend.cpc_bid_ceiling_micros ») in a resource, snake or camel. */
function pathValue(resource: Row, path: string): unknown {
  let cur: unknown = resource;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = get(cur as Row, part);
  }
  return cur;
}

const toMinor = (micros: unknown, currency: string): PilotValue => {
  const n = typeof micros === "number" ? micros : typeof micros === "string" && micros ? Number(micros) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round((n / 1_000_000) * (currency && /^(JPY|KRW|CLP|COP|HUF|ISK|IDR|TWD|VND)$/.test(currency) ? 1 : 100));
};

const GOOGLE_STATUS: Record<string, string> = { ENABLED: "ACTIVE", PAUSED: "PAUSED", REMOVED: "DELETED" };

function googleValue(field: ChangeField, raw: unknown, currency: string): PilotValue {
  if (raw === undefined || raw === null) return null;
  if (field === "daily_budget" || field === "lifetime_budget" || field === "bid" || field === "spend_cap") {
    const minor = toMinor(raw, currency);
    if (minor !== null) return minor;
  }
  if (field === "status" && typeof raw === "string") return GOOGLE_STATUS[raw] ?? raw;
  if (typeof raw === "number" || typeof raw === "string") return raw;
  // An empty object (Google gives no detail for an asset change) says nothing: the line names the setting only.
  const text = short(raw, 200);
  return text === "{}" || text === "[]" ? null : text;
}

export interface GoogleChangeRow {
  changeEvent?: Row;
  change_event?: Row;
  campaign?: Row;
  adGroup?: Row;
  ad_group?: Row;
}

/** A Google change event (one row of GAQL on change_event) as one draft per changed field. */
export function fromGoogleChangeEvent(customerId: string, currency: string, row: GoogleChangeRow, ownEmails: Set<string> = googleOwnEmails()): ChangeDraft[] {
  const ev = obj(row.changeEvent ?? row.change_event);
  const resourceName = String(get(ev, "resource_name") ?? "");
  const atRaw = String(get(ev, "change_date_time") ?? "");
  // « 2026-10-05 12:09:00.878143 » in the account's time zone — read as Paris time (the agency's clients) when no zone is given.
  const at = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(atRaw) ? atRaw : `${atRaw.replace(" ", "T").slice(0, 23)}+02:00`);
  if (!resourceName || Number.isNaN(at.getTime())) return [];
  const resourceType = String(get(ev, "change_resource_type") ?? "");
  const spec = GOOGLE_RESOURCE[resourceType] ?? { key: camel(resourceType.toLowerCase()), objectType: "other" as ChangeObjectType };
  const operation = String(get(ev, "resource_change_operation") ?? "UPDATE");
  const oldRes = obj(get(obj(get(ev, "old_resource")), spec.key));
  const newRes = obj(get(obj(get(ev, "new_resource")), spec.key));
  const changed = String(get(ev, "changed_fields") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const email = String(get(ev, "user_email") ?? "").trim();
  const clientType = String(get(ev, "client_type") ?? "");
  const campaign = obj(row.campaign);
  const adGroup = obj(row.adGroup ?? row.ad_group);
  const campaignId = campaign.id !== undefined ? String(campaign.id) : null;
  const changedResource = String(get(ev, "change_resource_name") ?? "");
  const idFromResource = changedResource.split("/").pop() ?? "";
  // The object the change is about, at the level Pilotage knows: the ad group of a keyword, the campaign of a budget.
  const object = spec.objectType === "campaign" ? { id: campaignId ?? (resourceType === "CAMPAIGN" ? idFromResource : ""), name: String(campaign.name ?? "") }
    : spec.objectType === "adset" ? { id: adGroup.id !== undefined ? String(adGroup.id) : resourceType === "AD_GROUP" ? idFromResource : idFromResource.split("~")[0], name: String(adGroup.name ?? "") }
    : spec.objectType === "ad" ? { id: idFromResource.split("~").pop() ?? idFromResource, name: String(adGroup.name ? `annonce du groupe « ${adGroup.name} »` : "") }
    : { id: idFromResource, name: "" };
  const automated = /AUTOMATED_RULE|SCRIPTS|RECOMMENDATIONS/.test(clientType);
  const source: ChangeSource = ownEmails.has(email.toLowerCase()) && clientType === "GOOGLE_ADS_API" ? "impulsemotion" : automated ? "automated" : "external";
  const via = source === "impulsemotion" ? "ImpulseMotion" : GOOGLE_CLIENT_FR[clientType] ?? (clientType ? humanEvent(clientType.toLowerCase()) : "Google Ads");
  const base = {
    platform: "google" as const, accountId: customerId, currency, at,
    actorName: email || (automated ? "Google Ads" : "inconnu"), actorEmail: email || null, via, source,
    objectType: spec.objectType, objectId: object.id, objectName: object.name, campaignId,
    raw: { old: oldRes, new: newRes, resourceName: changedResource, operation, clientType },
  };
  const make = (field: ChangeField, eventType: string, before: PilotValue, after: PilotValue, suffix: string): ChangeDraft => {
    const draft: ChangeDraft = { ...base, externalId: `google:${resourceName}#${suffix}`, eventType, field, before, after, line: "", significant: SIGNIFICANT_FIELDS.has(field) && spec.objectType !== "account" && spec.objectType !== "other" };
    draft.line = describeChange(draft);
    return draft;
  };
  if (operation === "CREATE") return [make("created", `${resourceType}.create`, null, null, "create")];
  if (operation === "REMOVE") return [make("deleted", `${resourceType}.remove`, null, null, "remove")];
  if (!changed.length) return [make(spec.field ?? "settings", `${resourceType}.update`, null, null, "update")];
  return changed.map((path) => {
    const field = googleField(resourceType, path, spec.field);
    return make(field, `${resourceType}.${path}`, googleValue(field, pathValue(oldRes, path), currency), googleValue(field, pathValue(newRes, path), currency), path);
  });
}

/** Logins of ImpulseMotion's own Google Ads access (the MCC user of the n8n flow): a change by them through the API was made from here. */
export function googleOwnEmails(env: string | undefined = process.env.GOOGLE_ADS_OWN_EMAILS): Set<string> {
  return new Set((env ?? "melvin@impulse-analytics.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

// ── Sessions ─────────────────────────────────────────────────────────────

/** Changes of one person, one after the other, read as one session (what Ads Manager shows as one « edit »). */
export const SESSION_GAP_MS = 30 * 60 * 1000;
export const SESSION_MAX = 60;

export interface ChangeLike { id: string; platform: string; accountId: string; actorName: string; source: string; at: string | Date; pilotActionId?: string | null }

export function groupSessions<T extends ChangeLike>(changes: T[]): T[][] {
  const sorted = [...changes].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const out: T[][] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    const head = last?.[last.length - 1];
    const same = head && head.platform === c.platform && head.accountId === c.accountId && head.actorName === c.actorName && head.source === c.source
      && (head.pilotActionId ?? null) === (c.pilotActionId ?? null)
      && new Date(head.at).getTime() - new Date(c.at).getTime() < SESSION_GAP_MS && last.length < SESSION_MAX;
    if (same) last.push(c); else out.push([c]);
  }
  return out;
}
