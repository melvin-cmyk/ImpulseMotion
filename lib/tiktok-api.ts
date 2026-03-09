/**
 * TikTok Marketing API client
 * Docs: https://ads.tiktok.com/marketing_api/docs
 */

const TIKTOK_API_BASE = "https://business-api.tiktok.com/open_api/v1.3";

export interface TikTokAdvertiser {
  advertiser_id: string;
  advertiser_name: string;
  currency: string;
}

export interface TikTokAdInsight {
  ad_id: string;
  ad_name: string;
  spend: string;
  impressions: string;
  clicks: string;
  ctr: string;
  cpc: string;
  cpm: string;
  conversions?: string;
  cost_per_conversion?: string;
  video_play_actions?: string;
  video_watched_2s?: string;
  video_watched_6s?: string;
  stat_time_day?: string;
}

export interface TikTokAd {
  ad_id: string;
  ad_name: string;
  status: string;
  image_mode?: string;
  video_id?: string;
  /** URL of the cover image / thumbnail returned by the TikTok Ads API */
  image_url?: string;
}

async function tiktokFetch<T>(
  path: string,
  accessToken: string,
  params: Record<string, string | string[]> = {},
  method: "GET" | "POST" = "GET"
): Promise<{ data: T; code: number; message: string }> {
  const url = new URL(`${TIKTOK_API_BASE}${path}`);

  let body: string | undefined;

  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, Array.isArray(v) ? JSON.stringify(v) : v);
    }
  } else {
    body = JSON.stringify(params);
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      "Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    ...(body ? { body } : {}),
  });

  if (!res.ok) {
    throw new Error(`TikTok API error ${res.status}`);
  }
  return res.json();
}

/** Get advertiser accounts accessible to the user */
export async function getAdvertisers(
  accessToken: string
): Promise<TikTokAdvertiser[]> {
  const res = await tiktokFetch<{
    list: TikTokAdvertiser[];
  }>("/oauth2/advertiser/get/", accessToken);
  return res.data.list ?? [];
}

/** Get ads for an advertiser */
export async function getTikTokAds(
  accessToken: string,
  advertiserId: string,
  page = 1,
  pageSize = 50
): Promise<TikTokAd[]> {
  const res = await tiktokFetch<{
    list: TikTokAd[];
  }>("/ad/get/", accessToken, {
    advertiser_id: advertiserId,
    page: String(page),
    page_size: String(pageSize),
    fields: JSON.stringify(["ad_id", "ad_name", "status", "image_mode", "video_id", "image_url"]),
  });
  return res.data.list ?? [];
}

/** Get ad insights for an advertiser */
export async function getTikTokInsights(
  accessToken: string,
  advertiserId: string,
  startDate: string,
  endDate: string
): Promise<TikTokAdInsight[]> {
  const metrics = [
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "cpc",
    "cpm",
    "conversions",
    "cost_per_conversion",
    "video_play_actions",
    "video_watched_2s",
    "video_watched_6s",
  ];

  const res = await tiktokFetch<{
    list: Array<{ dimensions: { ad_id: string; stat_time_day?: string }; metrics: TikTokAdInsight }>;
  }>(
    "/report/integrated/get/",
    accessToken,
    {
      advertiser_id: advertiserId,
      report_type: "BASIC",
      data_level: "AUCTION_AD",
      dimensions: JSON.stringify(["ad_id"]),
      metrics: JSON.stringify(metrics),
      start_date: startDate,
      end_date: endDate,
      page_size: "50",
    }
  );

  return (res.data.list ?? []).map((row) => ({
    ...row.metrics,
    ad_id: row.dimensions.ad_id,
    stat_time_day: row.dimensions.stat_time_day,
  }));
}

/** Get day-by-day insights for sparklines */
export async function getTikTokDailyInsights(
  accessToken: string,
  advertiserId: string,
  adId: string,
  days = 7
): Promise<TikTokAdInsight[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const res = await tiktokFetch<{
    list: Array<{ dimensions: { ad_id: string; stat_time_day: string }; metrics: TikTokAdInsight }>;
  }>(
    "/report/integrated/get/",
    accessToken,
    {
      advertiser_id: advertiserId,
      report_type: "BASIC",
      data_level: "AUCTION_AD",
      dimensions: JSON.stringify(["ad_id", "stat_time_day"]),
      metrics: JSON.stringify(["spend", "impressions", "clicks", "ctr", "conversions", "cost_per_conversion"]),
      filters: JSON.stringify([{ field_name: "ad_id", filter_type: "IN", filter_value: JSON.stringify([adId]) }]),
      start_date: start.toISOString().split("T")[0],
      end_date: end.toISOString().split("T")[0],
      page_size: "50",
    }
  );

  return (res.data.list ?? []).map((row) => ({
    ...row.metrics,
    ad_id: row.dimensions.ad_id,
    stat_time_day: row.dimensions.stat_time_day,
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function computeTikTokRoas(insight: TikTokAdInsight): number {
  const conversions = parseFloat(insight.conversions ?? "0");
  const spend = parseFloat(insight.spend ?? "0");
  // Estimate revenue assuming average order value of $20
  const estimatedRevenue = conversions * 20;
  return spend > 0 ? Math.round((estimatedRevenue / spend) * 100) / 100 : 0;
}

export function computeTikTokHookRate(insight: TikTokAdInsight): number {
  const twoSecViews = parseFloat(insight.video_watched_2s ?? "0");
  const impressions = parseFloat(insight.impressions ?? "0");
  return impressions > 0
    ? Math.round((twoSecViews / impressions) * 10000) / 100
    : 0;
}

export function computeTikTokHoldRate(insight: TikTokAdInsight): number {
  const sixSecViews = parseFloat(insight.video_watched_6s ?? "0");
  const impressions = parseFloat(insight.impressions ?? "0");
  return impressions > 0
    ? Math.round((sixSecViews / impressions) * 10000) / 100
    : 0;
}
