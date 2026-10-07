/**
 * Pilotage on TikTok Ads: the structure of an advertiser (campaigns, ad
 * groups, ads), one object as it is now, and one field written.
 *
 * Reads go through the relay (mcp-tiktok-ads, the n8n flow « TikTok Ads MCP
 * v2.1 (Read-Only) »), the same door as the dashboards; the relay completes
 * the arguments (server/mcp-tiktok-args.mjs). Writes never go through MCP:
 * they go to a dedicated n8n webhook with its own secret
 * (server/n8n/pilot-tiktok-write.workflow.js) that calls the TikTok Business
 * API. Closed until PILOT_TIKTOK_WRITES=1 and the webhook is configured.
 *
 * Mapping to the shared model (lib/pilot/ops.ts):
 *   operation_status ENABLE / DISABLE / DELETE → ACTIVE / PAUSED / DELETED
 *   ad group                                   → « adset »
 *   budget (units of the currency, BUDGET_MODE_DAY / BUDGET_MODE_TOTAL) → minor units
 *   bid_price / conversion_bid_price          → bidAmount (ad group)
 *   schedule_end_time                          → endTime (ad group)
 */

import { relayDirectTool } from "@/lib/relay-tool";
import { TIKTOK_SERVER } from "@/lib/mcp-whitelist";
import { tiktokEnvelope } from "@/lib/tiktok-data";
import { normalizeAdvertiserId, parseAdvertiserInfo } from "@/lib/tiktok-accounts";
import { currencyOffset, type PilotObjectState, type PilotObjectType } from "@/lib/pilot/ops";
import type { StructureRow, WriteOutcome } from "@/lib/pilot/meta";

const TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 30_000;
const MAX_PAGES = 20;
type Row = Record<string, unknown>;

const STATUS: Record<string, string> = { ENABLE: "ACTIVE", DISABLE: "PAUSED", DELETE: "DELETED" };
const TO_TIKTOK_STATUS: Record<string, string> = { ACTIVE: "ENABLE", PAUSED: "DISABLE", DELETED: "DELETE" };
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown): number | null => { const n = typeof v === "number" ? v : typeof v === "string" && v ? Number(v) : NaN; return Number.isFinite(n) && n > 0 ? n : null; };

export const tiktokAdvertiserDigits = (v: unknown): string | null => normalizeAdvertiserId(v);

/** Every page of a listing tool, up to MAX_PAGES. */
async function listAll(tool: "get_campaigns" | "get_adgroups" | "get_ads", input: Row): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { list, totalPage } = tiktokEnvelope(await relayDirectTool(`${TIKTOK_SERVER}.${tool}`, { ...input, page: String(page), page_size: "100" }, TIMEOUT_MS));
    out.push(...list);
    if (page >= totalPage) break;
  }
  return out;
}

/** The minor units of a TikTok amount (given in units of the currency). */
const toMinor = (v: unknown, currency: string): number | null => { const n = num(v); return n === null ? null : Math.round(n * currencyOffset(currency)); };

/** TikTok « secondary_status » tells what the platform does with the object; the operation status is what one sets. */
function campaignState(c: Row, advertiser: string, currency: string): PilotObjectState {
  const status = STATUS[str(c.operation_status)] ?? str(c.operation_status);
  const daily = str(c.budget_mode) === "BUDGET_MODE_DAY";
  const total = str(c.budget_mode) === "BUDGET_MODE_TOTAL";
  return {
    id: str(c.campaign_id), type: "campaign", accountId: advertiser, name: str(c.campaign_name), status,
    effectiveStatus: /NOT_DELIVERY|DISABLE|DELETE|AUDIT|BUDGET|OUT/.test(str(c.secondary_status)) && status === "ACTIVE" ? str(c.secondary_status).replace(/^CAMPAIGN_STATUS_/, "") : status,
    dailyBudget: daily ? toMinor(c.budget, currency) : null,
    lifetimeBudget: total ? toMinor(c.budget, currency) : null,
    endTime: null, startTime: null, bidAmount: null, bidStrategy: null, targetCpa: null, targetRoas: null, spendCap: null,
    strategyLock: "les enchères TikTok se règlent sur le groupe d'annonces.",
    endTimeLock: "la date de fin se règle sur le groupe d'annonces TikTok.",
    parentName: "",
  };
}

function adGroupState(g: Row, advertiser: string, currency: string, campaignName = ""): PilotObjectState & { campaignId: string } {
  const status = STATUS[str(g.operation_status)] ?? str(g.operation_status);
  const daily = str(g.budget_mode) === "BUDGET_MODE_DAY";
  const total = str(g.budget_mode) === "BUDGET_MODE_TOTAL";
  const bid = num(g.conversion_bid_price) ?? num(g.bid_price);
  const end = str(g.schedule_end_time);
  return {
    id: str(g.adgroup_id), type: "adset", accountId: advertiser, name: str(g.adgroup_name), status,
    effectiveStatus: /NOT_DELIVERY|DISABLE|DELETE|AUDIT|BUDGET|OUT|TIME_DONE/.test(str(g.secondary_status)) && status === "ACTIVE" ? str(g.secondary_status).replace(/^ADGROUP_STATUS_/, "") : status,
    dailyBudget: daily ? toMinor(g.budget, currency) : null,
    lifetimeBudget: total ? toMinor(g.budget, currency) : null,
    // « 2026-12-31 23:59:59 » in the advertiser's time zone: kept as given, written back the same way.
    endTime: /^\d{4}-\d{2}-\d{2}/.test(end) && !/^(1970|2037|2038)/.test(end) ? end : null,
    startTime: /^\d{4}-\d{2}-\d{2}/.test(str(g.schedule_start_time)) ? str(g.schedule_start_time) : null,
    bidAmount: bid !== null ? Math.round(bid * currencyOffset(currency)) : null,
    bidStrategy: null, targetCpa: null, targetRoas: null, spendCap: null,
    strategyLock: "la stratégie d'enchère TikTok se change dans TikTok Ads Manager.",
    endTimeLock: null,
    parentName: campaignName || str(g.campaign_name),
    campaignId: str(g.campaign_id),
  };
}

function adState(a: Row, advertiser: string, adGroupName = ""): PilotObjectState & { adGroupId: string } {
  const status = STATUS[str(a.operation_status)] ?? str(a.operation_status);
  return {
    id: str(a.ad_id), type: "ad", accountId: advertiser, name: str(a.ad_name), status,
    effectiveStatus: /NOT_DELIVERY|DISABLE|DELETE|AUDIT|REJECT/.test(str(a.secondary_status)) && status === "ACTIVE" ? str(a.secondary_status).replace(/^AD_STATUS_/, "") : status,
    dailyBudget: null, lifetimeBudget: null, endTime: null, startTime: null, bidAmount: null, bidStrategy: null, targetCpa: null, targetRoas: null, spendCap: null,
    strategyLock: null, endTimeLock: null,
    parentName: adGroupName || str(a.adgroup_name),
    adGroupId: str(a.adgroup_id),
  };
}

export async function readTikTokCurrency(advertiserId: string): Promise<string> {
  const id = tiktokAdvertiserDigits(advertiserId);
  if (!id) throw new Error("Compte TikTok invalide");
  const info = parseAdvertiserInfo(await relayDirectTool(`${TIKTOK_SERVER}.get_advertiser_info`, { advertiser_ids: JSON.stringify([id]) }, TIMEOUT_MS), id);
  if (!info.ok) throw new Error(info.error);
  const currency = String(info.advertiser.currency ?? "");
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Devise du compte TikTok illisible");
  return currency;
}

/** Campaigns and ad groups that are not deleted. */
export async function readTikTokStructure(advertiserId: string, knownCurrency?: string): Promise<{ campaigns: StructureRow[]; adsets: StructureRow[]; truncated: boolean }> {
  const id = tiktokAdvertiserDigits(advertiserId);
  if (!id) throw new Error("Compte TikTok invalide");
  const currency = knownCurrency ?? (await readTikTokCurrency(id));
  const [campaigns, adGroups] = await Promise.all([listAll("get_campaigns", { advertiser_id: id }), listAll("get_adgroups", { advertiser_id: id, filtering: "{}" })]);
  const names = new Map(campaigns.map((c) => [str(c.campaign_id), str(c.campaign_name)]));
  const live = (r: Row) => str(r.operation_status) !== "DELETE";
  return {
    campaigns: campaigns.filter(live).map((c) => ({ ...campaignState(c, id, currency), parentId: null, bidStrategy: null, spend7d: 0 })),
    adsets: adGroups.filter(live).map((g) => { const { campaignId, ...state } = adGroupState(g, id, currency, names.get(str(g.campaign_id))); return { ...state, parentId: campaignId || null, bidStrategy: null, spend7d: 0 }; }),
    truncated: campaigns.length >= MAX_PAGES * 100 || adGroups.length >= MAX_PAGES * 100,
  };
}

/** The ads of one ad group (read when it is opened). */
export async function readTikTokAds(advertiserId: string, adGroupId: string): Promise<StructureRow[]> {
  const id = tiktokAdvertiserDigits(advertiserId);
  if (!id || !/^\d{5,25}$/.test(adGroupId)) throw new Error("Groupe d'annonces TikTok invalide");
  const ads = await listAll("get_ads", { advertiser_id: id, filtering: JSON.stringify({ adgroup_ids: [adGroupId] }) });
  return ads.filter((a) => str(a.operation_status) !== "DELETE").map((a) => { const { adGroupId: parent, ...state } = adState(a, id); return { ...state, parentId: parent, bidStrategy: null, spend7d: 0 }; });
}

/** One object as TikTok holds it now; null when the advertiser has no such object. */
export async function readTikTokObject(advertiserId: string, objectId: string, type: PilotObjectType, currency?: string): Promise<PilotObjectState | null> {
  const id = tiktokAdvertiserDigits(advertiserId);
  if (!id || !/^\d{5,25}$/.test(objectId) || type === "keyword") return null;
  const cur = currency ?? (await readTikTokCurrency(id));
  if (type === "campaign") {
    const rows = await listAll("get_campaigns", { advertiser_id: id, filtering: JSON.stringify({ campaign_ids: [objectId] }) });
    const c = rows.find((r) => str(r.campaign_id) === objectId);
    return c ? campaignState(c, id, cur) : null;
  }
  if (type === "adset") {
    const rows = await listAll("get_adgroups", { advertiser_id: id, filtering: JSON.stringify({ adgroup_ids: [objectId] }) });
    const g = rows.find((r) => str(r.adgroup_id) === objectId);
    if (!g) return null;
    const { campaignId: _c, ...state } = adGroupState(g, id, cur);
    return state;
  }
  const rows = await listAll("get_ads", { advertiser_id: id, filtering: JSON.stringify({ ad_ids: [objectId] }) });
  const a = rows.find((r) => str(r.ad_id) === objectId);
  if (!a) return null;
  const { adGroupId: _g, ...state } = adState(a, id);
  return state;
}

// ── Writing ──────────────────────────────────────────────────────────────

/** The webhook of the n8n flow that writes to TikTok Ads, or null when it is not configured. */
export function tiktokWriteHook(): { url: string; secret: string } | null {
  const secret = process.env.PILOT_TIKTOK_WEBHOOK_SECRET ?? "";
  let url = process.env.PILOT_TIKTOK_WEBHOOK_URL ?? "";
  if (!url) {
    const alerts = process.env.N8N_ALERT_WEBHOOK_URL ?? "";
    if (/\/impulsemotion-alerts\/?$/.test(alerts)) url = alerts.replace(/\/impulsemotion-alerts\/?$/, "/impulsemotion-tiktok-write");
  }
  return url && secret.length >= 16 ? { url, secret } : null;
}

export const tiktokWritesOpen = () => process.env.PILOT_TIKTOK_WRITES === "1" && process.env.PILOT_WRITES === "1" && !!tiktokWriteHook();

/** One call of the TikTok Business API, as the n8n flow forwards it. */
export interface TikTokMutation {
  /** campaign/status/update | adgroup/status/update | ad/status/update | campaign/update | adgroup/update */
  endpoint: string;
  body: Record<string, unknown>;
}

/** The call that writes `field` = `value` (as ops.ts holds it) on the object; null when the field is not written on TikTok from here. */
export function tiktokMutation(advertiser: string, objectId: string, type: PilotObjectType, field: string, value: string | number, currency: string): TikTokMutation | null {
  const level = type === "campaign" ? "campaign" : type === "adset" ? "adgroup" : type === "ad" ? "ad" : null;
  if (!level) return null;
  const units = (minor: number) => minor / currencyOffset(currency);
  switch (field) {
    case "status": {
      const status = TO_TIKTOK_STATUS[String(value)];
      return status ? { endpoint: `${level}/status/update`, body: { advertiser_id: advertiser, [`${level}_ids`]: [objectId], operation_status: status } } : null;
    }
    case "name":
      if (level === "ad") return null;
      return { endpoint: `${level}/update`, body: { advertiser_id: advertiser, [`${level}_id`]: objectId, [`${level}_name`]: String(value) } };
    case "daily_budget":
    case "lifetime_budget":
      if (level === "ad") return null;
      return { endpoint: `${level}/update`, body: { advertiser_id: advertiser, [`${level}_id`]: objectId, budget: units(Number(value)) } };
    case "bid_amount":
      if (level !== "adgroup") return null;
      return { endpoint: "adgroup/update", body: { advertiser_id: advertiser, adgroup_id: objectId, conversion_bid_price: units(Number(value)), bid_price: units(Number(value)) } };
    case "end_time":
      if (level !== "adgroup") return null;
      return { endpoint: "adgroup/update", body: { advertiser_id: advertiser, adgroup_id: objectId, schedule_end_time: String(value) } };
    default:
      return null;
  }
}

/** One field written on one object of the advertiser. Never throws: the outcome says what happened. */
export async function writeTikTokField(advertiserId: string, objectId: string, type: PilotObjectType, field: string, value: string | number, currency: string): Promise<WriteOutcome> {
  const hook = tiktokWriteHook();
  const id = tiktokAdvertiserDigits(advertiserId);
  if (!hook || !id) return { kind: "refused", error: "L'envoi vers TikTok Ads n'est pas configuré." };
  const mutation = tiktokMutation(id, objectId, type, field, value, currency);
  if (!mutation) return { kind: "refused", error: "Ce changement ne peut pas être envoyé à TikTok Ads depuis ImpulseMotion." };
  let res: Response;
  try {
    res = await fetch(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pilot-Secret": hook.secret },
      body: JSON.stringify({ version: 1, advertiserId: id, ...mutation }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch {
    return { kind: "uncertain", error: "TikTok Ads n'a pas répondu à temps : la modification a peut-être été appliquée. Vérifiez dans TikTok Ads Manager avant de recommencer." };
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; tiktokCode?: number | null } | null;
  if (res.ok && body?.ok) return { kind: "done" };
  // TikTok answers 200 with a code: 0 = applied; any other code = refused with its message.
  if (body && (res.status === 400 || res.status === 401 || (typeof body.tiktokCode === "number" && body.tiktokCode !== 0))) return { kind: "refused", error: `Refusé par TikTok Ads : ${String(body.error ?? res.status).slice(0, 300)}` };
  return { kind: "uncertain", error: `TikTok Ads n'a pas donné de réponse sûre (${res.status}) : la modification a peut-être été appliquée. Vérifiez dans TikTok Ads Manager avant de recommencer.` };
}
