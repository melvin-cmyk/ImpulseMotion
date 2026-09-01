/**
 * Shared Creative model for the Analyse Ads section.
 * Populated from real Meta data by /api/meta/creatives (see lib/creatives-server.ts
 * for the field-by-field provenance). Everything optional is "absent from the
 * API", never invented.
 */

export type Platform = "Meta" | "TikTok";
/** "Unknown" = the ad metadata could not be joined (deleted / archived ad, list cap). */
export type Format = "Video" | "Image" | "Carousel" | "Unknown";
/**
 * Performance label relative to the ACCOUNT (not a Meta field):
 *   Winner   — significant spend AND CPA ≤ 0.8× account CPA (or ROAS ≥ 1.25× account ROAS)
 *   Loser    — significant spend AND CPA ≥ 1.5× account CPA (or no conversion with spend > 3× account CPA)
 *   Fatigued — video hook drop / weekly frequency saturation
 *   Active   — everything else (and every ad when the account has no conversion)
 * See classifyStatus in lib/creative-stats.ts.
 */
export type Status = "Winner" | "Loser" | "Fatigued" | "Active";

export interface WowMetrics {
  spendChange: number | null;
  ctrChange: number | null;
  cpaChange: number | null;
  roasChange: number | null;
  hookRateChange: number | null;
}

export interface DayMetric {
  date: string;
  spend: number;
  /** revenue / spend; 0 when revenue is unknown for the day */
  roas: number;
  cpa: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export type AspectRatio = "9:16" | "16:9" | "1:1" | "Carousel";

export interface Creative {
  id: string;
  name: string;
  platform: Platform;
  format: Format;
  status: Status;
  thumbnailColor: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  /** Meta video_id — embeds the official Facebook player. */
  videoId?: string;
  campaignId?: string;
  campaignName?: string;
  adsetId?: string;
  adsetName?: string;
  /** Meta delivery status: ACTIVE, PAUSED, ADSET_PAUSED, CAMPAIGN_PAUSED, … */
  effectiveStatus?: string;
  /** ISO date the ad was created (real launch date). */
  createdTime?: string;
  /** Headline / title from the creative (title, link_data.name or asset feed). */
  headline?: string;
  /** Primary text from the creative (body, link_data.message, video_data.message or asset feed). */
  body?: string;
  /** Destination URL (link_data.link, CTA link or asset feed link_urls). */
  landingUrl?: string;
  aspectRatio?: AspectRatio;
  wow?: WowMetrics;
  spend: number;
  /**
   * revenue / spend. `null` when revenue is unknown (no tracked purchase value
   * and no AOV configured) or when spend is 0 — never a made-up number.
   */
  roas: number | null;
  /** True when revenue was estimated from conversions × AOV (account doesn't track value). */
  roasEstimated?: boolean;
  /** True when revenue cannot be known at all (no tracked value, no AOV) — roas is null. */
  roasUnavailable?: boolean;
  revenue?: number;
  /** Cost per conversion (account conversion event); 0 without conversion. */
  cpa: number;
  ctr: number;
  /** Video plays (video_play_actions) / impressions (%). Video only; 0 for images. */
  hookRate: number;
  /** ThruPlay / impressions (%). Video only. */
  holdRate: number;
  videoP25Rate?: number;
  videoP50Rate?: number;
  videoP75Rate?: number;
  impressions: number;
  reach?: number;
  /** Meta frequency over the whole range (impressions / reach). */
  frequency?: number;
  /** Frequency normalised per 7 days: frequency × 7 / rangeDays. */
  frequencyWeekly?: number;
  clicks: number;
  linkClicks?: number;
  /** Conversions for the account's conversion event (purchase, lead, …). */
  conversions: number;
  /** video_play_actions (video starts) — numerator of hookRate. */
  threeSecViews: number;
  /** ThruPlays (video_thruplay_watched_actions) — numerator of holdRate. */
  thruplays: number;
  trend: DayMetric[];
}

/** Account-level totals for the same window (Σ from the account insights endpoint). */
export interface AccountTotals {
  spend: number;
  impressions: number;
  purchases: number;
  revenue: number;
}

/** Provenance / freshness metadata returned next to the creatives list. */
export interface CreativesMeta {
  /** ISO timestamp of the Meta fetch (from the cache envelope). */
  fetchedAt: string;
  /** True when the insights or ads list hit the pagination cap. */
  truncated: boolean;
  /** ISO 4217 code of the ad account (null when unknown). */
  currency: string | null;
  /** IANA timezone of the ad account. */
  timezone: string | null;
  /** purchase | lead | complete_registration | custom:<action_type> */
  conversionEvent: string;
  range: { since: string; until: string };
  /** Number of days in the range. */
  rangeDays: number;
  /** True when the range includes today (in the account timezone). */
  partialDay: boolean;
  /** Ads with at least one impression in the range. */
  adCount: number;
  /** Ads with spend > 0 in the range. */
  adCountWithSpend: number;
  accountTotals: AccountTotals;
  /** Configured AOV (null when not configured → ROAS unavailable without tracked value). */
  aov: number | null;
  fromCache: boolean;
}

export interface CreativesPayload {
  creatives: Creative[];
  meta: CreativesMeta;
}
