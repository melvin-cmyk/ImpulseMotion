/**
 * TikTok Ads data for the application (dashboards, alerts, cockpit, routines,
 * reports) — read like Google Ads: through the relay's direct call
 * (/api/tool → n8n "TikTok Ads MCP v2.1"), never through a model.
 *
 * The relay reads and completes the arguments (server/mcp-tiktok-args.mjs):
 * one advertiser per report, strict JSON, every parameter checked. The caller
 * checks that the advertiser is in its user's scope BEFORE asking, as for
 * Google (lib/acl.ts, lib/scope.ts).
 *
 * TikTok limits a report to 30 days: longer ranges are cut and summed here.
 * Measured on 2026-10-01: `total_purchase_value` carries the purchase value
 * (Jow: 696 183 € in September) while `complete_payment` stays at 0.
 */

import { TIKTOK_SERVER } from "@/lib/mcp-whitelist";
import { relayDirectTool } from "@/lib/relay-tool";

export interface TikTokStats {
  spend: number;
  impressions: number;
  clicks: number;
  /** Optimisation event of the campaigns ("conversion" in TikTok). */
  conversions: number;
  /** Every purchase event TikTok attributes (total_purchase). */
  purchases: number;
  /** Their value, in the account currency (total_purchase_value). */
  purchaseValue: number;
  videoViews: number;
}

export interface TikTokDailyRow extends TikTokStats {
  /** YYYY-MM-DD, in the account timezone. */
  date: string;
}

export interface TikTokCampaignRow extends TikTokStats {
  id: string;
  name: string;
  objective: string | null;
}

export interface TikTokAdvertiserListing {
  id: string;
  name: string;
  /** Business Centers the account was found in (an account may belong to several). */
  businessCenters: string[];
}

/** The additive metrics read on every report, in TikTok's names. */
const METRICS: Record<keyof TikTokStats, string> = {
  spend: "spend",
  impressions: "impressions",
  clicks: "clicks",
  conversions: "conversion",
  purchases: "total_purchase",
  purchaseValue: "total_purchase_value",
  videoViews: "video_play_actions",
};
const METRIC_NAMES = Object.values(METRICS);
const MAX_DAYS = 30;
const MAX_PAGES = 20;
const TIMEOUT_MS = 30000;

export const emptyTikTokStats = (): TikTokStats => ({ spend: 0, impressions: 0, clicks: 0, conversions: 0, purchases: 0, purchaseValue: 0, videoViews: 0 });

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** TikTok's answer to one report or list call, unwrapped. Throws on a TikTok error. */
export function tiktokEnvelope(result: unknown): { list: Array<Record<string, unknown>>; totalPage: number } {
  const envelope = Array.isArray(result) && result.length === 1 ? result[0] : result;
  if (!envelope || typeof envelope !== "object") throw new Error("Réponse de TikTok illisible.");
  const { code, message, data } = envelope as { code?: unknown; message?: unknown; data?: unknown };
  if (code !== 0) throw new Error(`TikTok ${String(code)} : ${typeof message === "string" ? message.slice(0, 200) : "erreur"}`);
  const d = (data && typeof data === "object" ? data : {}) as { list?: unknown; page_info?: { total_page?: unknown } };
  const list = Array.isArray(d.list) ? d.list.filter((r): r is Record<string, unknown> => !!r && typeof r === "object") : [];
  return { list, totalPage: Math.max(1, num(d.page_info?.total_page)) };
}

/** Stats read from one report row (`metrics` object of TikTok, or a flat row). */
export function statsOf(row: Record<string, unknown>): TikTokStats {
  const m = (row.metrics && typeof row.metrics === "object" ? row.metrics : row) as Record<string, unknown>;
  const out = emptyTikTokStats();
  for (const [key, name] of Object.entries(METRICS) as Array<[keyof TikTokStats, string]>) out[key] = num(m[name]);
  return out;
}

export function addStats(a: TikTokStats, b: TikTokStats): TikTokStats {
  const out = emptyTikTokStats();
  for (const key of Object.keys(out) as Array<keyof TikTokStats>) out[key] = a[key] + b[key];
  return out;
}

const DAY_MS = 86_400_000;
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** [since, until] (YYYY-MM-DD, inclusive) cut into ranges of 30 days at most. */
export function chunkRange(since: string, until: string, maxDays = MAX_DAYS): Array<{ since: string; until: string }> {
  const start = Date.parse(`${since}T00:00:00Z`);
  const end = Date.parse(`${until}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const out: Array<{ since: string; until: string }> = [];
  for (let from = start; from <= end; from += maxDays * DAY_MS) {
    out.push({ since: toDay(from), until: toDay(Math.min(end, from + (maxDays - 1) * DAY_MS)) });
  }
  return out;
}

interface ReportAsk {
  dataLevel: "AUCTION_ADVERTISER" | "AUCTION_CAMPAIGN" | "AUCTION_ADGROUP" | "AUCTION_AD";
  dimensions: string[];
  /** Extra non-additive fields (names…) on top of the additive metrics. */
  extraMetrics?: string[];
}

/** Every row of one report over [since, until], all pages, ranges of 30 days. */
async function reportRows(advertiserId: string, since: string, until: string, ask: ReportAsk): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const range of chunkRange(since, until)) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await relayDirectTool(`${TIKTOK_SERVER}.get_report_integrated`, {
        advertiser_id: advertiserId,
        data_level: ask.dataLevel,
        dimensions: ask.dimensions,
        metrics: [...(ask.extraMetrics ?? []), ...METRIC_NAMES],
        start_date: range.since,
        end_date: range.until,
        page: String(page),
      }, TIMEOUT_MS);
      const { list, totalPage } = tiktokEnvelope(result);
      rows.push(...list);
      if (page >= totalPage) break;
    }
  }
  return rows;
}

const dimension = (row: Record<string, unknown>, key: string): string => {
  const d = (row.dimensions && typeof row.dimensions === "object" ? row.dimensions : row) as Record<string, unknown>;
  const v = d[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
};

/** Totals of one advertiser over the range. */
export async function fetchTikTokTotals(advertiserId: string, since: string, until: string): Promise<TikTokStats> {
  const rows = await reportRows(advertiserId, since, until, { dataLevel: "AUCTION_ADVERTISER", dimensions: ["advertiser_id"] });
  return rows.reduce((acc, r) => addStats(acc, statsOf(r)), emptyTikTokStats());
}

/** One row per day with activity (TikTok leaves out days without any), oldest first. */
export async function fetchTikTokDaily(advertiserId: string, since: string, until: string): Promise<TikTokDailyRow[]> {
  const rows = await reportRows(advertiserId, since, until, { dataLevel: "AUCTION_ADVERTISER", dimensions: ["stat_time_day"] });
  const byDay = new Map<string, TikTokStats>();
  for (const r of rows) {
    const date = dimension(r, "stat_time_day").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    byDay.set(date, addStats(byDay.get(date) ?? emptyTikTokStats(), statsOf(r)));
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, s]) => ({ date, ...s }));
}

/** One row per campaign over the range (ranges longer than 30 days are summed), highest spend first. */
export async function fetchTikTokCampaigns(advertiserId: string, since: string, until: string): Promise<TikTokCampaignRow[]> {
  const rows = await reportRows(advertiserId, since, until, {
    dataLevel: "AUCTION_CAMPAIGN",
    dimensions: ["campaign_id"],
    extraMetrics: ["campaign_name", "objective_type"],
  });
  const byId = new Map<string, TikTokCampaignRow>();
  for (const r of rows) {
    const id = dimension(r, "campaign_id");
    if (!id) continue;
    const m = (r.metrics && typeof r.metrics === "object" ? r.metrics : r) as Record<string, unknown>;
    const prev = byId.get(id);
    const name = typeof m.campaign_name === "string" && m.campaign_name.trim() ? m.campaign_name.trim() : prev?.name ?? id;
    const objective = typeof m.objective_type === "string" && m.objective_type ? m.objective_type : prev?.objective ?? null;
    byId.set(id, { id, name, objective, ...addStats(prev ?? emptyTikTokStats(), statsOf(r)) });
  }
  return [...byId.values()].sort((a, b) => b.spend - a.spend);
}

/**
 * Whether at least one campaign of the advertiser is switched on
 * (operation_status ENABLE). Read page by page, stopping at the first one.
 * Throws on a TikTok error: the scan then reports an error and says nothing.
 */
export async function tiktokHasActiveCampaign(advertiserId: string): Promise<boolean> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { list, totalPage } = tiktokEnvelope(await relayDirectTool(`${TIKTOK_SERVER}.get_campaigns`, { advertiser_id: advertiserId, page: String(page) }, TIMEOUT_MS));
    if (list.some((c) => c.operation_status === "ENABLE")) return true;
    if (page >= totalPage) return false;
  }
  return false;
}

/** All pages of one enumeration call. */
async function enumerate(tool: "list_business_centers" | "list_bc_advertisers", input: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { list, totalPage } = tiktokEnvelope(await relayDirectTool(`${TIKTOK_SERVER}.${tool}`, { ...input, page: String(page) }, TIMEOUT_MS));
    out.push(...list);
    if (page >= totalPage) break;
  }
  return out;
}

let listingCache: { at: number; value: TikTokAdvertiserListing[] } | null = null;
const LISTING_TTL_MS = 10 * 60 * 1000;

/**
 * Every ad account the agency's TikTok token reads, through its Business
 * Centers (an account shared with several of them is listed once). Staff
 * surfaces only: a client never enumerates the agency's accounts.
 */
export async function listTikTokAdvertisers({ fresh = false } = {}): Promise<TikTokAdvertiserListing[]> {
  if (!fresh && listingCache && Date.now() - listingCache.at < LISTING_TTL_MS) return listingCache.value;
  const centers = await enumerate("list_business_centers", {});
  const byId = new Map<string, TikTokAdvertiserListing>();
  for (const c of centers) {
    const info = (c.bc_info && typeof c.bc_info === "object" ? c.bc_info : {}) as Record<string, unknown>;
    const bcId = typeof info.bc_id === "string" ? info.bc_id : "";
    if (!/^\d{5,25}$/.test(bcId)) continue;
    const bcName = typeof info.name === "string" ? info.name : bcId;
    for (const a of await enumerate("list_bc_advertisers", { bc_id: bcId })) {
      const id = typeof a.asset_id === "string" ? a.asset_id : "";
      if (!/^\d{5,25}$/.test(id)) continue;
      const prev = byId.get(id);
      const name = typeof a.asset_name === "string" && a.asset_name.trim() ? a.asset_name.trim() : prev?.name ?? id;
      byId.set(id, { id, name, businessCenters: [...(prev?.businessCenters ?? []), bcName] });
    }
  }
  const value = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  listingCache = { at: Date.now(), value };
  return value;
}
