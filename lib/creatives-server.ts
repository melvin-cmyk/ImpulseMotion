/**
 * Server-side loader for the Analyse Ads creatives (shared by
 * /api/meta/creatives, /api/meta/wow and /api/creatives/analyze).
 *
 * Insights-first pipeline — the ad-level insights list IS the list of
 * creatives; ads metadata is LEFT-joined (an ad whose metadata is missing —
 * deleted, archived, beyond the ads cap — still yields a row named from the
 * insight, format "Unknown").
 *
 * Provenance per field:
 *   - performance: /act/insights level=ad, fully paginated (cap 5000, `truncated` flag)
 *   - copy / headline / landing URL / adset / campaign / created_time / status /
 *     carousel: /act/ads?fields=…creative{…object_story_spec{link_data{…,
 *     child_attachments}}, asset_feed_spec} — fetched here (not via
 *     getAdsFullPaged) so the page size stays small (Meta answers "Please
 *     reduce the amount of data" on heavy creative pages) and
 *     `child_attachments` is available for carousel detection (cap 5000)
 *   - trend: ONE paged daily insights call over the last 14 days ending at
 *     range.until (independent of the preset)
 *   - video URLs: /{video_id}?fields=source, batches of 4, only for ads with
 *     spend > 0 (top VIDEO_SOURCE_MAX by spend; the others fall back to the
 *     Facebook embed player via videoId)
 *   - conversions = purchasesFor(insight, account conversionEvent) → lead-gen
 *     accounts get their leads, e-commerce their purchases
 *   - revenue = computeRevenue with the account AOV: tracked value first; when
 *     the account tracks no value, conversions × AOV (flagged estimated);
 *     without AOV → roas null + roasUnavailable
 *   - status = classifyStatus relative to the account (lib/creative-stats.ts)
 * Cached per account + range + conversionEvent + AOV (KpiCache, ttlForRange).
 */

import {
  metaGraphGet,
  getAdInsightsPaged,
  getAdDailyInsightsBatchPaged,
  getVideoSources,
  getVideoSourcesViaAdCreatives,
  computeRevenue,
  computeCpa,
  computeHookRate,
  computeHoldRate,
  computeVideoDropoff,
  getActionValue,
  purchasesFor,
  getMetaSystemToken,
  type MetaAd,
  type MetaCreativeInsight,
  type MetaAccountInsight,
  type Paged,
} from "@/lib/meta-api";
import { MetaApiError } from "@/lib/meta-errors";
import { getAccountInsightsCached } from "@/lib/insights";
import { getAccountProfileSettings, type AccountProfileSettings } from "@/lib/account-settings";
import { cachedWithMeta, ttlForRange } from "@/lib/kpi-cache";
import { upgradeImageUrl } from "@/lib/image-upgrade";
import { addDays, includesToday, rangeDays as countDays, type DateRange } from "@/lib/date-ranges";
import { accountReference, classifyStatus, weeklyFrequency } from "@/lib/creative-stats";
import type { Creative, CreativesMeta, CreativesPayload, DayMetric, Format } from "@/lib/creative-types";

export type { DateRange };

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TREND_DAYS = 14;
/** Pagination cap for the insights and ads lists (Meta pages of 500 / 200). */
const LIST_MAX = 5000;
/** Video source URLs are resolved for the top N videos by spend (batches of 4). */
const VIDEO_SOURCE_MAX = 300;
const VIDEO_BATCH = 4;

const THUMBNAIL_COLORS = [
  "from-violet-500 to-purple-700",
  "from-blue-500 to-cyan-600",
  "from-pink-500 to-rose-600",
  "from-emerald-500 to-teal-600",
  "from-orange-500 to-amber-600",
  "from-indigo-500 to-violet-600",
];

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
};
const round2 = (v: number) => Math.round(v * 100) / 100;

function firstText(list?: Array<{ text?: string }>): string | undefined {
  return list?.find((t) => t.text?.trim())?.text?.trim();
}

/** Extracts copy + destination from the creative spec (classic or asset feed). */
function creativeCopy(ad: MetaAd): { headline?: string; body?: string; landingUrl?: string } {
  const c = ad.creative;
  if (!c) return {};
  const link = c.object_story_spec?.link_data;
  const video = c.object_story_spec?.video_data;
  const feed = c.asset_feed_spec;
  const headline = c.title || link?.name || video?.title || firstText(feed?.titles) || undefined;
  const body = c.body || link?.message || video?.message || firstText(feed?.bodies) || undefined;
  const landingUrl =
    link?.link || link?.call_to_action?.value?.link || video?.call_to_action?.value?.link || feed?.link_urls?.find((l) => l.website_url)?.website_url || undefined;
  return { headline, body, landingUrl };
}

/** Carousel = several child attachments in the link story (authoritative), else a multi-link asset feed. */
function isCarouselAd(ad: MetaAd): boolean {
  const link = ad.creative?.object_story_spec?.link_data as { child_attachments?: unknown[] } | undefined;
  if (Array.isArray(link?.child_attachments) && link.child_attachments.length > 1) return true;
  return (ad.creative?.asset_feed_spec?.link_urls?.length ?? 0) > 1;
}

// ── Ads metadata (own paging: small pages + child_attachments) ───────────────

const ADS_META_FIELDS = [
  "id", "name", "status", "effective_status", "created_time", "updated_time",
  "adset{id,name}", "campaign{id,name}",
  "creative{id,thumbnail_url,image_url,video_id,object_type,image_hash,body,title,"
    + "object_story_spec{link_data{link,message,name,description,call_to_action,child_attachments{link,name}},"
    + "video_data{link_description,title,message,call_to_action}},"
    + "asset_feed_spec{bodies,titles,descriptions,link_urls}}",
].join(",");
const ADS_PAGE_LIMIT = 100;
const MAX_PAGES = 200;

const isTooMuchData = (e: unknown) => e instanceof MetaApiError && /reduce the amount of data/i.test(e.message);

/**
 * All ads with creative metadata, cursor-paged (limit 100, halved down to 25
 * when Meta answers "Please reduce the amount of data"). `truncated` when the
 * cap is hit.
 */
export async function fetchAdsMeta(token: string, accountId: string, max = LIST_MAX): Promise<Paged<MetaAd>> {
  const act = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
  const out: MetaAd[] = [];
  let after: string | undefined;
  let limit = ADS_PAGE_LIMIT;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = { fields: ADS_META_FIELDS, limit: String(limit) };
    if (after) params.after = after;
    let res: { data?: MetaAd[]; paging?: { cursors?: { after?: string }; next?: string } };
    try {
      res = await metaGraphGet<typeof res>(`/${act}/ads`, token, params);
    } catch (e) {
      if (isTooMuchData(e) && limit > 25) {
        limit = Math.max(25, Math.floor(limit / 2));
        page--;
        continue;
      }
      throw e;
    }
    out.push(...(Array.isArray(res.data) ? res.data : []));
    const next = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!next) break;
    if (out.length >= max) { truncated = true; break; }
    after = next;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { data: out.slice(0, max), truncated: truncated || out.length > max };
}

// ── Revenue policy ───────────────────────────────────────────────────────────

export interface RevenueContext {
  /** Configured AOV or null. */
  aov: number | null;
  conversionEvent: string;
  /** True when the account reports a tracked purchase value in the window. */
  accountTracksValue: boolean;
}

export interface RevenueOutcome {
  /** Known revenue (tracked or estimated); undefined when unknowable. */
  revenue?: number;
  estimated: boolean;
  unavailable: boolean;
}

/**
 * Revenue of one insight row under the account policy:
 *   1. tracked purchase value (action_values / purchase_roas) → real
 *   2. account tracks value but this ad has none → 0 (real, no conversion value)
 *   3. account tracks no value, AOV configured → conversions × AOV (estimated)
 *   4. otherwise → unavailable (roas null)
 */
export function revenueFor(insight: Pick<MetaCreativeInsight, "actions" | "action_values" | "purchase_roas" | "spend">, ctx: RevenueContext): RevenueOutcome {
  const tracked = computeRevenue(insight, null);
  if (!tracked.estimated && tracked.revenue > 0) return { revenue: tracked.revenue, estimated: false, unavailable: false };
  if (ctx.accountTracksValue) return { revenue: 0, estimated: false, unavailable: false };
  if (ctx.aov !== null && ctx.aov > 0) {
    const conv = purchasesFor(insight, ctx.conversionEvent);
    return { revenue: conv * ctx.aov, estimated: true, unavailable: false };
  }
  return { revenue: undefined, estimated: true, unavailable: true };
}

/** True when the account-level row carries a tracked purchase value. */
export function accountTracksValue(account: Pick<MetaAccountInsight, "actions" | "action_values" | "purchase_roas" | "spend"> | null | undefined): boolean {
  if (!account) return false;
  const r = computeRevenue(account, null);
  return !r.estimated && r.revenue > 0;
}

function dayFrom(d: MetaCreativeInsight, ctx: RevenueContext): DayMetric {
  const spend = num(d.spend);
  const rev = revenueFor(d, ctx);
  const conv = purchasesFor(d, ctx.conversionEvent);
  return {
    date: d.date_start,
    spend: Math.round(spend),
    roas: spend > 0 && rev.revenue !== undefined ? round2(rev.revenue / spend) : 0,
    cpa: conv > 0 ? round2(spend / conv) : 0,
    impressions: Math.round(num(d.impressions)),
    clicks: Math.round(num(d.clicks)),
    conversions: Math.round(conv * 10) / 10,
  };
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface RowContext extends RevenueContext {
  rangeDays: number;
}

/**
 * One insight row → Creative (status "Active" until `applyStatus`). `ad` may
 * be undefined (LEFT join): the row is then named from the insight.
 */
export function rowFromInsight(
  insight: MetaCreativeInsight,
  ad: MetaAd | undefined,
  ctx: RowContext,
  extras: { idx?: number; trend?: DayMetric[]; videoUrl?: string } = {},
): Creative {
  const spend = num(insight.spend);
  const impressions = Math.round(num(insight.impressions));
  const clicks = Math.round(num(insight.clicks));
  const ctr = round2(num(insight.ctr));
  const rev = revenueFor(insight, ctx);
  const conv = purchasesFor(insight, ctx.conversionEvent);
  const cpa = computeCpa(insight, ctx.conversionEvent);
  const hasVideoPlays = (insight.video_play_actions?.length ?? 0) > 0;
  const isVideo = !!ad?.creative?.video_id || ad?.creative?.object_type === "VIDEO" || hasVideoPlays;
  const hookRate = isVideo ? computeHookRate(insight) : 0;
  const holdRate = isVideo ? computeHoldRate(insight) : 0;
  const { p25, p50, p75 } = computeVideoDropoff(insight);
  const format: Format = isVideo ? "Video" : !ad ? "Unknown" : isCarouselAd(ad) ? "Carousel" : "Image";
  const rawThumb = ad ? (isVideo ? ad.creative?.thumbnail_url : ad.creative?.image_url || ad.creative?.thumbnail_url) : undefined;
  const copy = ad ? creativeCopy(ad) : {};
  const frequency = insight.frequency ? round2(num(insight.frequency)) : undefined;
  const roas = spend > 0 && rev.revenue !== undefined ? round2(rev.revenue / spend) : null;

  return {
    id: insight.ad_id,
    name: ad?.name ?? insight.ad_name ?? insight.ad_id,
    platform: "Meta",
    format,
    status: "Active",
    thumbnailColor: THUMBNAIL_COLORS[(extras.idx ?? 0) % THUMBNAIL_COLORS.length],
    thumbnailUrl: rawThumb ? upgradeImageUrl(rawThumb) : undefined,
    videoUrl: extras.videoUrl,
    videoId: ad?.creative?.video_id ?? undefined,
    campaignId: insight.campaign_id ?? ad?.campaign?.id,
    campaignName: insight.campaign_name ?? ad?.campaign?.name,
    adsetId: insight.adset_id ?? ad?.adset?.id,
    adsetName: insight.adset_name ?? ad?.adset?.name,
    effectiveStatus: ad?.effective_status ?? ad?.status,
    createdTime: ad?.created_time,
    headline: copy.headline,
    body: copy.body,
    landingUrl: copy.landingUrl,
    spend: Math.round(spend),
    roas,
    roasEstimated: rev.estimated,
    roasUnavailable: rev.unavailable || undefined,
    revenue: rev.revenue !== undefined ? Math.round(rev.revenue) : undefined,
    cpa,
    ctr,
    hookRate,
    holdRate,
    videoP25Rate: isVideo ? p25 : undefined,
    videoP50Rate: isVideo ? p50 : undefined,
    videoP75Rate: isVideo ? p75 : undefined,
    impressions,
    reach: insight.reach ? Math.round(num(insight.reach)) : undefined,
    frequency,
    frequencyWeekly: weeklyFrequency(frequency, ctx.rangeDays) ?? undefined,
    clicks,
    linkClicks: insight.inline_link_clicks ? Math.round(num(insight.inline_link_clicks)) : undefined,
    conversions: Math.round(conv * 10) / 10,
    threeSecViews: isVideo ? getActionValue(insight.video_play_actions, "video_view") : 0,
    thruplays: isVideo ? getActionValue(insight.video_thruplay_watched_actions, "video_view") : 0,
    trend: extras.trend ?? [],
  };
}

/** Sets Winner/Loser/Fatigued/Active relative to the whole list (mutates and returns). */
export function applyStatus(rows: Creative[]): Creative[] {
  const ref = accountReference(rows);
  for (const r of rows) r.status = classifyStatus(r, ref);
  return rows;
}

// ── Video sources (batches of 4, top spenders only) ──────────────────────────

async function resolveVideoSources(token: string, rows: Creative[], adsById: Map<string, MetaAd>): Promise<Map<string, string>> {
  const candidates = rows
    .filter((r) => r.spend > 0 && !!adsById.get(r.id)?.creative?.video_id)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, VIDEO_SOURCE_MAX);
  const videoIds = [...new Set(candidates.map((r) => adsById.get(r.id)!.creative!.video_id!))];
  const sources = new Map<string, string>();
  for (let i = 0; i < videoIds.length; i += VIDEO_BATCH) {
    const batch = await getVideoSources(token, videoIds.slice(i, i + VIDEO_BATCH)).catch(() => new Map<string, string>());
    for (const [k, v] of batch) sources.set(k, v);
  }
  const missingAds = candidates.filter((r) => !sources.get(adsById.get(r.id)!.creative!.video_id!)).map((r) => r.id);
  for (let i = 0; i < missingAds.length; i += VIDEO_BATCH) {
    const fallback = await getVideoSourcesViaAdCreatives(token, missingAds.slice(i, i + VIDEO_BATCH)).catch(() => new Map<string, string>());
    for (const [k, v] of fallback) if (!sources.has(k)) sources.set(k, v);
  }
  return sources;
}

// ── Build ────────────────────────────────────────────────────────────────────

/** `hasData: false` lets the KpiCache store an empty list with its short TTL (60 s) instead of 24 h. */
type BuiltPayload = { creatives: Creative[]; meta: Omit<CreativesMeta, "fetchedAt" | "fromCache">; hasData?: boolean };

function accountTotalsOf(account: MetaAccountInsight, ctx: RevenueContext) {
  const rev = revenueFor(account, ctx);
  return {
    spend: round2(num(account.spend)),
    impressions: Math.round(num(account.impressions)),
    purchases: purchasesFor(account, ctx.conversionEvent),
    revenue: rev.revenue !== undefined ? round2(rev.revenue) : 0,
  };
}

/** Full build (ads metadata + trend + video sources). Not cached — see loadCreatives. */
export async function buildCreatives(accountId: string, range: DateRange, settings?: AccountProfileSettings): Promise<BuiltPayload> {
  const token = getMetaSystemToken();
  const id = accountId.replace(/^act_/, "");
  const s = settings ?? (await getAccountProfileSettings("meta", id));
  const days = countDays(range);
  const trendRange: DateRange = { since: addDays(range.until, -(TREND_DAYS - 1)), until: range.until };

  const [insightsPaged, adsPaged, dailyPaged, account] = await Promise.all([
    getAdInsightsPaged(token, accountId, range, { max: LIST_MAX }),
    fetchAdsMeta(token, accountId, LIST_MAX),
    getAdDailyInsightsBatchPaged(token, accountId, trendRange).catch((): Paged<MetaCreativeInsight> => ({ data: [], truncated: false })),
    getAccountInsightsCached(token, accountId, range),
  ]);

  const ctx: RowContext = {
    aov: s.aov,
    conversionEvent: s.conversionEvent,
    accountTracksValue: accountTracksValue(account),
    rangeDays: days,
  };

  const adsById = new Map(adsPaged.data.map((a) => [a.id, a]));
  const withData = insightsPaged.data.filter((i) => num(i.impressions) > 0).sort((a, b) => num(b.spend) - num(a.spend));

  const trendByAd = new Map<string, DayMetric[]>();
  for (const d of dailyPaged.data) {
    const list = trendByAd.get(d.ad_id) ?? [];
    list.push(dayFrom(d, ctx));
    trendByAd.set(d.ad_id, list);
  }
  for (const list of trendByAd.values()) list.sort((a, b) => a.date.localeCompare(b.date));

  const rows = withData.map((insight, idx) => rowFromInsight(insight, adsById.get(insight.ad_id), ctx, { idx, trend: trendByAd.get(insight.ad_id) }));
  applyStatus(rows);

  const sources = await resolveVideoSources(token, rows, adsById);
  for (const r of rows) {
    if (r.videoId && sources.has(r.videoId)) r.videoUrl = sources.get(r.videoId);
  }

  return {
    creatives: rows,
    hasData: rows.length > 0,
    meta: {
      truncated: insightsPaged.truncated || adsPaged.truncated,
      currency: s.currency ?? account.currency ?? null,
      timezone: s.timezone,
      conversionEvent: s.conversionEvent,
      range,
      rangeDays: days,
      partialDay: includesToday(range, { tz: s.timezone }),
      adCount: rows.length,
      adCountWithSpend: rows.filter((r) => r.spend > 0).length,
      accountTotals: accountTotalsOf(account, ctx),
      aov: s.aov,
    },
  };
}

/**
 * Light build for WoW-style comparisons: insights + account totals only (no
 * ads metadata, no trend, no video). Same conversion / revenue policy.
 */
export async function buildCreativeRows(accountId: string, range: DateRange, settings?: AccountProfileSettings): Promise<BuiltPayload> {
  const token = getMetaSystemToken();
  const id = accountId.replace(/^act_/, "");
  const s = settings ?? (await getAccountProfileSettings("meta", id));
  const days = countDays(range);
  const [insightsPaged, account] = await Promise.all([
    getAdInsightsPaged(token, accountId, range, { max: LIST_MAX }),
    getAccountInsightsCached(token, accountId, range),
  ]);
  const ctx: RowContext = { aov: s.aov, conversionEvent: s.conversionEvent, accountTracksValue: accountTracksValue(account), rangeDays: days };
  const rows = insightsPaged.data
    .filter((i) => num(i.impressions) > 0)
    .sort((a, b) => num(b.spend) - num(a.spend))
    .map((insight, idx) => rowFromInsight(insight, undefined, ctx, { idx }));
  applyStatus(rows);
  return {
    creatives: rows,
    hasData: rows.length > 0,
    meta: {
      truncated: insightsPaged.truncated,
      currency: s.currency ?? account.currency ?? null,
      timezone: s.timezone,
      conversionEvent: s.conversionEvent,
      range,
      rangeDays: days,
      partialDay: includesToday(range, { tz: s.timezone }),
      adCount: rows.length,
      adCountWithSpend: rows.filter((r) => r.spend > 0).length,
      accountTotals: accountTotalsOf(account, ctx),
      aov: s.aov,
    },
  };
}

// ── Cache ────────────────────────────────────────────────────────────────────

/** KpiCache key for the creatives payload of one account + range + conversion policy. */
export function creativesCacheKey(accountId: string, range: DateRange, conversionEvent: string, aov: number | null, variant: "full" | "light" = "full"): string {
  const id = accountId.replace(/^act_/, "");
  const base = `meta:creatives:v3:${id}:${range.since}_${range.until}:${conversionEvent}:${aov ?? "na"}`;
  return variant === "full" ? base : `${base}:light`;
}

async function loadWith(
  accountId: string,
  range: DateRange,
  refresh: boolean,
  variant: "full" | "light",
): Promise<CreativesPayload> {
  const settings = await getAccountProfileSettings("meta", accountId.replace(/^act_/, ""));
  const key = creativesCacheKey(accountId, range, settings.conversionEvent, settings.aov, variant);
  const build = variant === "full" ? buildCreatives : buildCreativeRows;
  const result = await cachedWithMeta<BuiltPayload>(key, () => build(accountId, range, settings), {
    ttlMs: ttlForRange(range, { tz: settings.timezone }),
    refresh,
  });
  return {
    creatives: result.data.creatives,
    meta: { ...result.data.meta, fetchedAt: result.fetchedAt, fromCache: result.fromCache },
  };
}

/** Cached creatives + meta for an account + range; `refresh` bypasses the cache read. */
export function loadCreatives(accountId: string, range: DateRange, refresh = false): Promise<CreativesPayload> {
  return loadWith(accountId, range, refresh, "full");
}

/** Cached light rows (no metadata / trend / video) for comparisons such as WoW. */
export function loadCreativeRows(accountId: string, range: DateRange, refresh = false): Promise<CreativesPayload> {
  return loadWith(accountId, range, refresh, "light");
}
