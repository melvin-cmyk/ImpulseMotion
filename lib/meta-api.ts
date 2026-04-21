/**
 * Meta Marketing API client
 * Docs: https://developers.facebook.com/docs/marketing-api/reference
 */

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
  video_p50_watched_actions?: Array<{ action_type: string; value: string }>;
  video_p75_watched_actions?: Array<{ action_type: string; value: string }>;
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
    /** The story ID can be used to resolve a higher-res image when image_url is absent */
    effective_object_story_id?: string;
    /** MD5 hash of the creative image — can be used with /adimages?hashes[] for full-res URL */
    image_hash?: string;
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

export interface MetaCampaign {
  id: string;
  name: string;
  status: string;
  objective?: string;
}

/** List campaigns for an ad account */
export async function getCampaigns(
  accessToken: string,
  adAccountId: string,
  limit = 100
): Promise<MetaCampaign[]> {
  const accountId = adAccountId.startsWith("act_")
    ? adAccountId
    : `act_${adAccountId}`;
  const data = await metaFetch<{ data: MetaCampaign[] }>(
    `/${accountId}/campaigns`,
    accessToken,
    { fields: "id,name,status,objective", limit: String(limit) }
  );
  return data.data;
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
  // Request both thumbnail_url and image_url at full resolution.
  // effective_object_story_id is included so the route can look up the
  // story's high-res image via the object_story_spec if needed.
  const data = await metaFetch<{ data: MetaAd[] }>(
    `/${accountId}/ads`,
    accessToken,
    {
      fields:
        "id,name,status,creative{id,thumbnail_url,image_url,video_id,object_type,effective_object_story_id,image_hash}",
      limit: String(limit),
    }
  );
  return data.data;
}

/** Get insights (metrics) for ads — up to last 30 days by default */
export async function getAdInsights(
  accessToken: string,
  adAccountId: string,
  timeRange?: { since: string; until: string },
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
    "video_p50_watched_actions",
    "video_p75_watched_actions",
  ].join(",");

  const params: Record<string, string> = {
    fields,
    level: "ad",
    limit: String(limit),
  };

  if (timeRange) {
    params.time_range = JSON.stringify({ since: timeRange.since, until: timeRange.until });
  } else {
    params.date_preset = "last_30d";
  }

  const data = await metaFetch<{ data: MetaCreativeInsight[] }>(
    `/${accountId}/insights`,
    accessToken,
    params
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
