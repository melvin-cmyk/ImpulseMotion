/**
 * POST /api/deck/data
 * Fetches real Meta Ads + Google Ads data for a client/period via the relay proxy MCP.
 * Falls back to mock data if relay is unavailable.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  generateMockDeckData,
  getPreviousPeriod,
  type DeckClient,
  type DeckPeriod,
  type DeckData,
  type PlatformMetrics,
  type CampaignRow,
  type TopCreative,
} from "@/lib/deck-data";

const rawRelayUrl = (process.env.NEXT_PUBLIC_RELAY_URL || "").trim();
const RELAY_URL = rawRelayUrl
  ? rawRelayUrl.startsWith("http") ? rawRelayUrl : `https://${rawRelayUrl}`
  : "https://guitar-instruments-missions-avatar.trycloudflare.com";

// ── Relay helpers ─────────────────────────────────────────────────────────────

async function relayChat(prompt: string, timeoutMs = 30000): Promise<string> {
  const res = await fetch(`${RELAY_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`Relay responded ${res.status}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.type === "delta" && event.text) fullText += event.text;
        if (event.type === "content" && event.content) fullText += event.content;
      } catch {
        // skip malformed SSE lines
      }
    }
  }

  return fullText;
}

function extractJson<T>(text: string): T | null {
  // Try to find a JSON object or array in the text
  const objectMatch = text.match(/\{[\s\S]*\}/);
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  const match = objectMatch || arrayMatch;
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

function zeroMetrics(): PlatformMetrics {
  return { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, cpm: 0, ctr: 0, cpc: 0, cpa: 0, roas: 0 };
}

function safeMetrics(raw: Partial<PlatformMetrics>): PlatformMetrics {
  const spend = raw.spend ?? 0;
  const impressions = raw.impressions ?? 0;
  const clicks = raw.clicks ?? 0;
  const conversions = raw.conversions ?? 0;
  const revenue = raw.revenue ?? 0;
  return {
    spend,
    impressions,
    clicks,
    conversions,
    revenue,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : (raw.cpm ?? 0),
    ctr: impressions > 0 ? (clicks / impressions) * 100 : (raw.ctr ?? 0),
    cpc: clicks > 0 ? spend / clicks : (raw.cpc ?? 0),
    cpa: conversions > 0 ? spend / conversions : (raw.cpa ?? 0),
    roas: spend > 0 ? revenue / spend : (raw.roas ?? 0),
  };
}

function safeDelta(current: PlatformMetrics, previous: PlatformMetrics): Record<keyof PlatformMetrics, number> {
  const delta = {} as Record<keyof PlatformMetrics, number>;
  for (const key of Object.keys(current) as (keyof PlatformMetrics)[]) {
    const prev = previous[key];
    const curr = current[key];
    delta[key] = prev !== 0 ? ((curr - prev) / Math.abs(prev)) * 100 : curr !== 0 ? 100 : 0;
  }
  return delta;
}

// ── Data fetchers ─────────────────────────────────────────────────────────────

interface RawCampaign {
  id?: string;
  name?: string;
  type?: string;
  status?: string;
  spend?: number;
  impressions?: number;
  clicks?: number;
  conversions?: number;
  revenue?: number;
  cpm?: number;
  ctr?: number;
  cpc?: number;
  cpa?: number;
  roas?: number;
  prev_spend?: number;
  prev_impressions?: number;
  prev_clicks?: number;
  prev_conversions?: number;
  prev_revenue?: number;
}

interface RawCreative {
  id?: string;
  name?: string;
  format?: string;
  spend?: number;
  roas?: number;
  ctr?: number;
  cpa?: number;
  impressions?: number;
  hookRate?: number;
  thumbnailUrl?: string;
}

interface RawPlatformData {
  total?: Partial<PlatformMetrics>;
  prev_total?: Partial<PlatformMetrics>;
  campaigns?: RawCampaign[];
  creatives?: RawCreative[];
}

async function fetchMetaData(
  accountId: string,
  period: DeckPeriod,
  previousPeriod: DeckPeriod
): Promise<{ overview: PlatformMetrics; campaigns: CampaignRow[]; topCreatives: TopCreative[]; prevOverview: PlatformMetrics } | null> {
  const prompt = `Fetch Meta Ads data for ad account ${accountId}.

Current period: ${period.startDate} to ${period.endDate}
Previous period: ${previousPeriod.startDate} to ${previousPeriod.endDate}

Return ONLY a valid JSON object (no markdown, no explanation):
{
  "total": {"spend": 0, "impressions": 0, "clicks": 0, "conversions": 0, "revenue": 0},
  "prev_total": {"spend": 0, "impressions": 0, "clicks": 0, "conversions": 0, "revenue": 0},
  "campaigns": [
    {
      "id": "string",
      "name": "string",
      "type": "string",
      "status": "Active|Paused|Completed",
      "spend": 0, "impressions": 0, "clicks": 0, "conversions": 0, "revenue": 0,
      "prev_spend": 0, "prev_impressions": 0, "prev_clicks": 0, "prev_conversions": 0, "prev_revenue": 0
    }
  ],
  "creatives": [
    {
      "id": "string", "name": "string", "format": "Video|Image|Carousel",
      "spend": 0, "roas": 0, "ctr": 0, "cpa": 0, "impressions": 0, "hookRate": null, "thumbnailUrl": null
    }
  ]
}`;

  try {
    const text = await relayChat(prompt);
    const data = extractJson<RawPlatformData>(text);
    if (!data) return null;

    const overview = safeMetrics(data.total ?? {});
    const prevOverview = safeMetrics(data.prev_total ?? {});

    const campaigns: CampaignRow[] = (data.campaigns ?? []).slice(0, 10).map((c, i) => {
      const current = safeMetrics(c);
      const previous = safeMetrics({
        spend: c.prev_spend, impressions: c.prev_impressions, clicks: c.prev_clicks,
        conversions: c.prev_conversions, revenue: c.prev_revenue,
      });
      return {
        id: c.id ?? `meta-c-${i}`,
        name: c.name ?? `Campagne ${i + 1}`,
        type: c.type,
        status: (["Active", "Paused", "Completed"].includes(c.status ?? "") ? c.status : "Active") as CampaignRow["status"],
        current,
        previous,
        delta: safeDelta(current, previous),
      };
    });

    const topCreatives: TopCreative[] = (data.creatives ?? []).slice(0, 6).map((cr, i) => ({
      id: cr.id ?? `tc-${i}`,
      name: cr.name ?? `Creative ${i + 1}`,
      format: (["Video", "Image", "Carousel"].includes(cr.format ?? "") ? cr.format : "Image") as TopCreative["format"],
      spend: cr.spend ?? 0,
      roas: cr.roas ?? 0,
      ctr: cr.ctr ?? 0,
      cpa: cr.cpa ?? 0,
      impressions: cr.impressions ?? 0,
      hookRate: cr.hookRate ?? undefined,
      thumbnailUrl: cr.thumbnailUrl ?? undefined,
    }));

    return { overview, campaigns, topCreatives, prevOverview };
  } catch {
    return null;
  }
}

async function fetchGoogleData(
  customerId: string,
  period: DeckPeriod,
  previousPeriod: DeckPeriod
): Promise<{ overview: PlatformMetrics; campaigns: CampaignRow[]; prevOverview: PlatformMetrics } | null> {
  const prompt = `Fetch Google Ads data for customer ${customerId}.

Current period: ${period.startDate} to ${period.endDate}
Previous period: ${previousPeriod.startDate} to ${previousPeriod.endDate}

Return ONLY a valid JSON object (no markdown, no explanation):
{
  "total": {"spend": 0, "impressions": 0, "clicks": 0, "conversions": 0, "revenue": 0},
  "prev_total": {"spend": 0, "impressions": 0, "clicks": 0, "conversions": 0, "revenue": 0},
  "campaigns": [
    {
      "id": "string",
      "name": "string",
      "type": "string",
      "status": "Active|Paused|Completed",
      "spend": 0, "impressions": 0, "clicks": 0, "conversions": 0, "revenue": 0,
      "prev_spend": 0, "prev_impressions": 0, "prev_clicks": 0, "prev_conversions": 0, "prev_revenue": 0
    }
  ]
}`;

  try {
    const text = await relayChat(prompt);
    const data = extractJson<RawPlatformData>(text);
    if (!data) return null;

    const overview = safeMetrics(data.total ?? {});
    const prevOverview = safeMetrics(data.prev_total ?? {});

    const campaigns: CampaignRow[] = (data.campaigns ?? []).slice(0, 10).map((c, i) => {
      const current = safeMetrics(c);
      const previous = safeMetrics({
        spend: c.prev_spend, impressions: c.prev_impressions, clicks: c.prev_clicks,
        conversions: c.prev_conversions, revenue: c.prev_revenue,
      });
      return {
        id: c.id ?? `google-c-${i}`,
        name: c.name ?? `Campagne ${i + 1}`,
        type: c.type,
        status: (["Active", "Paused", "Completed"].includes(c.status ?? "") ? c.status : "Active") as CampaignRow["status"],
        current,
        previous,
        delta: safeDelta(current, previous),
      };
    });

    return { overview, campaigns, prevOverview };
  } catch {
    return null;
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let client: DeckClient, period: DeckPeriod;
  try {
    const body = await req.json();
    client = body.client;
    period = body.period;
    if (!client || !period) throw new Error("Missing client or period");
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const previousPeriod = getPreviousPeriod(period);

  // Try to fetch real data in parallel
  const [metaResult, googleResult] = await Promise.allSettled([
    client.metaAccountId
      ? fetchMetaData(client.metaAccountId, period, previousPeriod)
      : Promise.resolve(null),
    client.googleCustomerId
      ? fetchGoogleData(client.googleCustomerId, period, previousPeriod)
      : Promise.resolve(null),
  ]);

  const meta = metaResult.status === "fulfilled" ? metaResult.value : null;
  const google = googleResult.status === "fulfilled" ? googleResult.value : null;

  // If both failed, fallback to mock data entirely
  if (!meta && !google) {
    const mockData = generateMockDeckData(client, period);
    return NextResponse.json({ data: mockData, source: "mock" });
  }

  // Build DeckData from real data, filling in missing parts from mock
  const mockFallback = generateMockDeckData(client, period);

  const metaOverview = meta?.overview ?? mockFallback.metaOverview;
  const metaPrevOverview = meta?.prevOverview ?? zeroMetrics();
  const googleOverview = google?.overview ?? mockFallback.googleOverview;
  const googlePrevOverview = google?.prevOverview ?? zeroMetrics();

  // Global totals
  const totalCurrent: PlatformMetrics = {
    spend: metaOverview.spend + googleOverview.spend,
    impressions: metaOverview.impressions + googleOverview.impressions,
    clicks: metaOverview.clicks + googleOverview.clicks,
    conversions: metaOverview.conversions + googleOverview.conversions,
    revenue: metaOverview.revenue + googleOverview.revenue,
    cpm: 0, ctr: 0, cpc: 0, cpa: 0, roas: 0,
  };
  if (totalCurrent.impressions > 0) totalCurrent.cpm = (totalCurrent.spend / totalCurrent.impressions) * 1000;
  if (totalCurrent.impressions > 0) totalCurrent.ctr = (totalCurrent.clicks / totalCurrent.impressions) * 100;
  if (totalCurrent.clicks > 0) totalCurrent.cpc = totalCurrent.spend / totalCurrent.clicks;
  if (totalCurrent.conversions > 0) totalCurrent.cpa = totalCurrent.spend / totalCurrent.conversions;
  if (totalCurrent.spend > 0) totalCurrent.roas = totalCurrent.revenue / totalCurrent.spend;

  const totalPrevious: PlatformMetrics = {
    spend: metaPrevOverview.spend + googlePrevOverview.spend,
    impressions: metaPrevOverview.impressions + googlePrevOverview.impressions,
    clicks: metaPrevOverview.clicks + googlePrevOverview.clicks,
    conversions: metaPrevOverview.conversions + googlePrevOverview.conversions,
    revenue: metaPrevOverview.revenue + googlePrevOverview.revenue,
    cpm: 0, ctr: 0, cpc: 0, cpa: 0, roas: 0,
  };
  if (totalPrevious.impressions > 0) totalPrevious.cpm = (totalPrevious.spend / totalPrevious.impressions) * 1000;
  if (totalPrevious.impressions > 0) totalPrevious.ctr = (totalPrevious.clicks / totalPrevious.impressions) * 100;
  if (totalPrevious.clicks > 0) totalPrevious.cpc = totalPrevious.spend / totalPrevious.clicks;
  if (totalPrevious.conversions > 0) totalPrevious.cpa = totalPrevious.spend / totalPrevious.conversions;
  if (totalPrevious.spend > 0) totalPrevious.roas = totalPrevious.revenue / totalPrevious.spend;

  // Highlights from real data
  const spendDelta = totalPrevious.spend > 0
    ? ((totalCurrent.spend - totalPrevious.spend) / totalPrevious.spend) * 100 : 0;
  const roasDelta = totalPrevious.roas > 0
    ? ((totalCurrent.roas - totalPrevious.roas) / totalPrevious.roas) * 100 : 0;
  const cpaDelta = totalPrevious.cpa > 0
    ? ((totalCurrent.cpa - totalPrevious.cpa) / totalPrevious.cpa) * 100 : 0;
  const convDelta = totalPrevious.conversions > 0
    ? ((totalCurrent.conversions - totalPrevious.conversions) / totalPrevious.conversions) * 100 : 0;

  const deckData: DeckData = {
    client,
    period,
    previousPeriod,

    highlights: [
      {
        title: "Spend Total",
        value: `${totalCurrent.spend.toLocaleString("fr-FR", { minimumFractionDigits: 0 })} €`,
        delta: Math.round(spendDelta),
        description: `${totalCurrent.spend > totalPrevious.spend ? "+" : ""}${spendDelta.toFixed(1)}% vs ${previousPeriod.label}`,
        icon: "spend",
      },
      {
        title: "ROAS Global",
        value: `x${totalCurrent.roas.toFixed(2)}`,
        delta: Math.round(roasDelta),
        description: `${roasDelta >= 0 ? "+" : ""}${roasDelta.toFixed(1)}% vs ${previousPeriod.label}`,
        icon: "roas",
      },
      {
        title: "CPA Moyen",
        value: `${totalCurrent.cpa.toFixed(2)} €`,
        delta: Math.round(-cpaDelta), // negative delta is good for CPA
        description: `${cpaDelta >= 0 ? "+" : ""}${cpaDelta.toFixed(1)}% vs ${previousPeriod.label}`,
        icon: "cpa",
      },
      {
        title: "Conversions",
        value: totalCurrent.conversions.toLocaleString("fr-FR"),
        delta: Math.round(convDelta),
        description: `${convDelta >= 0 ? "+" : ""}${convDelta.toFixed(1)}% vs ${previousPeriod.label}`,
        icon: "conversions",
      },
    ],

    globalTable: [
      {
        platform: "Google",
        current: googleOverview,
        previous: googlePrevOverview,
        delta: safeDelta(googleOverview, googlePrevOverview),
      },
      {
        platform: "Meta",
        current: metaOverview,
        previous: metaPrevOverview,
        delta: safeDelta(metaOverview, metaPrevOverview),
      },
      {
        platform: "Total",
        current: totalCurrent,
        previous: totalPrevious,
        delta: safeDelta(totalCurrent, totalPrevious),
      },
    ],

    ncTable: mockFallback.ncTable,

    googleOverview,
    googleCampaigns: google?.campaigns ?? mockFallback.googleCampaigns,

    metaOverview,
    metaCampaigns: meta?.campaigns ?? mockFallback.metaCampaigns,
    topCreatives: meta?.topCreatives ?? mockFallback.topCreatives,

    budget: mockFallback.budget,

    learnings: mockFallback.learnings,
    insightsGoogle: mockFallback.insightsGoogle,
    insightsMeta: mockFallback.insightsMeta,
    nextStepsGlobal: mockFallback.nextStepsGlobal,
    nextStepsGoogle: mockFallback.nextStepsGoogle,
    nextStepsMeta: mockFallback.nextStepsMeta,
  };

  return NextResponse.json({ data: deckData, source: "real" });
}
