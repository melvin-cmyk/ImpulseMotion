/**
 * Cached wrappers around the Meta insight fetchers. Account-level KPI reads
 * are by far the hottest path (one Graph API call per account per render in
 * the cockpit/portfolio) — a 15 min TTL keeps them fresh enough for pilotage
 * while collapsing the N+1 fan-out.
 */

import { cached } from "@/lib/kpi-cache";
import { getAccountInsights, type MetaAccountInsight } from "@/lib/meta-api";

const ACCOUNT_INSIGHTS_TTL_MS = 15 * 60 * 1000;

export async function getAccountInsightsCached(
  accessToken: string,
  adAccountId: string,
  timeRange?: { since: string; until: string },
): Promise<MetaAccountInsight | null> {
  const normalized = adAccountId.replace(/^act_/, "");
  const rangeKey = timeRange ? `${timeRange.since}_${timeRange.until}` : "last_30d";
  return cached(
    `meta:account-insights:${normalized}:${rangeKey}`,
    () => getAccountInsights(accessToken, adAccountId, timeRange),
    ACCOUNT_INSIGHTS_TTL_MS,
  );
}
