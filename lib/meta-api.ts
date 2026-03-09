/**
 * Meta Marketing API client
 * Docs: https://developers.facebook.com/docs/marketing-api/reference
 */

const META_API_BASE = "https://graph.facebook.com/v18.0";

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
  campaign_id: string;
  spend: string;
  impressions: string;
  clicks: string;
  ctr: string;
  cpc: string;
  cpm: string;
  actions?: Array<{ action_type: string; value: string }>;
  cost_per_action_type?: Array<{ action_type: string; value: string }>;
  video_play_actions?: Array<{ action_type: string; value: string }>;
  video_thruplay_watched_actions?: Array<{ action_type: string; value: string }>;
  video_p25_watched_actions?: Array<{ action_type: string; value: string }>;
  date_start: string;
  date_stop: string;
}

export interface MetaAd {
  id: string;
  name: string;
  status: string;
  creative?: {
    id: string;
    thumbnail_url?: string;
    image_url?: string;
    video_id?: string;
    object_type?: string;
  };
}

async function metaFetch<T>(
  path: string,
  accessToken: string,
  params: Record<string, string> = {}
): Promise<T> {
  const url = new URL(`${META_API_BASE}${path}`);
  url.searchParams.set("access_token", accessToken);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      err?.error?.message ?? `Meta API error ${res.status}`
    );
  }
  return res.json();
}

/** List ad accounts accessible to the user */
export async function getAdAccounts(
  accessToken: string
): Promise<MetaAdAccount[]> {
  const data = await metaFetch<{ data: MetaAdAccount[] }>(
    "/me/adaccounts",
    accessToken,
    { fields: "id,name,currency,spend_cap" }
  );
  return data.data;
}

/** Get ads for an account with creative info */
export async function getAds(
  accessToken: string,
  adAccountId: string,
  limit = 50
): Promise<MetaAd[]> {
  const accountId = adAccountId.startsWith("act_")
    ? adAccountId
    : `act_${adAccountId}`;
  const data = await metaFetch<{ data: MetaAd[] }>(
    `/${accountId}/ads`,
    accessToken,
    {
      fields: "id,name,status,creative{id,thumbnail_url,image_url,video_id,object_type}",
      limit: String(limit),
    }
  );
  return data.data;
}

/** Get insights (metrics) for ads — up to last 30 days by default */
export async function getAdInsights(
  accessToken: string,
  adAccountId: string,
  datePreset = "last_30d",
  limit = 50
): Promise<MetaCreativeInsight[]> {
  const accountId = adAccountId.startsWith("act_")
    ? adAccountId
    : `act_${adAccountId}`;

  const fields = [
    "ad_id",
    "ad_name",
    "adset_id",
    "campaign_id",
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "cpc",
    "cpm",
    "actions",
    "cost_per_action_type",
    "video_play_actions",
    "video_thruplay_watched_actions",
    "video_p25_watched_actions",
  ].join(",");

  const data = await metaFetch<{ data: MetaCreativeInsight[] }>(
    `/${accountId}/insights`,
    accessToken,
    {
      fields,
      level: "ad",
      date_preset: datePreset,
      limit: String(limit),
    }
  );
  return data.data;
}

/** Get day-by-day insights for a specific ad (for sparklines) */
export async function getAdDailyInsights(
  accessToken: string,
  adId: string,
  days = 7
): Promise<MetaCreativeInsight[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const timeRange = JSON.stringify({
    since: since.toISOString().split("T")[0],
    until: new Date().toISOString().split("T")[0],
  });

  const data = await metaFetch<{ data: MetaCreativeInsight[] }>(
    `/${adId}/insights`,
    accessToken,
    {
      fields: "spend,impressions,clicks,ctr,actions,cost_per_action_type",
      time_increment: "1",
      time_range: timeRange,
    }
  );
  return data.data;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function getActionValue(
  actions: Array<{ action_type: string; value: string }> | undefined,
  type: string
): number {
  return parseFloat(actions?.find((a) => a.action_type === type)?.value ?? "0");
}

export function computeRoas(insight: MetaCreativeInsight): number {
  const revenue = getActionValue(insight.actions, "purchase") * 20; // assume $20 avg order value if no revenue data
  const spend = parseFloat(insight.spend);
  return spend > 0 ? Math.round((revenue / spend) * 100) / 100 : 0;
}

export function computeCpa(insight: MetaCreativeInsight): number {
  const purchases = getActionValue(
    insight.cost_per_action_type,
    "purchase"
  );
  return purchases > 0 ? Math.round(purchases * 100) / 100 : 0;
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
