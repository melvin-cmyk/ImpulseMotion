/**
 * Pilotage on Google Ads: the structure of an account (campaigns and ad
 * groups, with their budget and last 7 days' spend), one object as it is now,
 * and one field written.
 *
 * Reads go through the relay (mcp-google-ads.Custom_GAQL_Query, the same path
 * as the dashboards), never cached: a preview and a re-read must see Google as
 * it is now. Every query is made on the customer of the action, so an object
 * found belongs to that account by construction.
 *
 * Writes never go through MCP (no AI can reach them): they go to a dedicated
 * n8n webhook, protected by its own secret, that calls the Google Ads mutate
 * endpoint (server/n8n/pilot-google-write.workflow.js). Closed until
 * PILOT_GOOGLE_WRITES=1 and the webhook is configured.
 *
 * Mapping to the shared model (lib/pilot/ops.ts):
 *   ENABLED / PAUSED / REMOVED   → ACTIVE / PAUSED / DELETED
 *   ad group                     → « adset »
 *   budget amount_micros         → minor units of the currency (as Meta)
 *   cpc_bid_micros               → bidAmount, only under manual CPC bidding
 * A budget shared between campaigns is not changed from here (budgetLock):
 * the change would move other campaigns too. Campaign dates (v23
 * start_date_time / end_date_time, handled as days here) and the targets of the bidding strategy (target CPA under
 * MAXIMIZE_CONVERSIONS / TARGET_CPA, target ROAS under MAXIMIZE_CONVERSION_VALUE /
 * TARGET_ROAS) are written on the campaign; a strategy without a target is
 * changed in Google Ads first (strategyLock).
 */

import { relayDirectTool } from "@/lib/relay-tool";
import { extractRows } from "@/lib/dashboard-widgets";
import { normGoogle } from "@/lib/portfolio";
import { currencyOffset, keywordText, type KeywordMatchType, type KeywordSpec, type PilotObjectState, type PilotObjectType } from "@/lib/pilot/ops";
import { readRsaFromAd, rsaCreateAd, rsaSummary, type RsaSpec } from "@/lib/pilot/creative";
import type { StructureRow, WriteOutcome } from "@/lib/pilot/meta";

const GAQL_TIMEOUT_MS = 25_000;
const WRITE_TIMEOUT_MS = 30_000;
const STRUCTURE_LIMIT = 2000;
export const GOOGLE_END_TIME_LOCK = "un groupe d'annonces n'a pas de date de fin : changez celle de sa campagne.";
export const GOOGLE_STRATEGY_LOCK = (strategy: string) => `sa stratégie d'enchère (${strategy.toLowerCase().replace(/_/g, " ")}) n'a pas de cible : changez-la d'abord dans Google Ads.`;
/** Google's « no end date ». */
const GOOGLE_NO_END = "2037-12-30";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const GOOGLE_SHARED_BUDGET_LOCK = "ce budget est partagé avec d'autres campagnes Google Ads : le changer ici les modifierait toutes. Changez-le dans Google Ads.";

type Row = Record<string, unknown>;

/** A Google Ads customer id as digits (« 123-456-7890 » → « 1234567890 »); null when it is not one. */
export function googleCustomerDigits(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = normGoogle(value);
  return /^\d{6,12}$/.test(digits) ? digits : null;
}

const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
/** camelCase (searchStream JSON) or snake_case, whichever the relay gives. */
const field = (o: Row, camel: string): unknown => {
  if (o[camel] !== undefined) return o[camel];
  return o[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
};
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const microsNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

const STATUS: Record<string, string> = { ENABLED: "ACTIVE", PAUSED: "PAUSED", REMOVED: "DELETED" };
const TO_GOOGLE_STATUS: Record<string, string> = { ACTIVE: "ENABLED", PAUSED: "PAUSED" };
/** What Google does with the object; ELIGIBLE reads as active, like Meta's effective_status. */
const effective = (primary: string, status: string) =>
  !primary ? status : primary === "ELIGIBLE" || primary === "LIMITED" ? (status === "ACTIVE" ? "ACTIVE" : status) : primary === "PAUSED" ? "PAUSED" : primary;

const MANUAL_CPC = new Set(["MANUAL_CPC", "ENHANCED_CPC"]);

async function gaql(customer: string, query: string): Promise<Row[]> {
  const raw = await relayDirectTool(
    "mcp-google-ads.Custom_GAQL_Query",
    { input: JSON.stringify({ customer_id: customer, gaql_query: query.replace(/\s+/g, " ").trim() }) },
    GAQL_TIMEOUT_MS,
  );
  return extractRows(raw);
}

/** Minor units (cents) from micros: 12 340 000 micros of EUR → 1 234. */
export function microsToMinor(micros: number | null, currency: string): number | null {
  if (micros === null) return null;
  return Math.round((micros / 1_000_000) * currencyOffset(currency));
}

/** Micros from minor units, rounded to the smallest unit Google accepts (10 000 micros = 1 cent). */
export function minorToMicros(minor: number, currency: string): number {
  return Math.round((minor / currencyOffset(currency)) * 1_000_000 / 10_000) * 10_000;
}

const CAMPAIGN_FIELDS = `campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.bidding_strategy_type,
  campaign.start_date_time, campaign.end_date_time,
  campaign.maximize_conversions.target_cpa_micros, campaign.target_cpa.target_cpa_micros,
  campaign.maximize_conversion_value.target_roas, campaign.target_roas.target_roas,
  campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.total_amount_micros,
  campaign_budget.explicitly_shared, campaign_budget.reference_count`;

/** Where Google holds the target of each strategy (GAQL field → mutate mask). */
const TARGET_CPA_MASK: Record<string, string> = { MAXIMIZE_CONVERSIONS: "maximize_conversions.target_cpa_micros", TARGET_CPA: "target_cpa.target_cpa_micros" };
const TARGET_ROAS_MASK: Record<string, string> = { MAXIMIZE_CONVERSION_VALUE: "maximize_conversion_value.target_roas", TARGET_ROAS: "target_roas.target_roas" };
const ADGROUP_FIELDS = `ad_group.id, ad_group.name, ad_group.status, ad_group.primary_status, ad_group.cpc_bid_micros,
  campaign.id, campaign.name, campaign.bidding_strategy_type`;

function campaignState(row: Row, customer: string, currency: string): PilotObjectState & { budgetResource: string | null } {
  const c = obj(row.campaign);
  const b = obj(field(row, "campaignBudget"));
  const status = STATUS[str(c.status)] ?? str(c.status);
  const shared = field(b, "explicitlyShared") === true || Number(field(b, "referenceCount") ?? 1) > 1;
  const strategy = str(field(c, "biddingStrategyType")) || null;
  // v23: « yyyy-MM-dd HH:mm:ss » in the customer's time zone; the day is what Pilotage shows and writes.
  const endDate = str(field(c, "endDateTime")).slice(0, 10);
  const startDate = str(field(c, "startDateTime")).slice(0, 10);
  const cpaMicros = microsNum(field(obj(field(c, "maximizeConversions")), "targetCpaMicros")) ?? microsNum(field(obj(field(c, "targetCpa")), "targetCpaMicros"));
  const roasRaw = field(obj(field(c, "maximizeConversionValue")), "targetRoas") ?? field(obj(field(c, "targetRoas")), "targetRoas");
  const roas = typeof roasRaw === "number" ? roasRaw : typeof roasRaw === "string" && roasRaw ? Number(roasRaw) : NaN;
  const hasTargets = !!strategy && (strategy in TARGET_CPA_MASK || strategy in TARGET_ROAS_MASK);
  return {
    id: str(c.id),
    type: "campaign",
    accountId: customer,
    name: str(c.name),
    status,
    effectiveStatus: effective(str(field(c, "primaryStatus")), status),
    dailyBudget: microsToMinor(microsNum(field(b, "amountMicros")), currency),
    lifetimeBudget: microsToMinor(microsNum(field(b, "totalAmountMicros")), currency),
    endTime: DAY_RE.test(endDate) && endDate !== GOOGLE_NO_END ? endDate : null,
    startTime: DAY_RE.test(startDate) ? startDate : null,
    bidAmount: null,
    bidStrategy: strategy,
    targetCpa: microsToMinor(cpaMicros, currency),
    targetRoas: Number.isFinite(roas) && roas > 0 ? Math.round(roas * 100) / 100 : null,
    spendCap: null,
    strategyLock: hasTargets ? null : GOOGLE_STRATEGY_LOCK(strategy ?? "inconnue"),
    parentName: "",
    budgetLock: shared ? GOOGLE_SHARED_BUDGET_LOCK : null,
    endTimeLock: null,
    budgetResource: str(field(b, "resourceName")) || null,
  };
}

function adGroupState(row: Row, customer: string, currency: string): PilotObjectState & { campaignId: string; bidStrategyType: string | null } {
  const g = obj(field(row, "adGroup"));
  const c = obj(row.campaign);
  const status = STATUS[str(g.status)] ?? str(g.status);
  const strategy = str(field(c, "biddingStrategyType")) || null;
  return {
    id: str(g.id),
    type: "adset",
    accountId: customer,
    name: str(g.name),
    status,
    effectiveStatus: effective(str(field(g, "primaryStatus")), status),
    dailyBudget: null,
    lifetimeBudget: null,
    endTime: null,
    bidAmount: strategy && MANUAL_CPC.has(strategy) ? microsToMinor(microsNum(field(g, "cpcBidMicros")), currency) : null,
    startTime: null,
    // The ad group inherits the campaign's strategy: targets are set on the campaign here.
    bidStrategy: null,
    targetCpa: null,
    targetRoas: null,
    spendCap: null,
    strategyLock: "les cibles d'enchère Google Ads se règlent sur la campagne.",
    parentName: str(c.name),
    budgetLock: null,
    endTimeLock: GOOGLE_END_TIME_LOCK,
    campaignId: str(c.id),
    bidStrategyType: strategy,
  };
}

const KEYWORD_FIELDS = `ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status,
  ad_group_criterion.negative, ad_group_criterion.cpc_bid_micros, ad_group_criterion.effective_cpc_bid_micros, ad_group.id, ad_group.name, campaign.bidding_strategy_type`;
const NEGATIVE_FIELDS = `campaign_criterion.criterion_id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, campaign_criterion.negative, campaign.id, campaign.name`;
const KEYWORDS_LIMIT = 500;

function keywordState(row: Row, customer: string, currency: string): PilotObjectState & { adGroupId: string } {
  const crit = obj(field(row, "adGroupCriterion"));
  const kw = obj(crit.keyword);
  const g = obj(field(row, "adGroup"));
  const status = STATUS[str(crit.status)] ?? str(crit.status);
  const strategy = str(field(obj(row.campaign), "biddingStrategyType"));
  const manual = MANUAL_CPC.has(strategy);
  return {
    id: `${str(g.id)}~${str(field(crit, "criterionId"))}`,
    type: "keyword",
    accountId: customer,
    name: keywordText({ text: str(kw.text), matchType: (str(field(kw, "matchType")) || "BROAD") as KeywordMatchType }),
    status,
    effectiveStatus: status,
    dailyBudget: null, lifetimeBudget: null, endTime: null, startTime: null,
    bidAmount: manual ? microsToMinor(microsNum(field(crit, "cpcBidMicros")), currency) : null,
    bidStrategy: null, targetCpa: null, targetRoas: null, spendCap: null,
    strategyLock: manual ? null : `l'enchère d'un mot-clé ne compte qu'en CPC manuel (la campagne est en ${strategy.toLowerCase().replace(/_/g, " ")}).`,
    negative: field(crit, "negative") === true,
    parentName: str(g.name),
    budgetLock: null, endTimeLock: null,
    adGroupId: str(g.id),
  };
}

function negativeState(row: Row, customer: string): PilotObjectState & { campaignId: string } {
  const crit = obj(field(row, "campaignCriterion"));
  const kw = obj(crit.keyword);
  const c = obj(row.campaign);
  return {
    id: `${str(c.id)}~${str(field(crit, "criterionId"))}`,
    type: "keyword",
    accountId: customer,
    name: keywordText({ text: str(kw.text), matchType: (str(field(kw, "matchType")) || "BROAD") as KeywordMatchType }),
    status: "ACTIVE", effectiveStatus: "NEGATIVE",
    dailyBudget: null, lifetimeBudget: null, endTime: null, startTime: null, bidAmount: null,
    bidStrategy: null, targetCpa: null, targetRoas: null, spendCap: null, strategyLock: "un mot-clé négatif n'a pas d'enchère.",
    negative: true,
    parentName: str(c.name),
    budgetLock: null, endTimeLock: null,
    campaignId: str(c.id),
  };
}

const AD_FIELDS = `ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status, ad_group_ad.ad.type, ad_group_ad.ad.final_urls,
  ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2,
  ad_group_ad.policy_summary.approval_status, ad_group.id, ad_group.name`;
const ADS_LIMIT = 200;
const AD_TYPE_FR: Record<string, string> = { RESPONSIVE_SEARCH_AD: "annonce responsive", EXPANDED_TEXT_AD: "annonce textuelle", RESPONSIVE_DISPLAY_AD: "annonce display responsive", VIDEO_RESPONSIVE_AD: "annonce vidéo", SHOPPING_PRODUCT_AD: "annonce Shopping", APP_AD: "annonce appli", CALL_AD: "annonce appel", IMAGE_AD: "annonce image", DEMAND_GEN_MULTI_ASSET_AD: "annonce Demand Gen", DEMAND_GEN_VIDEO_RESPONSIVE_AD: "annonce Demand Gen vidéo", DEMAND_GEN_CAROUSEL_AD: "carrousel Demand Gen" };

function adState(row: Row, customer: string): PilotObjectState & { adGroupId: string } {
  const aga = obj(field(row, "adGroupAd"));
  const ad = obj(aga.ad);
  const g = obj(field(row, "adGroup"));
  const status = STATUS[str(aga.status)] ?? str(aga.status);
  const type = str(ad.type);
  const rsa = type === "RESPONSIVE_SEARCH_AD" ? readRsaFromAd(ad) : null;
  const approval = str(field(obj(field(aga, "policySummary")), "approvalStatus"));
  const name = str(ad.name) || (rsa ? `${rsa.headlines[0]?.text ?? "annonce"} — ${rsaSummary(rsa)}` : AD_TYPE_FR[type] ?? type.toLowerCase().replace(/_/g, " "));
  return {
    id: str(ad.id),
    type: "ad",
    accountId: customer,
    name,
    status,
    effectiveStatus: approval === "DISAPPROVED" ? "DISAPPROVED" : status,
    dailyBudget: null, lifetimeBudget: null, endTime: null, startTime: null, bidAmount: null,
    bidStrategy: null, targetCpa: null, targetRoas: null, spendCap: null, strategyLock: null,
    rsa: rsa ? JSON.stringify(rsa) : null,
    parentName: str(g.name),
    budgetLock: null, endTimeLock: null,
    adGroupId: str(g.id),
  };
}

/** The ads of an ad group (not removed), as rows of the tree; a responsive search ad carries its texts. */
export async function readGoogleAds(customerId: string, adGroupId: string): Promise<StructureRow[]> {
  const customer = googleCustomerDigits(customerId);
  if (!customer || !isId(adGroupId)) throw new Error("Groupe d'annonces invalide");
  const rows = await gaql(customer, `SELECT ${AD_FIELDS} FROM ad_group_ad WHERE ad_group.id = ${adGroupId} AND ad_group_ad.status != 'REMOVED' LIMIT ${ADS_LIMIT}`);
  return rows.map((r) => { const { adGroupId: parent, ...state } = adState(r, customer); return { ...state, parentId: parent, bidStrategy: null, spend7d: 0 }; });
}

/** The keywords of an ad group (not removed), as rows of the tree. */
export async function readGoogleKeywords(customerId: string, adGroupId: string, currency: string): Promise<StructureRow[]> {
  const customer = googleCustomerDigits(customerId);
  if (!customer || !isId(adGroupId)) throw new Error("Groupe d'annonces invalide");
  const rows = await gaql(customer, `SELECT ${KEYWORD_FIELDS} FROM ad_group_criterion WHERE ad_group.id = ${adGroupId} AND ad_group_criterion.type = KEYWORD AND ad_group_criterion.status != 'REMOVED' ORDER BY ad_group_criterion.keyword.text LIMIT ${KEYWORDS_LIMIT}`);
  return rows.map((r) => { const { adGroupId: parent, ...state } = keywordState(r, customer, currency); return { ...state, parentId: parent, bidStrategy: null, spend7d: 0 }; });
}

/** The negative keywords of every campaign of the customer (not the shared lists), as rows under their campaign. */
export async function readGoogleNegatives(customerId: string): Promise<StructureRow[]> {
  const customer = googleCustomerDigits(customerId);
  if (!customer) throw new Error("Compte Google Ads invalide");
  const rows = await gaql(customer, `SELECT ${NEGATIVE_FIELDS} FROM campaign_criterion WHERE campaign_criterion.type = KEYWORD AND campaign_criterion.negative = TRUE AND campaign.status != 'REMOVED' ORDER BY campaign.id LIMIT ${STRUCTURE_LIMIT}`);
  return rows.map((r) => { const { campaignId, ...state } = negativeState(r, customer); return { ...state, parentId: campaignId, bidStrategy: null, spend7d: 0 }; });
}

/** The currency of the customer: budgets are written in its units. */
export async function readGoogleCurrency(customerId: string): Promise<string> {
  const customer = googleCustomerDigits(customerId);
  if (!customer) throw new Error("Compte Google Ads invalide");
  const rows = await gaql(customer, "SELECT customer.currency_code FROM customer");
  const code = str(field(obj(rows[0]?.customer), "currencyCode"));
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("Devise du compte illisible");
  return code;
}

/** Spend of the last 7 days by id, in units of the currency. */
function spendById(rows: Row[], key: "campaign" | "adGroup"): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const id = str(obj(field(r, key)).id);
    const micros = Number(field(obj(r.metrics), "costMicros") ?? 0) || 0;
    out.set(id, (out.get(id) ?? 0) + micros / 1_000_000);
  }
  return out;
}

/** Campaigns and ad groups that are not removed. */
export async function readGoogleStructure(customerId: string, knownCurrency?: string): Promise<{ campaigns: StructureRow[]; adsets: StructureRow[]; negatives: StructureRow[]; truncated: boolean; currency: string }> {
  const customer = googleCustomerDigits(customerId);
  if (!customer) throw new Error("Compte Google Ads invalide");
  const currency = knownCurrency ?? (await readGoogleCurrency(customer));
  const [campaigns, adGroups, campaignSpend, adGroupSpend, negatives] = await Promise.all([
    gaql(customer, `SELECT ${CAMPAIGN_FIELDS} FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name LIMIT ${STRUCTURE_LIMIT}`),
    gaql(customer, `SELECT ${ADGROUP_FIELDS} FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' ORDER BY ad_group.name LIMIT ${STRUCTURE_LIMIT}`),
    gaql(customer, `SELECT campaign.id, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS AND metrics.cost_micros > 0`),
    gaql(customer, `SELECT ad_group.id, metrics.cost_micros FROM ad_group WHERE segments.date DURING LAST_7_DAYS AND metrics.cost_micros > 0`),
    // Negatives are a plus: a read that fails leaves the tree without them, never without the campaigns.
    readGoogleNegatives(customer).catch((e) => { console.error("[pilot] negatives unreadable", e); return [] as StructureRow[]; }),
  ]);
  const cs = spendById(campaignSpend, "campaign");
  const gs = spendById(adGroupSpend, "adGroup");
  return {
    campaigns: campaigns.map((r) => {
      const { budgetResource: _b, ...state } = campaignState(r, customer, currency);
      return { ...state, parentId: null, bidStrategy: state.bidStrategy ?? null, spend7d: cs.get(state.id) ?? 0 };
    }),
    adsets: adGroups.map((r) => {
      const { campaignId, bidStrategyType, ...state } = adGroupState(r, customer, currency);
      return { ...state, parentId: campaignId || null, bidStrategy: bidStrategyType, spend7d: gs.get(state.id) ?? 0 };
    }),
    negatives,
    truncated: campaigns.length >= STRUCTURE_LIMIT || adGroups.length >= STRUCTURE_LIMIT,
    currency,
  };
}

const isId = (id: string) => /^\d{1,25}$/.test(id);

/** One object as Google holds it now, in this customer; null when the customer has no such object. */
export async function readGoogleObject(customerId: string, objectId: string, type: PilotObjectType, currency?: string): Promise<PilotObjectState | null> {
  const customer = googleCustomerDigits(customerId);
  if (!customer) return null;
  const cur = currency ?? (await readGoogleCurrency(customer));
  if (type === "ad") {
    if (!isId(objectId)) return null;
    const rows = await gaql(customer, `SELECT ${AD_FIELDS} FROM ad_group_ad WHERE ad_group_ad.ad.id = ${objectId} AND ad_group_ad.status != 'REMOVED'`);
    if (!rows[0]) return null;
    const { adGroupId: _g, ...state } = adState(rows[0], customer);
    return state;
  }
  if (type === "keyword") {
    const m = /^(\d{1,25})~(\d{1,25})$/.exec(objectId);
    if (!m) return null;
    // Under an ad group first; else a negative keyword of a campaign.
    const kw = await gaql(customer, `SELECT ${KEYWORD_FIELDS} FROM ad_group_criterion WHERE ad_group.id = ${m[1]} AND ad_group_criterion.criterion_id = ${m[2]} AND ad_group_criterion.status != 'REMOVED'`);
    if (kw[0]) { const { adGroupId: _g, ...state } = keywordState(kw[0], customer, cur); return state; }
    const neg = await gaql(customer, `SELECT ${NEGATIVE_FIELDS} FROM campaign_criterion WHERE campaign.id = ${m[1]} AND campaign_criterion.criterion_id = ${m[2]} AND campaign_criterion.negative = TRUE`);
    if (neg[0]) { const { campaignId: _c, ...state } = negativeState(neg[0], customer); return state; }
    return null;
  }
  if (!isId(objectId)) return null;
  if (type === "campaign") {
    const rows = await gaql(customer, `SELECT ${CAMPAIGN_FIELDS} FROM campaign WHERE campaign.id = ${objectId}`);
    if (!rows[0]) return null;
    const { budgetResource: _b, ...state } = campaignState(rows[0], customer, cur);
    return state;
  }
  const rows = await gaql(customer, `SELECT ${ADGROUP_FIELDS} FROM ad_group WHERE ad_group.id = ${objectId}`);
  if (!rows[0]) return null;
  const { campaignId: _c, bidStrategyType: _s, ...state } = adGroupState(rows[0], customer, cur);
  return state;
}

// ── Writing ──────────────────────────────────────────────────────────────

/** The webhook of the n8n flow that writes to Google Ads, or null when it is not configured. */
export function googleWriteHook(): { url: string; secret: string } | null {
  const secret = process.env.PILOT_GOOGLE_WEBHOOK_SECRET ?? "";
  let url = process.env.PILOT_GOOGLE_WEBHOOK_URL ?? "";
  if (!url) {
    const alerts = process.env.N8N_ALERT_WEBHOOK_URL ?? "";
    if (/\/impulsemotion-alerts\/?$/.test(alerts)) url = alerts.replace(/\/impulsemotion-alerts\/?$/, "/impulsemotion-google-write");
  }
  return url && secret.length >= 16 ? { url, secret } : null;
}

export const googleWritesOpen = () => process.env.PILOT_GOOGLE_WRITES === "1" && process.env.PILOT_WRITES === "1" && !!googleWriteHook();

/** One mutate operation, as the n8n flow forwards it to Google Ads. */
export interface GoogleMutation {
  resource: "campaigns" | "adGroups" | "campaignBudgets" | "adGroupCriteria" | "campaignCriteria" | "adGroupAds";
  operation: { update: Record<string, unknown>; updateMask: string } | { remove: string } | { create: Record<string, unknown> };
}

/** The mutate that adds a keyword in an ad group (ENABLED), or a negative keyword on a campaign. */
export function googleKeywordCreation(customer: string, parentId: string, spec: KeywordSpec, negative: boolean): GoogleMutation {
  return negative
    ? { resource: "campaignCriteria", operation: { create: { campaign: `customers/${customer}/campaigns/${parentId}`, negative: true, keyword: { text: spec.text, matchType: spec.matchType } } } }
    : { resource: "adGroupCriteria", operation: { create: { adGroup: `customers/${customer}/adGroups/${parentId}`, status: "ENABLED", keyword: { text: spec.text, matchType: spec.matchType } } } };
}

/**
 * The mutate operation that writes `field` = `value` (as ops.ts holds it) on
 * the object; null when the field is not written on Google Ads from here.
 * Pure except for the budget, whose resource is read on the campaign.
 */
export function googleMutation(customer: string, objectId: string, type: PilotObjectType, field: string, value: string | number, currency: string, budgetResource?: string | null, strategy?: string | null, negative = false, adGroupAdName?: string | null): GoogleMutation | null {
  if (type === "ad") {
    // An ad is named by its ad group and its id: the ad group is read with the ad (adGroupAdName).
    if (!adGroupAdName) return null;
    if (field === "status" && value === "DELETED") return { resource: "adGroupAds", operation: { remove: adGroupAdName } };
    if (field === "status") { const status = TO_GOOGLE_STATUS[String(value)]; return status ? { resource: "adGroupAds", operation: { update: { resourceName: adGroupAdName, status }, updateMask: "status" } } : null; }
    return null;
  }
  if (type === "keyword") {
    const m = /^(\d{1,25})~(\d{1,25})$/.exec(objectId);
    if (!m) return null;
    const resource = negative ? "campaignCriteria" : "adGroupCriteria";
    const name = `customers/${customer}/${resource}/${m[1]}~${m[2]}`;
    if (field === "status" && value === "DELETED") return { resource, operation: { remove: name } };
    if (negative) return null;
    if (field === "status") { const status = TO_GOOGLE_STATUS[String(value)]; return status ? { resource, operation: { update: { resourceName: name, status }, updateMask: "status" } } : null; }
    if (field === "bid_amount") return { resource, operation: { update: { resourceName: name, cpcBidMicros: String(minorToMicros(Number(value), currency)) }, updateMask: "cpc_bid_micros" } };
    return null;
  }
  const resource = type === "campaign" ? "campaigns" : type === "adset" ? "adGroups" : null;
  if (!resource) return null;
  const name = `customers/${customer}/${resource}/${objectId}`;
  switch (field) {
    case "start_date":
    case "end_date": {
      // v23 writes a date-time: the whole day (00:00:00 to start, 23:59:59 to end).
      if (type !== "campaign" || !DAY_RE.test(String(value))) return null;
      const key = field === "start_date" ? "startDateTime" : "endDateTime";
      return { resource, operation: { update: { resourceName: name, [key]: `${value} ${field === "start_date" ? "00:00:00" : "23:59:59"}` }, updateMask: `${field}_time` } };
    }
    case "target_cpa": {
      const mask = type === "campaign" && strategy ? TARGET_CPA_MASK[strategy] : null;
      if (!mask) return null;
      const [group, leaf] = mask.split(".").map((part) => part.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()));
      return { resource, operation: { update: { resourceName: name, [group]: { [leaf]: String(minorToMicros(Number(value), currency)) } }, updateMask: mask } };
    }
    case "target_roas": {
      const mask = type === "campaign" && strategy ? TARGET_ROAS_MASK[strategy] : null;
      if (!mask) return null;
      const [group, leaf] = mask.split(".").map((part) => part.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()));
      return { resource, operation: { update: { resourceName: name, [group]: { [leaf]: Number(value) } }, updateMask: mask } };
    }
    case "status": {
      if (value === "DELETED") return { resource, operation: { remove: name } };
      const status = TO_GOOGLE_STATUS[String(value)];
      return status ? { resource, operation: { update: { resourceName: name, status }, updateMask: "status" } } : null;
    }
    case "name":
      return { resource, operation: { update: { resourceName: name, name: String(value) }, updateMask: "name" } };
    case "bid_amount":
      if (type !== "adset") return null;
      return { resource, operation: { update: { resourceName: name, cpcBidMicros: String(minorToMicros(Number(value), currency)) }, updateMask: "cpc_bid_micros" } };
    case "daily_budget":
    case "lifetime_budget": {
      if (type !== "campaign" || !budgetResource || !budgetResource.startsWith(`customers/${customer}/campaignBudgets/`)) return null;
      const key = field === "daily_budget" ? "amountMicros" : "totalAmountMicros";
      const mask = field === "daily_budget" ? "amount_micros" : "total_amount_micros";
      return { resource: "campaignBudgets", operation: { update: { resourceName: budgetResource, [key]: String(minorToMicros(Number(value), currency)) }, updateMask: mask } };
    }
    default:
      return null;
  }
}

/** One field written on one object of the customer. Never throws: the outcome says what happened. */
export async function writeGoogleField(customerId: string, objectId: string, type: PilotObjectType, field: string, value: string | number, currency: string): Promise<WriteOutcome> {
  const hook = googleWriteHook();
  const customer = googleCustomerDigits(customerId);
  if (!hook || !customer) return { kind: "refused", error: "L'envoi vers Google Ads n'est pas configuré." };

  let budgetResource: string | null = null;
  if (field === "daily_budget" || field === "lifetime_budget") {
    try {
      const rows = await gaql(customer, `SELECT campaign.id, campaign_budget.resource_name, campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign WHERE campaign.id = ${objectId}`);
      const b = obj(field_(rows[0], "campaignBudget"));
      if (field_(b, "explicitlyShared") === true || Number(field_(b, "referenceCount") ?? 1) > 1) return { kind: "refused", error: `Non envoyé : ${GOOGLE_SHARED_BUDGET_LOCK}` };
      budgetResource = str(field_(b, "resourceName")) || null;
    } catch {
      return { kind: "refused", error: "Google Ads ne répond pas : rien n'a été envoyé pour ce changement." };
    }
  }
  let strategy: string | null = null;
  if (field === "target_cpa" || field === "target_roas") {
    try {
      const rows = await gaql(customer, `SELECT campaign.id, campaign.bidding_strategy_type FROM campaign WHERE campaign.id = ${objectId}`);
      strategy = str(field_(obj(rows[0]?.campaign), "biddingStrategyType")) || null;
    } catch {
      return { kind: "refused", error: "Google Ads ne répond pas : rien n'a été envoyé pour ce changement." };
    }
  }
  let adGroupAdName: string | null = null;
  if (type === "ad") {
    try {
      const rows = await gaql(customer, `SELECT ad_group_ad.resource_name, ad_group_ad.ad.id FROM ad_group_ad WHERE ad_group_ad.ad.id = ${objectId} AND ad_group_ad.status != 'REMOVED'`);
      adGroupAdName = str(field_(obj(field_(rows[0], "adGroupAd")), "resourceName")) || null;
      if (!adGroupAdName) return { kind: "refused", error: "Annonce introuvable sur Google Ads : rien n'a été envoyé." };
    } catch {
      return { kind: "refused", error: "Google Ads ne répond pas : rien n'a été envoyé pour ce changement." };
    }
  }
  let negative = false;
  if (type === "keyword") {
    try {
      const current = await readGoogleObject(customer, objectId, "keyword", currency);
      if (!current) return { kind: "refused", error: "Mot-clé introuvable sur Google Ads : rien n'a été envoyé." };
      negative = !!current.negative;
    } catch {
      return { kind: "refused", error: "Google Ads ne répond pas : rien n'a été envoyé pour ce changement." };
    }
  }
  const mutation = googleMutation(customer, objectId, type, field, value, currency, budgetResource, strategy, negative, adGroupAdName);
  if (!mutation) return { kind: "refused", error: "Ce changement ne peut pas être envoyé à Google Ads depuis ImpulseMotion." };
  return postGoogleMutation(hook, customer, mutation);
}

/** A keyword added in an ad group, or a negative keyword on a campaign. Never throws; `createdId` is the criterion as Google names it. */
export async function createGoogleKeyword(customerId: string, parentId: string, spec: KeywordSpec, negative: boolean): Promise<WriteOutcome & { createdId?: string }> {
  const hook = googleWriteHook();
  const customer = googleCustomerDigits(customerId);
  if (!hook || !customer || !isId(parentId)) return { kind: "refused", error: "L'envoi vers Google Ads n'est pas configuré." };
  const out = await postGoogleMutation(hook, customer, googleKeywordCreation(customer, parentId, spec, negative));
  if (out.kind !== "done") return out;
  const created = out.resultName ? out.resultName.split("/").pop() ?? "" : "";
  return { kind: "done", createdId: /^\d{1,25}~\d{1,25}$/.test(created) ? created : undefined };
}

/** The mutate that creates a responsive search ad in an ad group (same status as the one it replaces). */
export function googleRsaCreation(customer: string, adGroupId: string, spec: RsaSpec, status: "ENABLED" | "PAUSED"): GoogleMutation {
  return { resource: "adGroupAds", operation: { create: { adGroup: `customers/${customer}/adGroups/${adGroupId}`, status, ad: rsaCreateAd(spec) } } };
}

/**
 * A new version of a responsive search ad: created in the ad group of the old
 * one (same status), then the old one paused. Never throws; `createdId` is the
 * new ad; `oldPaused` says whether the old one was paused.
 */
export async function replaceGoogleRsa(customerId: string, oldAdId: string, spec: RsaSpec): Promise<WriteOutcome & { createdId?: string; oldPaused?: boolean }> {
  const hook = googleWriteHook();
  const customer = googleCustomerDigits(customerId);
  if (!hook || !customer || !isId(oldAdId)) return { kind: "refused", error: "L'envoi vers Google Ads n'est pas configuré." };
  let old: { name: string; adGroupId: string; status: string };
  try {
    const rows = await gaql(customer, `SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group.id FROM ad_group_ad WHERE ad_group_ad.ad.id = ${oldAdId} AND ad_group_ad.status != 'REMOVED'`);
    const aga = obj(field_(rows[0], "adGroupAd"));
    old = { name: str(field_(aga, "resourceName")), adGroupId: str(obj(field_(rows[0], "adGroup")).id), status: str(aga.status) };
    if (!old.name || !isId(old.adGroupId)) return { kind: "refused", error: "Annonce introuvable sur Google Ads : rien n'a été envoyé." };
  } catch {
    return { kind: "refused", error: "Google Ads ne répond pas : rien n'a été envoyé pour ce changement." };
  }
  const created = await postGoogleMutation(hook, customer, googleRsaCreation(customer, old.adGroupId, spec, old.status === "PAUSED" ? "PAUSED" : "ENABLED"));
  if (created.kind !== "done") return created;
  const createdId = created.resultName ? created.resultName.split("~").pop() ?? "" : "";
  if (old.status !== "ENABLED") return { kind: "done", createdId, oldPaused: false };
  const paused = await postGoogleMutation(hook, customer, { resource: "adGroupAds", operation: { update: { resourceName: old.name, status: "PAUSED" }, updateMask: "status" } });
  if (paused.kind !== "done") return { kind: "uncertain", createdId, oldPaused: false, error: `La nouvelle annonce ${createdId || ""} est créée mais l'ancienne n'a pas été mise en pause (${paused.error}) : les deux diffusent. Mettez l'ancienne en pause depuis l'arbre.` };
  return { kind: "done", createdId, oldPaused: true };
}

async function postGoogleMutation(hook: { url: string; secret: string }, customer: string, mutation: GoogleMutation): Promise<WriteOutcome & { resultName?: string }> {
  let res: Response;
  try {
    res = await fetch(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pilot-Secret": hook.secret },
      body: JSON.stringify({ version: 1, customerId: customer, ...mutation }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch {
    return { kind: "uncertain", error: "Google Ads n'a pas répondu à temps : la modification a peut-être été appliquée. Vérifiez dans Google Ads avant de recommencer." };
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; googleStatus?: number | null; result?: Array<{ resourceName?: string }> } | null;
  if (res.ok && body?.ok) return { kind: "done", resultName: body.result?.[0]?.resourceName };
  // Refused for sure: the flow refused the request (400/401), or Google answered 4xx.
  const googleStatus = typeof body?.googleStatus === "number" ? body.googleStatus : null;
  const refused = body && ((res.status >= 400 && res.status < 500) || (googleStatus !== null && googleStatus >= 400 && googleStatus < 500));
  if (refused) return { kind: "refused", error: `Refusé par Google Ads : ${String(body.error ?? res.status).slice(0, 300)}` };
  // Anything else (n8n down, Google unreachable or 5xx): whether Google applied it is not known.
  return { kind: "uncertain", error: `Google Ads n'a pas donné de réponse sûre (${googleStatus ?? res.status}) : la modification a peut-être été appliquée. Vérifiez dans Google Ads avant de recommencer.` };
}

const field_ = (o: unknown, camel: string) => field(obj(o), camel);
