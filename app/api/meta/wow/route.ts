import { auth } from "@/auth";
import {
  getAdInsights,
  computeRoas,
  computeCpa,
  MetaCreativeInsight,
} from "@/lib/meta-api";
import { NextRequest, NextResponse } from "next/server";

/** Returns YYYY-MM-DD for a date offset by `days` from today */
function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

export interface WoWMetrics {
  spend: number;
  cpa: number;
  ctr: number;
  cpm: number;
  roas: number;
  impressions: number;
  clicks: number;
}

export interface WoWData {
  current: WoWMetrics;   // last 7 days
  previous: WoWMetrics;  // days -14 to -8
  currentRange: { since: string; until: string };
  previousRange: { since: string; until: string };
}

function aggregateInsights(insights: MetaCreativeInsight[]): WoWMetrics {
  if (insights.length === 0) {
    return { spend: 0, cpa: 0, ctr: 0, cpm: 0, roas: 0, impressions: 0, clicks: 0 };
  }

  const totalSpend = insights.reduce((s, i) => s + parseFloat(i.spend), 0);
  const totalImpressions = insights.reduce((s, i) => s + parseInt(i.impressions, 10), 0);
  const totalClicks = insights.reduce((s, i) => s + parseInt(i.clicks, 10), 0);

  // Weighted average CTR (clicks / impressions * 100)
  const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

  // CPM = (spend / impressions) * 1000
  const cpm = totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0;

  // Average CPA across ads that have a CPA value
  const cpas = insights.map(computeCpa).filter((v) => v > 0);
  const avgCpa = cpas.length > 0 ? cpas.reduce((s, v) => s + v, 0) / cpas.length : 0;

  // Average ROAS across ads that have a ROAS value
  const roasValues = insights.map(computeRoas).filter((v) => v > 0);
  const avgRoas = roasValues.length > 0 ? roasValues.reduce((s, v) => s + v, 0) / roasValues.length : 0;

  return {
    spend: Math.round(totalSpend * 100) / 100,
    cpa: Math.round(avgCpa * 100) / 100,
    ctr: Math.round(ctr * 10000) / 10000,
    cpm: Math.round(cpm * 100) / 100,
    roas: Math.round(avgRoas * 100) / 100,
    impressions: totalImpressions,
    clicks: totalClicks,
  };
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

  // Current period: last 7 days (today-7 to today-1 so data is settled)
  const currentRange = {
    since: offsetDate(-7),
    until: offsetDate(-1),
  };

  // Previous period: days -14 to -8 (7 days before the current period)
  const previousRange = {
    since: offsetDate(-14),
    until: offsetDate(-8),
  };

  try {
    const accessToken = session.metaAccessToken as string;

    const [currentInsights, previousInsights] = await Promise.all([
      getAdInsights(accessToken, adAccountId, currentRange),
      getAdInsights(accessToken, adAccountId, previousRange),
    ]);

    // Only return WoW data if both periods have data
    if (currentInsights.length === 0 || previousInsights.length === 0) {
      return NextResponse.json({ error: "Insufficient data for WoW comparison" }, { status: 204 });
    }

    const data: WoWData = {
      current: aggregateInsights(currentInsights),
      previous: aggregateInsights(previousInsights),
      currentRange,
      previousRange,
    };

    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[wow route] unhandled error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
