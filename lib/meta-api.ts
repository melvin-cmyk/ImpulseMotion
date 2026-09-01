/**
 * Meta Marketing API client
 * Docs: https://developers.facebook.com/docs/marketing-api/reference
 *
 * Reliability contract (Lot F1):
 * - every Graph call goes through `metaFetch`: bounded concurrency
 *   (META_MAX_CONCURRENCY, default 4), 25 s timeout, typed `MetaApiError`,
 *   retries ONLY when the error is retryable (rate limit / transient);
 * - fetchers NEVER swallow errors into null/[] — an error propagates so the
 *   cache layer never stores an empty payload produced by a failure;
 * - "no data" (`data: []`) is a legit result: `getAccountInsights` returns a
 *   zero-filled row flagged `hasData: false`;
 * - list endpoints paginate; the `*Paged` variants expose `truncated`.
 */

import { MetaApiError } from "@/lib/meta-errors";

const META_API_BASE = "https://graph.facebook.com/v22.0";

/**
 * Returns the shared Meta System User token used server-side for all clients.
 * This token is owned by the ImpulseMotion Business Manager; per-client scoping
 * is enforced by the UserAdAccount ACL table, never by the token itself.
 */
export function getMetaSystemToken(): string {
  const tok = process.env.META_SYSTEM_TOKEN || process.env.META_SHARED_TOKEN;
  if (!tok) throw new Error("META_SYSTEM_TOKEN is not configured");
  return tok;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface MetaAdAccount {
  id: string;
  name: string;
  currency: string;
  spend_cap?: string;
}

export interface MetaCreativeInsight {
  ad_id: string;
  ad_name: string;
  adset_id: string;
  adset_name?: string;
  campaign_id: string;
  campaign_name?: string;
  reach?: string;
  frequency?: string;
  inline_link_clicks?: string;
  spend: string;
  impressions: string;
  clicks: string;
  ctr: string;
  cpc: string;
  cpm: string;
  account_currency?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
  purchase_roas?: Array<{ action_type: string; value: string }>;
  cost_per_action_type?: Array<{ action_type: string; value: string }>;
  video_play_actions?: Array<{ action_type: string; value: string }>;
  video_thruplay_watched_actions?: Array<{ action_type: string; value: string }>;
  video_p25_watched_actions?: Array<{ action_type: string; value: string }>;
  video_p50_watched_actions?: Array<{ action_type: string; value: string }>;
  video_p75_watched_actions?: Array<{ action_type: string; value: string }>;
  date_start: string;
  date_stop: string;
}

export interface MetaAdCreativeText {
  text?: string;
}

export interface MetaAd {
  id: string;
  name: string;
  status: string;
  effective_status?: string;
  created_time?: string;
  updated_time?: string;
  adset?: { id: string; name: string };
  campaign?: { id: string; name: string };
  creative?: {
    id: string;
    thumbnail_url?: string;
    image_url?: string;
    video_id?: string;
    object_type?: string;
    body?: string;
    title?: string;
    object_story_spec?: {
      link_data?: { link?: string; message?: string; name?: string; description?: string; call_to_action?: { type?: string; value?: { link?: string } } };
      video_data?: { link_description?: string; title?: string; message?: string; call_to_action?: { type?: string; value?: { link?: string } } };
    };
    asset_feed_spec?: {
      bodies?: MetaAdCreativeText[];
      titles?: MetaAdCreativeText[];
      descriptions?: MetaAdCreativeText[];
      link_urls?: Array<{ website_url?: string; display_url?: string }>;
    };
    /** The story ID can be used to resolve a higher-res image when image_url is absent */
    effective_object_story_id?: string;
    /** MD5 hash of the creative image — can be used with /adimages?hashes[] for full-res URL */
    image_hash?: string;
  };
}

export interface MetaCampaign {
  id: string;
  name: string;
  status: string;
  objective?: string;
}

/** Result of a paginated read. `truncated` = more rows existed beyond `max`. */
export interface Paged<T> {
  data: T[];
  truncated: boolean;
}

export interface PagedOptions {
  /** Hard cap on rows returned (default META_DEFAULT_MAX). */
  max?: number;
}

/** Generous default: complete lists for any realistic account. */
export const META_DEFAULT_MAX = 5000;

// ── Concurrency limiter (per process) ────────────────────────────────────────

function readConcurrency(): number {
  const n = parseInt(process.env.META_MAX_CONCURRENCY ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

const MAX_CONCURRENCY = readConcurrency();
let activeSlots = 0;
const slotWaiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activeSlots < MAX_CONCURRENCY) {
    activeSlots++;
    return;
  }
  await new Promise<void>((resolve) => slotWaiters.push(resolve));
  activeSlots++;
}

function releaseSlot(): void {
  activeSlots = Math.max(0, activeSlots - 1);
  const next = slotWaiters.shift();
  if (next) next();
}

/** Runs `fn` inside the Graph concurrency limiter. */
export async function withMetaSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

/** Test/observability hook. */
export function metaLimiterState(): { active: number; waiting: number; max: number } {
  return { active: activeSlots, waiting: slotWaiters.length, max: MAX_CONCURRENCY };
}

// ── Core fetch ───────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 4;
const MAX_BACKOFF_MS = 30_000;

function retryBaseMs(): number {
  const n = Number(process.env.META_RETRY_BASE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
    error_user_msg?: string;
  };
}

type OnceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MetaApiError; retryAfterMs?: number };

function parseRetryAfter(res: Response): number | undefined {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  // x-business-use-case-usage: {"<bm_id>":[{"estimated_time_to_regain_access": <minutes>, ...}]}
  const usage = res.headers.get("x-business-use-case-usage");
  if (usage) {
    try {
      const parsed = JSON.parse(usage) as Record<string, Array<{ estimated_time_to_regain_access?: number }>>;
      let minutes = 0;
      for (const list of Object.values(parsed)) {
        for (const u of list ?? []) {
          if (typeof u.estimated_time_to_regain_access === "number") {
            minutes = Math.max(minutes, u.estimated_time_to_regain_access);
          }
        }
      }
      if (minutes > 0) return minutes * 60_000;
    } catch { /* ignore malformed header */ }
  }
  return undefined;
}

async function metaRequestOnce<T>(url: string, path: string): Promise<OnceResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    const isTimeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      ok: false,
      error: new MetaApiError({
        message: isTimeout ? `Meta API timeout after ${REQUEST_TIMEOUT_MS} ms` : `Meta API unreachable: ${e instanceof Error ? e.message : String(e)}`,
        httpStatus: 0,
        path,
        cause: e,
      }),
    };
  }

  // Parse the body regardless of status: Meta sends error details with 400s,
  // and occasionally an `error` object with HTTP 200.
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const errObj = (body as MetaErrorBody | null)?.error;
  if (errObj && typeof errObj === "object") {
    return {
      ok: false,
      error: new MetaApiError({
        message: errObj.message ?? errObj.error_user_msg ?? `Meta API error ${res.status}`,
        code: errObj.code,
        subcode: errObj.error_subcode,
        httpStatus: res.status,
        fbtraceId: errObj.fbtrace_id,
        path,
      }),
      retryAfterMs: parseRetryAfter(res),
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: new MetaApiError({ message: `Meta API HTTP ${res.status}`, httpStatus: res.status, path }),
      retryAfterMs: parseRetryAfter(res),
    };
  }
  return { ok: true, value: body as T };
}

async function metaFetch<T>(
  path: string,
  accessToken: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${META_API_BASE}${path}`);
  url.searchParams.set("access_token", accessToken);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const target = url.toString();

  let lastError: MetaApiError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await withMetaSlot(() => metaRequestOnce<T>(target, path));
    if (result.ok) return result.value;
    lastError = result.error;
    const last = attempt === MAX_ATTEMPTS || !result.error.retryable;
    console.warn(`[meta-api] ${path} attempt ${attempt}/${MAX_ATTEMPTS} ${result.error.describe()}${last ? "" : " → retry"}`);
    if (last) break;
    const base = retryBaseMs();
    const backoff = base * 2 ** (attempt - 1) + Math.random() * base * 0.5;
    const wait = Math.min(Math.max(backoff, result.retryAfterMs ?? 0), MAX_BACKOFF_MS);
    await sleep(wait);
  }
  throw lastError ?? new MetaApiError({ message: "Meta API unreachable", httpStatus: 0, path });
}

/**
 * Public raw GET on the Graph API (limiter + retry + typed errors). Use this
 * instead of `fetch(graph.facebook.com/...)` anywhere in the app.
 */
export function metaGraphGet<T>(
  path: string,
  accessToken: string,
  params: Record<string, string> = {},
): Promise<T> {
  return metaFetch<T>(path, accessToken, params);
}

/** Follows Graph API cursor paging until `max` rows or no next page. */
async function metaFetchAll<T>(
  path: string,
  accessToken: string,
  params: Record<string, string>,
  max: number,
): Promise<Paged<T>> {
  const MAX_PAGES = 200;
  const out: T[] = [];
  let after: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await metaFetch<{ data?: T[]; paging?: { cursors?: { after?: string }; next?: string } }>(
      path,
      accessToken,
      after ? { ...params, after } : params,
    );
    out.push(...(Array.isArray(data.data) ? data.data : []));
    const nextCursor = data.paging?.next ? data.paging.cursors?.after : undefined;
    if (!nextCursor) break;
    if (out.length >= max) {
      truncated = true;
      break;
    }
    after = nextCursor;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  if (out.length > max) truncated = true;
  return { data: out.slice(0, max), truncated };
}

const actId = (adAccountId: string) => (adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`);

/** Common params for every /insights call. */
const INSIGHTS_COMMON: Record<string, string> = { use_unified_attribution_setting: "true" };

function todayUtc(): string {
  return new Date().toISOString().split("T")[0];
}
function daysAgoUtc(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split("T")[0];
}

// ── Account profile ──────────────────────────────────────────────────────────

export interface MetaAccountProfile {
  id: string;
  name: string;
  currency: string;
  timezone_name: string;
  timezone_offset_hours_utc: number;
}

/** GET /act_X?fields=name,currency,timezone_name,timezone_offset_hours_utc */
export async function getAccountProfile(accessToken: string, adAccountId: string): Promise<MetaAccountProfile> {
  const id = actId(adAccountId);
  const data = await metaFetch<{
    id?: string; name?: string; currency?: string; timezone_name?: string; timezone_offset_hours_utc?: number;
  }>(`/${id}`, accessToken, { fields: "name,currency,timezone_name,timezone_offset_hours_utc" });
  return {
    id: data.id ?? id,
    name: data.name ?? id,
    currency: data.currency ?? "",
    timezone_name: data.timezone_name ?? "",
    timezone_offset_hours_utc: typeof data.timezone_offset_hours_utc === "number" ? data.timezone_offset_hours_utc : 0,
  };
}

// ── Campaigns / accounts / ads (lists) ───────────────────────────────────────

export async function getCampaignsPaged(
  accessToken: string,
  adAccountId: string,
  opts: PagedOptions = {},
): Promise<Paged<MetaCampaign>> {
  return metaFetchAll<MetaCampaign>(`/${actId(adAccountId)}/campaigns`, accessToken, {
    fields: "id,name,status,objective",
    limit: "500",
  }, opts.max ?? META_DEFAULT_MAX);
}

/** List campaigns for an ad account (fully paginated; `_limit` kept for signature compat). */
export async function getCampaigns(
  accessToken: string,
  adAccountId: string,
  _limit = 100,
): Promise<MetaCampaign[]> {
  void _limit;
  return (await getCampaignsPaged(accessToken, adAccountId)).data;
}

export async function getAdAccountsPaged(
  accessToken: string,
  opts: PagedOptions = {},
): Promise<Paged<MetaAdAccount>> {
  return metaFetchAll<MetaAdAccount>("/me/adaccounts", accessToken, {
    fields: "id,name,currency,spend_cap",
    limit: "500",
  }, opts.max ?? META_DEFAULT_MAX);
}

/** List ad accounts accessible to the token (fully paginated). */
export async function getAdAccounts(accessToken: string): Promise<MetaAdAccount[]> {
  return (await getAdAccountsPaged(accessToken)).data;
}

const ADS_BASIC_FIELDS =
  "id,name,status,creative{id,thumbnail_url,image_url,video_id,object_type,effective_object_story_id,image_hash}";

export async function getAdsPaged(
  accessToken: string,
  adAccountId: string,
  opts: PagedOptions = {},
): Promise<Paged<MetaAd>> {
  return metaFetchAll<MetaAd>(`/${actId(adAccountId)}/ads`, accessToken, {
    fields: ADS_BASIC_FIELDS,
    limit: "200",
  }, opts.max ?? META_DEFAULT_MAX);
}

/** Get ads for an account with creative info (fully paginated; `_limit` kept for signature compat). */
export async function getAds(
  accessToken: string,
  adAccountId: string,
  _limit = 50,
): Promise<MetaAd[]> {
  void _limit;
  return (await getAdsPaged(accessToken, adAccountId)).data;
}

const ADS_FULL_FIELDS = [
  "id", "name", "status", "effective_status", "created_time", "updated_time",
  "adset{id,name}", "campaign{id,name}",
  "creative{id,thumbnail_url,image_url,video_id,object_type,image_hash,body,title,"
    + "object_story_spec{link_data{link,message,name,description,call_to_action},video_data{link_description,title,message,call_to_action}},"
    + "asset_feed_spec{bodies,titles,descriptions,link_urls}}",
].join(",");

/** All ads with creative copy, landing URL, adset/campaign names and dates — with `truncated`. */
export async function getAdsFullPaged(
  accessToken: string,
  adAccountId: string,
  opts: PagedOptions = {},
): Promise<Paged<MetaAd>> {
  return metaFetchAll<MetaAd>(`/${actId(adAccountId)}/ads`, accessToken, {
    fields: ADS_FULL_FIELDS,
    limit: "200",
  }, opts.max ?? META_DEFAULT_MAX);
}

/** All ads of an account with creative copy, landing URL, adset/campaign names and dates (paged). */
export async function getAdsFull(
  accessToken: string,
  adAccountId: string,
  max = META_DEFAULT_MAX,
): Promise<MetaAd[]> {
  return (await getAdsFullPaged(accessToken, adAccountId, { max })).data;
}

// ── Ad-level insights ────────────────────────────────────────────────────────

const AD_INSIGHT_FIELDS = [
  "ad_id", "ad_name", "adset_id", "adset_name", "campaign_id", "campaign_name",
  "spend", "impressions", "reach", "frequency", "clicks", "inline_link_clicks", "ctr", "cpc", "cpm",
  "account_currency",
  "actions", "action_values", "purchase_roas", "cost_per_action_type",
  "video_play_actions", "video_thruplay_watched_actions",
  "video_p25_watched_actions", "video_p50_watched_actions", "video_p75_watched_actions",
].join(",");

/** Ad-level insights for a period, paged, with `truncated`. No timeRange → last_30d. */
export async function getAdInsightsPaged(
  accessToken: string,
  adAccountId: string,
  timeRange?: { since: string; until: string },
  opts: PagedOptions = {},
): Promise<Paged<MetaCreativeInsight>> {
  const params: Record<string, string> = {
    ...INSIGHTS_COMMON,
    fields: AD_INSIGHT_FIELDS,
    level: "ad",
    limit: "500",
  };
  if (timeRange) params.time_range = JSON.stringify({ since: timeRange.since, until: timeRange.until });
  else params.date_preset = "last_30d";
  return metaFetchAll<MetaCreativeInsight>(`/${actId(adAccountId)}/insights`, accessToken, params, opts.max ?? META_DEFAULT_MAX);
}

/** Get insights (metrics) for ads — last 30 days by default (fully paginated; `_limit` kept for compat). */
export async function getAdInsights(
  accessToken: string,
  adAccountId: string,
  timeRange?: { since: string; until: string },
  _limit = 50,
): Promise<MetaCreativeInsight[]> {
  void _limit;
  return (await getAdInsightsPaged(accessToken, adAccountId, timeRange)).data;
}

/** Ad-level insights for a period, paged (no 50-row truncation). */
export async function getAdInsightsAll(
  accessToken: string,
  adAccountId: string,
  timeRange: { since: string; until: string },
  max = META_DEFAULT_MAX,
): Promise<MetaCreativeInsight[]> {
  return (await getAdInsightsPaged(accessToken, adAccountId, timeRange, { max })).data;
}

/** Get day-by-day insights for a specific ad (for sparklines). */
export async function getAdDailyInsights(
  accessToken: string,
  adId: string,
  days = 7,
): Promise<MetaCreativeInsight[]> {
  const timeRange = JSON.stringify({ since: daysAgoUtc(days), until: todayUtc() });
  const res = await metaFetchAll<MetaCreativeInsight>(`/${adId}/insights`, accessToken, {
    ...INSIGHTS_COMMON,
    fields: "spend,impressions,clicks,ctr,actions,cost_per_action_type",
    time_increment: "1",
    time_range: timeRange,
    limit: "500",
  }, 1000);
  return res.data;
}

/** Daily ad-level rows for a period, with `truncated`. */
export async function getAdDailyInsightsBatchPaged(
  accessToken: string,
  adAccountId: string,
  timeRange: { since: string; until: string },
  opts: PagedOptions = {},
): Promise<Paged<MetaCreativeInsight>> {
  return metaFetchAll<MetaCreativeInsight>(`/${actId(adAccountId)}/insights`, accessToken, {
    ...INSIGHTS_COMMON,
    fields: "ad_id,spend,impressions,clicks,ctr,actions,action_values,purchase_roas,cost_per_action_type",
    level: "ad",
    time_increment: "1",
    limit: "500",
    time_range: JSON.stringify(timeRange),
  }, opts.max ?? 10000);
}

/** Daily ad-level rows for a period in ONE paged call (replaces the per-ad N+1). */
export async function getAdDailyInsightsBatch(
  accessToken: string,
  adAccountId: string,
  timeRange: { since: string; until: string },
  max = 10000,
): Promise<MetaCreativeInsight[]> {
  return (await getAdDailyInsightsBatchPaged(accessToken, adAccountId, timeRange, { max })).data;
}

// ── Video sources (best-effort media resolution, per-item failures logged) ───

/**
 * Batch-fetch video source URLs for a list of video IDs.
 * Returns a map of videoId → source URL.
 * Logs warnings for individual failures rather than silently swallowing them.
 */
export async function getVideoSources(
  accessToken: string,
  videoIds: string[]
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  if (videoIds.length === 0) return results;

  await Promise.allSettled(
    videoIds.map(async (videoId) => {
      try {
        // Primary: GET /{video_id}?fields=source,thumbnails
        const data = await metaFetch<{
          source?: string;
          thumbnails?: { data: Array<{ uri: string; is_preferred: boolean }> };
        }>(`/${videoId}`, accessToken, { fields: "source,thumbnails" });

        if (data.source) {
          results.set(videoId, data.source);
          return;
        }

        // Fallback: use the preferred thumbnail CDN URL as a last resort
        // (not a playable URL, but at least surfaced as a debugging signal)
        const preferred = data.thumbnails?.data?.find((t) => t.is_preferred);
        if (preferred?.uri) {
          console.warn(
            `[meta-api] video ${videoId}: no source URL returned, falling back to thumbnail URI`
          );
          // We do NOT set this as the video source — a thumbnail is not playable.
          // The calling code should treat a missing videoUrl entry as "video unavailable".
        } else {
          console.warn(
            `[meta-api] video ${videoId}: GET /{video_id}?fields=source returned no source field`,
            JSON.stringify(data)
          );
        }
      } catch (err) {
        console.error(
          `[meta-api] video ${videoId}: failed to fetch source URL —`,
          err instanceof Error ? err.message : err
        );
      }
    })
  );

  return results;
}

/**
 * Fetch video source URLs via the adcreatives edge as a fallback.
 * Calls GET /{ad_id}/adcreatives?fields=video_data then resolves each video_id.
 * Returns a map of videoId → source URL.
 */
export async function getVideoSourcesViaAdCreatives(
  accessToken: string,
  adIds: string[]
): Promise<Map<string, string>> {
  const videoIdToSource = new Map<string, string>();
  if (adIds.length === 0) return videoIdToSource;

  // Step 1: collect video_ids from adcreatives edge
  const adIdToVideoId = new Map<string, string>();
  await Promise.allSettled(
    adIds.map(async (adId) => {
      try {
        const data = await metaFetch<{
          data: Array<{ video_data?: { video_id?: string } }>;
        }>(`/${adId}/adcreatives`, accessToken, { fields: "video_data" });
        const videoId = data.data?.[0]?.video_data?.video_id;
        if (videoId) {
          adIdToVideoId.set(adId, videoId);
        }
      } catch (err) {
        console.error(
          `[meta-api] ad ${adId}: failed to fetch adcreatives —`,
          err instanceof Error ? err.message : err
        );
      }
    })
  );

  // Step 2: deduplicate and fetch source for each unique video_id
  const uniqueVideoIds = [...new Set(adIdToVideoId.values())];
  const sourceMap = await getVideoSources(accessToken, uniqueVideoIds);

  for (const [, videoId] of adIdToVideoId) {
    const src = sourceMap.get(videoId);
    if (src) videoIdToSource.set(videoId, src);
  }

  return videoIdToSource;
}

// ── Account-level insights ───────────────────────────────────────────────────

/** Account-level aggregated insights over a window. Used for portfolio + alerts. */
export interface MetaAccountInsight {
  account_id: string;
  spend: string;
  impressions: string;
  clicks: string;
  ctr: string;
  cpm: string;
  reach?: string;
  frequency?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
  purchase_roas?: Array<{ action_type: string; value: string }>;
  cost_per_action_type?: Array<{ action_type: string; value: string }>;
  date_start: string;
  date_stop: string;
  /** ISO 4217 code from `account_currency` (undefined when Meta returned no row). */
  currency?: string;
  /** false when Meta returned `data: []` for the window → zero-filled row. */
  hasData?: boolean;
}

const ACCOUNT_INSIGHT_FIELDS = [
  "account_currency",
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "cpm",
  "reach",
  "frequency",
  "actions",
  "action_values",
  "purchase_roas",
  "cost_per_action_type",
].join(",");

type RawAccountInsight = Omit<MetaAccountInsight, "account_id" | "currency" | "hasData"> & {
  account_id?: string;
  account_currency?: string;
};

function normalizeAccountRow(row: RawAccountInsight, accountId: string): MetaAccountInsight {
  const { account_currency, ...rest } = row;
  return { ...rest, account_id: accountId, currency: account_currency, hasData: true };
}

/** Zero-filled row for a window with no delivery — NOT an error. */
export function emptyAccountInsight(
  accountId: string,
  range: { since: string; until: string },
  currency?: string,
): MetaAccountInsight {
  return {
    account_id: actId(accountId),
    spend: "0",
    impressions: "0",
    clicks: "0",
    ctr: "0",
    cpm: "0",
    reach: "0",
    frequency: "0",
    actions: [],
    action_values: [],
    purchase_roas: [],
    cost_per_action_type: [],
    date_start: range.since,
    date_stop: range.until,
    currency,
    hasData: false,
  };
}

/**
 * Account-level insights for a window. Never returns null: errors propagate
 * (typed `MetaApiError`), "no data" yields a zero-filled row (`hasData: false`).
 */
export async function getAccountInsights(
  accessToken: string,
  adAccountId: string,
  timeRange?: { since: string; until: string },
): Promise<MetaAccountInsight> {
  const accountId = actId(adAccountId);
  const params: Record<string, string> = {
    ...INSIGHTS_COMMON,
    fields: ACCOUNT_INSIGHT_FIELDS,
    level: "account",
    limit: "1",
  };
  const effectiveRange = timeRange ?? { since: daysAgoUtc(30), until: todayUtc() };
  if (timeRange) params.time_range = JSON.stringify(timeRange);
  else params.date_preset = "last_30d";

  const data = await metaFetch<{ data?: RawAccountInsight[] }>(`/${accountId}/insights`, accessToken, params);
  const row = Array.isArray(data.data) ? data.data[0] : undefined;
  if (!row) return emptyAccountInsight(accountId, effectiveRange);
  return normalizeAccountRow(row, accountId);
}

export interface MetaCampaignInsight extends MetaAccountInsight {
  campaign_id?: string;
  campaign_name?: string;
}

const CAMPAIGN_INSIGHT_FIELDS = [
  "campaign_id",
  "campaign_name",
  "account_currency",
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "actions",
  "action_values",
  "purchase_roas",
  "cost_per_action_type",
].join(",");

/** Campaign-level insights, paged, with `truncated`. */
export async function getCampaignInsightsPaged(
  accessToken: string,
  adAccountId: string,
  timeRange: { since: string; until: string },
  opts: PagedOptions = {},
): Promise<Paged<MetaCampaignInsight>> {
  const accountId = actId(adAccountId);
  const res = await metaFetchAll<RawAccountInsight & { campaign_id?: string; campaign_name?: string }>(
    `/${accountId}/insights`,
    accessToken,
    {
      ...INSIGHTS_COMMON,
      fields: CAMPAIGN_INSIGHT_FIELDS,
      level: "campaign",
      time_range: JSON.stringify(timeRange),
      limit: "500",
    },
    opts.max ?? META_DEFAULT_MAX,
  );
  return { data: res.data.map((r) => normalizeAccountRow(r, accountId)), truncated: res.truncated };
}

/** Campaign-level insights for an account (fully paginated; `_limit` kept for compat). */
export async function getCampaignInsights(
  accessToken: string,
  adAccountId: string,
  timeRange: { since: string; until: string },
  _limit = 25,
): Promise<MetaCampaignInsight[]> {
  void _limit;
  return (await getCampaignInsightsPaged(accessToken, adAccountId, timeRange)).data;
}

const DAILY_INSIGHT_FIELDS = [
  "account_currency",
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "actions",
  "action_values",
  "purchase_roas",
  "cost_per_action_type",
].join(",");

/** Day-by-day account-level insights, paged, with `truncated`. */
export async function getAccountDailyInsightsPaged(
  accessToken: string,
  adAccountId: string,
  timeRange: { since: string; until: string },
  opts: PagedOptions = {},
): Promise<Paged<MetaAccountInsight>> {
  const accountId = actId(adAccountId);
  const res = await metaFetchAll<RawAccountInsight>(`/${accountId}/insights`, accessToken, {
    ...INSIGHTS_COMMON,
    fields: DAILY_INSIGHT_FIELDS,
    level: "account",
    time_range: JSON.stringify(timeRange),
    time_increment: "1",
    limit: "500",
  }, opts.max ?? META_DEFAULT_MAX);
  return { data: res.data.map((r) => normalizeAccountRow(r, accountId)), truncated: res.truncated };
}

/** Day-by-day account-level insights (for dashboard time series). */
export async function getAccountDailyInsights(
  accessToken: string,
  adAccountId: string,
  timeRange: { since: string; until: string },
): Promise<MetaAccountInsight[]> {
  return (await getAccountDailyInsightsPaged(accessToken, adAccountId, timeRange)).data;
}

export interface MetaBreakdownInsight {
  spend?: string;
  clicks?: string;
  actions?: Array<{ action_type: string; value: string }>;
  age?: string;
  gender?: string;
  device_platform?: string;
  country?: string;
  date_start?: string;
  date_stop?: string;
}

/** Account-level insights split by breakdown dimensions, paged, with `truncated`. */
export async function getAccountBreakdownInsightsPaged(
  accessToken: string,
  adAccountId: string,
  timeRange: { since: string; until: string },
  breakdowns: string,
  opts: PagedOptions = {},
): Promise<Paged<MetaBreakdownInsight>> {
  return metaFetchAll<MetaBreakdownInsight>(`/${actId(adAccountId)}/insights`, accessToken, {
    ...INSIGHTS_COMMON,
    fields: "spend,clicks,actions",
    level: "account",
    breakdowns,
    time_range: JSON.stringify(timeRange),
    limit: "500",
  }, opts.max ?? META_DEFAULT_MAX);
}

/** Account-level insights split by breakdown dimensions
 *  ("age,gender", "device_platform" or "country") — for dashboard widgets.
 *  Verified response shape: one row per dimension combo with string metrics
 *  and the breakdown keys at the top level (rows with 0 actions omit `actions`). */
export async function getAccountBreakdownInsights(
  accessToken: string,
  adAccountId: string,
  timeRange: { since: string; until: string },
  breakdowns: string,
): Promise<MetaBreakdownInsight[]> {
  return (await getAccountBreakdownInsightsPaged(accessToken, adAccountId, timeRange, breakdowns)).data;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function getActionValue(
  actions: Array<{ action_type: string; value: string }> | undefined,
  type: string
): number {
  return parseFloat(actions?.find((a) => a.action_type === type)?.value ?? "0");
}

/**
 * Historical default average order value. It is NO LONGER applied implicitly:
 * `computeRevenue` only estimates `purchases × aov` when an AOV is explicitly
 * configured for the account (AccountSetting.aov). Kept exported for callers
 * that still reference it (tiktok-api) and for the admin UI placeholder.
 */
export const DEFAULT_AOV = 20;

/** Purchase action types that carry a tracked monetary value, most canonical first. */
const PURCHASE_VALUE_TYPES = [
  "omni_purchase",
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
  "onsite_web_purchase",
];

/**
 * Conversion event configured per account (AccountSetting.conversionEvent):
 * purchase | lead | complete_registration | custom:<action_type>
 */
export type ConversionEvent = "purchase" | "lead" | "complete_registration" | `custom:${string}`;

/** Ordered action_type candidates for a conversion event (first positive wins). */
export function conversionActionTypes(conversionEvent?: string | null): string[] {
  const ev = (conversionEvent ?? "purchase").trim() || "purchase";
  if (ev.startsWith("custom:")) {
    const t = ev.slice("custom:".length).trim();
    return t ? [t] : ["omni_purchase", "purchase"];
  }
  switch (ev) {
    case "lead":
      return ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];
    case "complete_registration":
      return ["complete_registration", "offsite_conversion.fb_pixel_complete_registration"];
    case "purchase":
    default:
      return ["omni_purchase", "purchase"];
  }
}

/** Number of conversions for the account's conversion event (default purchase). */
export function purchasesFor(
  insight: { actions?: Array<{ action_type: string; value: string }> },
  conversionEvent: string | null | undefined = "purchase",
): number {
  for (const type of conversionActionTypes(conversionEvent)) {
    const v = getActionValue(insight.actions, type);
    if (v > 0) return v;
  }
  return 0;
}

export interface RevenueResult {
  revenue: number;
  /** true when the value is `purchases × AOV` because the account tracks no purchase value */
  estimated: boolean;
  /**
   * true when revenue cannot be known: no tracked value, no purchase_roas AND
   * no AOV configured. `revenue` is then 0 — callers needing a number get 0,
   * callers that can display "n/a" should check this flag.
   */
  unavailable?: boolean;
}

/**
 * Single source of truth for Meta revenue.
 * Prefers the tracked purchase value (`action_values`), then Meta's own
 * `purchase_roas × spend`. Only when neither exists AND an AOV (> 0) is
 * explicitly configured does it estimate `purchases × aov` (flagged
 * `estimated`). Without an AOV the result is `{ revenue: 0, estimated: true,
 * unavailable: true }` — we never invent revenue with a default basket.
 */
export function computeRevenue(
  insight: Pick<MetaCreativeInsight, "actions" | "action_values" | "purchase_roas" | "spend">,
  aov?: number | null,
): RevenueResult {
  for (const type of PURCHASE_VALUE_TYPES) {
    const v = getActionValue(insight.action_values, type);
    if (v > 0) return { revenue: v, estimated: false };
  }
  const spend = parseFloat(insight.spend ?? "0") || 0;
  for (const type of PURCHASE_VALUE_TYPES) {
    const r = getActionValue(insight.purchase_roas, type);
    if (r > 0 && spend > 0) return { revenue: r * spend, estimated: false };
  }
  const purchases = purchasesFor(insight, "purchase");
  if (purchases <= 0) return { revenue: 0, estimated: false };
  if (typeof aov === "number" && Number.isFinite(aov) && aov > 0) {
    return { revenue: purchases * aov, estimated: true };
  }
  return { revenue: 0, estimated: true, unavailable: true };
}

/** ROAS from computeRevenue; 0 when spend is 0 or revenue is unavailable. */
export function computeRoas(
  insight: MetaCreativeInsight,
  aov?: number | null,
): number {
  const { revenue } = computeRevenue(insight, aov);
  const spend = parseFloat(insight.spend);
  return spend > 0 ? Math.round((revenue / spend) * 100) / 100 : 0;
}

/**
 * Cost per conversion for the account's conversion event (default purchase):
 * Meta's `cost_per_action_type` when present, else spend / conversions.
 */
export function computeCpa(
  insight: Pick<MetaCreativeInsight, "actions" | "cost_per_action_type" | "spend">,
  conversionEvent: string | null | undefined = "purchase",
): number {
  for (const type of conversionActionTypes(conversionEvent)) {
    const cost = getActionValue(insight.cost_per_action_type, type);
    if (cost > 0) return Math.round(cost * 100) / 100;
  }
  const conversions = purchasesFor(insight, conversionEvent);
  const spend = parseFloat(insight.spend ?? "0") || 0;
  return conversions > 0 && spend > 0 ? Math.round((spend / conversions) * 100) / 100 : 0;
}

export function computeHookRate(insight: MetaCreativeInsight): number {
  const threeSecViews = getActionValue(
    insight.video_play_actions,
    "video_view"
  );
  const impressions = parseInt(insight.impressions, 10);
  return impressions > 0
    ? Math.round((threeSecViews / impressions) * 10000) / 100
    : 0;
}

export function computeHoldRate(insight: MetaCreativeInsight): number {
  const thruplay = getActionValue(
    insight.video_thruplay_watched_actions,
    "video_view"
  );
  const impressions = parseInt(insight.impressions, 10);
  return impressions > 0
    ? Math.round((thruplay / impressions) * 10000) / 100
    : 0;
}

export function computeVideoDropoff(insight: MetaCreativeInsight): {
  p25: number;
  p50: number;
  p75: number;
} {
  const impressions = parseInt(insight.impressions, 10);
  if (!impressions) return { p25: 0, p50: 0, p75: 0 };
  const p25 = getActionValue(insight.video_p25_watched_actions, "video_view");
  const p50 = getActionValue(insight.video_p50_watched_actions, "video_view");
  const p75 = getActionValue(insight.video_p75_watched_actions, "video_view");
  return {
    p25: Math.round((p25 / impressions) * 10000) / 100,
    p50: Math.round((p50 / impressions) * 10000) / 100,
    p75: Math.round((p75 / impressions) * 10000) / 100,
  };
}
