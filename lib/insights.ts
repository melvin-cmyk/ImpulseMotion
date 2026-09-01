/**
 * Cached wrappers around the Meta insight fetchers. Account-level KPI reads
 * are by far the hottest path (one Graph API call per account per render in
 * the cockpit/portfolio). TTL follows `ttlForRange`: 15 min while the window
 * touches today, 24 h once every day of the window is closed.
 *
 * Errors propagate (typed MetaApiError) — nothing is cached on failure.
 * "No data" yields a zero-filled row (`hasData: false`) cached 60 s.
 */

import { cached, cachedWithMeta, ttlForRange, type CachedResult, type CacheOptions } from "@/lib/kpi-cache";
import {
  getAccountInsights,
  getAccountProfile,
  type MetaAccountInsight,
  type MetaAccountProfile,
} from "@/lib/meta-api";
import { lastFullDays } from "@/lib/date-ranges";

const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

const norm = (id: string) => id.replace(/^act_/, "");

export function accountInsightsCacheKey(adAccountId: string, timeRange?: { since: string; until: string }): string {
  const rangeKey = timeRange ? `${timeRange.since}_${timeRange.until}` : "last_30d";
  return `meta:account:${norm(adAccountId)}:${rangeKey}`;
}

/** Account insights with cache metadata (fetchedAt / fromCache). */
export async function getAccountInsightsCachedWithMeta(
  accessToken: string,
  adAccountId: string,
  timeRange?: { since: string; until: string },
  opts: Pick<CacheOptions, "refresh"> = {},
): Promise<CachedResult<MetaAccountInsight>> {
  const range = timeRange ?? lastFullDays(30);
  return cachedWithMeta(
    accountInsightsCacheKey(adAccountId, timeRange),
    () => getAccountInsights(accessToken, adAccountId, timeRange),
    { ttlMs: ttlForRange(range), refresh: opts.refresh },
  );
}

/** Account insights (never null — see getAccountInsights). */
export async function getAccountInsightsCached(
  accessToken: string,
  adAccountId: string,
  timeRange?: { since: string; until: string },
): Promise<MetaAccountInsight> {
  return (await getAccountInsightsCachedWithMeta(accessToken, adAccountId, timeRange)).data;
}

/** Account profile (name, currency, timezone) cached 24 h. */
export async function getAccountProfileCached(
  accessToken: string,
  adAccountId: string,
  opts: Pick<CacheOptions, "refresh"> = {},
): Promise<MetaAccountProfile> {
  return cached(
    `meta:profile:${norm(adAccountId)}`,
    () => getAccountProfile(accessToken, adAccountId),
    { ttlMs: PROFILE_TTL_MS, refresh: opts.refresh },
  );
}
