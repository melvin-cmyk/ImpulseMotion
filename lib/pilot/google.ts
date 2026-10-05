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
 * the change would move other campaigns too. The end date is left to Google
 * Ads for now (endTimeLock).
 */

import { relayDirectTool } from "@/lib/relay-tool";
import { extractRows } from "@/lib/dashboard-widgets";
import { normGoogle } from "@/lib/portfolio";
import { currencyOffset, type PilotObjectState, type PilotObjectType } from "@/lib/pilot/ops";
import type { StructureRow, WriteOutcome } from "@/lib/pilot/meta";

const GAQL_TIMEOUT_MS = 25_000;
const WRITE_TIMEOUT_MS = 30_000;
const STRUCTURE_LIMIT = 2000;
export const GOOGLE_END_TIME_LOCK = "la date de fin d'une campagne Google Ads se règle dans Google Ads pour le moment.";
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
  campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.total_amount_micros,
  campaign_budget.explicitly_shared, campaign_budget.reference_count`;
const ADGROUP_FIELDS = `ad_group.id, ad_group.name, ad_group.status, ad_group.primary_status, ad_group.cpc_bid_micros,
  campaign.id, campaign.name, campaign.bidding_strategy_type`;

function campaignState(row: Row, customer: string, currency: string): PilotObjectState & { budgetResource: string | null; bidStrategy: string | null } {
  const c = obj(row.campaign);
  const b = obj(field(row, "campaignBudget"));
  const status = STATUS[str(c.status)] ?? str(c.status);
  const shared = field(b, "explicitlyShared") === true || Number(field(b, "referenceCount") ?? 1) > 1;
  return {
    id: str(c.id),
    type: "campaign",
    accountId: customer,
    name: str(c.name),
    status,
    effectiveStatus: effective(str(field(c, "primaryStatus")), status),
    dailyBudget: microsToMinor(microsNum(field(b, "amountMicros")), currency),
    lifetimeBudget: microsToMinor(microsNum(field(b, "totalAmountMicros")), currency),
    endTime: null,
    bidAmount: null,
    parentName: "",
    budgetLock: shared ? GOOGLE_SHARED_BUDGET_LOCK : null,
    endTimeLock: GOOGLE_END_TIME_LOCK,
    budgetResource: str(field(b, "resourceName")) || null,
    bidStrategy: str(field(c, "biddingStrategyType")) || null,
  };
}

function adGroupState(row: Row, customer: string, currency: string): PilotObjectState & { campaignId: string; bidStrategy: string | null } {
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
    parentName: str(c.name),
    budgetLock: null,
    endTimeLock: GOOGLE_END_TIME_LOCK,
    campaignId: str(c.id),
    bidStrategy: strategy,
  };
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
export async function readGoogleStructure(customerId: string, knownCurrency?: string): Promise<{ campaigns: StructureRow[]; adsets: StructureRow[]; truncated: boolean; currency: string }> {
  const customer = googleCustomerDigits(customerId);
  if (!customer) throw new Error("Compte Google Ads invalide");
  const currency = knownCurrency ?? (await readGoogleCurrency(customer));
  const [campaigns, adGroups, campaignSpend, adGroupSpend] = await Promise.all([
    gaql(customer, `SELECT ${CAMPAIGN_FIELDS} FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name LIMIT ${STRUCTURE_LIMIT}`),
    gaql(customer, `SELECT ${ADGROUP_FIELDS} FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' ORDER BY ad_group.name LIMIT ${STRUCTURE_LIMIT}`),
    gaql(customer, `SELECT campaign.id, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS AND metrics.cost_micros > 0`),
    gaql(customer, `SELECT ad_group.id, metrics.cost_micros FROM ad_group WHERE segments.date DURING LAST_7_DAYS AND metrics.cost_micros > 0`),
  ]);
  const cs = spendById(campaignSpend, "campaign");
  const gs = spendById(adGroupSpend, "adGroup");
  return {
    campaigns: campaigns.map((r) => {
      const { budgetResource: _b, bidStrategy, ...state } = campaignState(r, customer, currency);
      return { ...state, parentId: null, bidStrategy, spend7d: cs.get(state.id) ?? 0 };
    }),
    adsets: adGroups.map((r) => {
      const { campaignId, bidStrategy, ...state } = adGroupState(r, customer, currency);
      return { ...state, parentId: campaignId || null, bidStrategy, spend7d: gs.get(state.id) ?? 0 };
    }),
    truncated: campaigns.length >= STRUCTURE_LIMIT || adGroups.length >= STRUCTURE_LIMIT,
    currency,
  };
}

const isId = (id: string) => /^\d{1,25}$/.test(id);

/** One object as Google holds it now, in this customer; null when the customer has no such object. */
export async function readGoogleObject(customerId: string, objectId: string, type: PilotObjectType, currency?: string): Promise<PilotObjectState | null> {
  const customer = googleCustomerDigits(customerId);
  if (type === "ad") throw new Error("Les annonces Google Ads ne se modifient pas encore ici.");
  if (!customer || !isId(objectId)) return null;
  const cur = currency ?? (await readGoogleCurrency(customer));
  if (type === "campaign") {
    const rows = await gaql(customer, `SELECT ${CAMPAIGN_FIELDS} FROM campaign WHERE campaign.id = ${objectId}`);
    if (!rows[0]) return null;
    const { budgetResource: _b, bidStrategy: _s, ...state } = campaignState(rows[0], customer, cur);
    return state;
  }
  const rows = await gaql(customer, `SELECT ${ADGROUP_FIELDS} FROM ad_group WHERE ad_group.id = ${objectId}`);
  if (!rows[0]) return null;
  const { campaignId: _c, bidStrategy: _s, ...state } = adGroupState(rows[0], customer, cur);
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
  resource: "campaigns" | "adGroups" | "campaignBudgets";
  operation: { update: Record<string, unknown>; updateMask: string } | { remove: string };
}

/**
 * The mutate operation that writes `field` = `value` (as ops.ts holds it) on
 * the object; null when the field is not written on Google Ads from here.
 * Pure except for the budget, whose resource is read on the campaign.
 */
export function googleMutation(customer: string, objectId: string, type: PilotObjectType, field: string, value: string | number, currency: string, budgetResource?: string | null): GoogleMutation | null {
  const resource = type === "campaign" ? "campaigns" : type === "adset" ? "adGroups" : null;
  if (!resource) return null;
  const name = `customers/${customer}/${resource}/${objectId}`;
  switch (field) {
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
  const mutation = googleMutation(customer, objectId, type, field, value, currency, budgetResource);
  if (!mutation) return { kind: "refused", error: "Ce changement ne peut pas être envoyé à Google Ads depuis ImpulseMotion." };

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
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; googleStatus?: number | null } | null;
  if (res.ok && body?.ok) return { kind: "done" };
  // Refused for sure: the flow refused the request (400/401), or Google answered 4xx.
  const googleStatus = typeof body?.googleStatus === "number" ? body.googleStatus : null;
  const refused = body && ((res.status >= 400 && res.status < 500) || (googleStatus !== null && googleStatus >= 400 && googleStatus < 500));
  if (refused) return { kind: "refused", error: `Refusé par Google Ads : ${String(body.error ?? res.status).slice(0, 300)}` };
  // Anything else (n8n down, Google unreachable or 5xx): whether Google applied it is not known.
  return { kind: "uncertain", error: `Google Ads n'a pas donné de réponse sûre (${googleStatus ?? res.status}) : la modification a peut-être été appliquée. Vérifiez dans Google Ads avant de recommencer.` };
}

const field_ = (o: unknown, camel: string) => field(obj(o), camel);
