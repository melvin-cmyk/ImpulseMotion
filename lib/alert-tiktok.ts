/**
 * TikTok Ads data for alert rules — account totals over a window and its
 * previous period (lib/tiktok-data.ts, through the relay's direct call), like
 * lib/alert-google.ts. Account level only: CTR as a percentage like Meta's,
 * ROAS only when TikTok reports a purchase value, no frequency.
 */

import { cached, ttlForRange } from "@/lib/kpi-cache";
import { fetchTikTokTotals, type TikTokStats } from "@/lib/tiktok-data";
import { prevRange, type DateRange } from "@/lib/date-ranges";
import { windowToRange, type ComputedMetrics } from "@/lib/alerts";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** ComputedMetrics from TikTok totals; « conversion » (the optimisation event) is the conversion. */
export function metricsFromTikTok(s: TikTokStats | null | undefined): ComputedMetrics {
  if (!s) return { spend: 0, roas: 0, cpa: 0, ctr: 0, frequency: 0, roasAvailable: false, roasEstimated: false, conversions: 0 };
  const roasAvailable = s.purchaseValue > 0;
  return {
    spend: Math.round(s.spend),
    roas: roasAvailable && s.spend > 0 ? round2(s.purchaseValue / s.spend) : 0,
    cpa: s.conversions > 0 ? round2(s.spend / s.conversions) : 0,
    ctr: s.impressions > 0 ? round2((s.clicks / s.impressions) * 100) : 0,
    frequency: 0,
    roasAvailable,
    roasEstimated: false,
    conversions: round2(s.conversions),
  };
}

const totals = (advertiserId: string, range: DateRange) =>
  cached(`tiktok:alerts:account:${advertiserId}:${range.since}_${range.until}`, () => fetchTikTokTotals(advertiserId, range.since, range.until), { ttlMs: ttlForRange(range) });

export async function fetchTikTokAccountMetrics(advertiserId: string, window: string): Promise<{ current: ComputedMetrics; previous: ComputedMetrics; range: DateRange; compare: DateRange }> {
  const range = windowToRange(window);
  const compare = prevRange(range);
  const [cur, prev] = await Promise.all([totals(advertiserId, range), totals(advertiserId, compare)]);
  return { current: metricsFromTikTok(cur), previous: metricsFromTikTok(prev), range, compare };
}
