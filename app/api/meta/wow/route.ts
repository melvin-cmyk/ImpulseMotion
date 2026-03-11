import { auth } from "@/auth";
import {
  getAdInsights,
  computeRoas,
  computeCpa,
  computeHookRate,
} from "@/lib/meta-api";
import { WowMetrics } from "@/lib/mock-data";
import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/meta/wow?accountId=...
 *
 * Fetches insights for:
 *   - Current period: last 7 days (today-7 → today)
 *   - Previous period: 7-14 days ago (today-14 → today-8)
 *
 * Returns a map of adId → WowMetrics (% change per metric).
 * Also returns aggregate WoW metrics for the whole account.
 */

function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function pctChange(current: number, prev: number): number | null {
  if (prev === 0) return null;
  return Math.round(((current - prev) / prev) * 1000) / 10; // 1 decimal place
}

export async function GET(request: NextRequest) {
  const session = await auth();

  if (!session || !session.metaAccessToken) {
    return NextResponse.json({ error: "Not authenticated with Meta" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const adAccountId = searchParams.get("accountId");

  if (!adAccountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  try {
    const accessToken = session.metaAccessToken as string;

    // Fetch both periods in parallel
    const currentSince = offsetDate(-7);
    const currentUntil = offsetDate(0);
    const prevSince = offsetDate(-14);
    const prevUntil = offsetDate(-8);

    const [currentInsights, prevInsights] = await Promise.all([
      getAdInsights(accessToken, adAccountId, { since: currentSince, until: currentUntil }),
      getAdInsights(accessToken, adAccountId, { since: prevSince, until: prevUntil }),
    ]);

    // Build map of adId → WowMetrics
    const currentMap = new Map(currentInsights.map((i) => [i.ad_id, i]));
    const prevMap = new Map(prevInsights.map((i) => [i.ad_id, i]));

    const wowByAdId: Record<string, WowMetrics> = {};

    for (const [adId, current] of currentMap) {
      const prev = prevMap.get(adId);

      const currSpend = parseFloat(current.spend);
      const currCtr = parseFloat(current.ctr);
      const currRoas = computeRoas(current);
      const currCpa = computeCpa(current);
      const currHookRate = computeHookRate(current);

      if (!prev) {
        wowByAdId[adId] = {
          spendChange: null,
          ctrChange: null,
          cpaChange: null,
          roasChange: null,
          hookRateChange: null,
        };
        continue;
      }

      const prevSpend = parseFloat(prev.spend);
      const prevCtr = parseFloat(prev.ctr);
      const prevRoas = computeRoas(prev);
      const prevCpa = computeCpa(prev);
      const prevHookRate = computeHookRate(prev);

      wowByAdId[adId] = {
        spendChange: pctChange(currSpend, prevSpend),
        ctrChange: pctChange(currCtr, prevCtr),
        cpaChange: pctChange(currCpa, prevCpa),
        roasChange: pctChange(currRoas, prevRoas),
        hookRateChange: pctChange(currHookRate, prevHookRate),
      };
    }

    // Aggregate WoW: sum spend, weighted averages for rates
    const aggCurrent = {
      spend: currentInsights.reduce((s, i) => s + parseFloat(i.spend), 0),
      impressions: currentInsights.reduce((s, i) => s + parseInt(i.impressions, 10), 0),
      clicks: currentInsights.reduce((s, i) => s + parseInt(i.clicks, 10), 0),
      roas: currentInsights.length > 0
        ? currentInsights.reduce((s, i) => s + computeRoas(i), 0) / currentInsights.length
        : 0,
      cpa: currentInsights.length > 0
        ? currentInsights.reduce((s, i) => s + computeCpa(i), 0) / currentInsights.length
        : 0,
      hookRate: currentInsights.length > 0
        ? currentInsights.reduce((s, i) => s + computeHookRate(i), 0) / currentInsights.length
        : 0,
    };

    const aggPrev = {
      spend: prevInsights.reduce((s, i) => s + parseFloat(i.spend), 0),
      impressions: prevInsights.reduce((s, i) => s + parseInt(i.impressions, 10), 0),
      clicks: prevInsights.reduce((s, i) => s + parseInt(i.clicks, 10), 0),
      roas: prevInsights.length > 0
        ? prevInsights.reduce((s, i) => s + computeRoas(i), 0) / prevInsights.length
        : 0,
      cpa: prevInsights.length > 0
        ? prevInsights.reduce((s, i) => s + computeCpa(i), 0) / prevInsights.length
        : 0,
      hookRate: prevInsights.length > 0
        ? prevInsights.reduce((s, i) => s + computeHookRate(i), 0) / prevInsights.length
        : 0,
    };

    const aggCtr = aggCurrent.impressions > 0
      ? (aggCurrent.clicks / aggCurrent.impressions) * 100
      : 0;
    const aggPrevCtr = aggPrev.impressions > 0
      ? (aggPrev.clicks / aggPrev.impressions) * 100
      : 0;

    const aggregateWow: WowMetrics = {
      spendChange: pctChange(aggCurrent.spend, aggPrev.spend),
      ctrChange: pctChange(aggCtr, aggPrevCtr),
      cpaChange: pctChange(aggCurrent.cpa, aggPrev.cpa),
      roasChange: pctChange(aggCurrent.roas, aggPrev.roas),
      hookRateChange: pctChange(aggCurrent.hookRate, aggPrev.hookRate),
    };

    return NextResponse.json({
      wowByAdId,
      aggregateWow,
      currentPeriod: { since: currentSince, until: currentUntil },
      prevPeriod: { since: prevSince, until: prevUntil },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[wow route] unhandled error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
