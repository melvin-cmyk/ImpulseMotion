/**
 * Browser-side deck data fetcher.
 * Calls the relay MCP tools directly from the browser (localhost:3457 or via proxy).
 * No Vercel server involved — works even when tunnel URL is stale.
 * Returns null (no mock data) if the relay is unreachable.
 */

"use client";

import { streamChat } from "./relay-client";
import {
  getPreviousPeriod,
  type DeckClient,
  type DeckPeriod,
  type DeckData,
  type PlatformMetrics,
  type CampaignRow,
  type TopCreative,
} from "./deck-data";

// ── Helpers ────────────────────────────────────────────────────────────────────

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.-]/g, "")) : Number(v);
  return isFinite(n) ? n : 0;
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
    spend, impressions, clicks, conversions, revenue,
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

function extractJson<T>(text: string): T | null {
  const stripped = text.replace(/```(?:json)?\n?([\s\S]*?)\n?```/g, "$1").trim();
  for (const candidate of [stripped, text]) {
    const objectMatch = candidate.match(/\{[\s\S]*\}/);
    const arrayMatch = candidate.match(/\[[\s\S]*\]/);
    const match = objectMatch || arrayMatch;
    if (!match) continue;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      // Try to find matching braces
      const raw = match[0];
      let depth = 0;
      let start = -1;
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === "{" || raw[i] === "[") {
          if (depth === 0) start = i;
          depth++;
        } else if (raw[i] === "}" || raw[i] === "]") {
          depth--;
          if (depth === 0 && start !== -1) {
            try { return JSON.parse(raw.slice(start, i + 1)) as T; } catch { continue; }
          }
        }
      }
    }
  }
  return null;
}

/** Call a relay single-tool prompt and return the parsed JSON result. */
async function relaySingleTool(toolName: string, params: Record<string, string>, timeoutMs = 60000): Promise<unknown> {
  const paramStr = Object.entries(params).map(([k, v]) => `${k}="${v}"`).join(", ");
  const prompt = `Call the tool ${toolName} with params: ${paramStr}. Return ONLY the raw JSON result from the tool. No explanation, no markdown, no text before or after. Just the raw JSON.`;

  let fullText = "";
  let toolResultText = "";

  await streamChat(
    [{ role: "user", content: prompt }],
    (event) => {
      if (event.type === "tool_result" && event.content) {
        toolResultText += String(event.content);
      } else if (event.type === "delta" && event.text) {
        fullText += event.text;
      } else if (event.type === "content") {
        if (event.text) fullText = event.text;
        else if (event.content) fullText = String(event.content);
      } else {
        // Anthropic content_block_delta or OpenAI choices format
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = event as any;
        if (e.delta?.type === "text_delta" && e.delta?.text) fullText += e.delta.text;
        if (e.choices?.[0]?.delta?.content) fullText += e.choices[0].delta.content;
      }
    },
    AbortSignal.timeout(timeoutMs)
  );

  const result = toolResultText.trim() || fullText.trim();
  return extractJson(result);
}

// ── Meta Ads parser helpers ────────────────────────────────────────────────────

function actionsValue(obj: Record<string, unknown>, ...types: string[]): number {
  const actions = Array.isArray(obj.actions) ? obj.actions as Array<{ action_type: string; value: string }> : [];
  for (const t of types) {
    const found = actions.find(a => a.action_type === t);
    if (found) return toNum(found.value);
  }
  return 0;
}

function actionValuesValue(obj: Record<string, unknown>, ...types: string[]): number {
  const actionValues = Array.isArray(obj.action_values) ? obj.action_values as Array<{ action_type: string; value: string }> : [];
  for (const t of types) {
    const found = actionValues.find(a => a.action_type === t);
    if (found) return toNum(found.value);
  }
  return 0;
}

function extractOverviewMetrics(raw: unknown): PlatformMetrics {
  if (!raw || typeof raw !== "object") return zeroMetrics();
  const r = raw as Record<string, unknown>;
  const data = (r.data ?? r.overview ?? r.account_overview ?? r) as Record<string, unknown>;
  const arr = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
  if (!arr || typeof arr !== "object") return zeroMetrics();
  const conversions = toNum(arr.conversions ?? arr.purchases)
    || actionsValue(arr, "purchase", "offsite_conversion.fb_pixel_purchase", "lead", "offsite_conversion.fb_pixel_lead", "complete_registration");
  const revenue = toNum(arr.revenue ?? arr.purchase_roas_value ?? arr.action_values_purchase)
    || actionValuesValue(arr, "purchase", "offsite_conversion.fb_pixel_purchase");
  return safeMetrics({
    spend: toNum(arr.spend ?? arr.amount_spent ?? arr.total_spend),
    impressions: toNum(arr.impressions),
    clicks: toNum(arr.clicks ?? arr.link_clicks),
    conversions, revenue,
  });
}

function extractCampaigns(raw: unknown): CampaignRow[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const list = (Array.isArray(r.data) ? r.data : Array.isArray(r.campaigns) ? r.campaigns : Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
  return list.slice(0, 10).map((c, i) => {
    const conversions = toNum(c.conversions ?? c.purchases) || actionsValue(c, "purchase", "offsite_conversion.fb_pixel_purchase", "lead", "offsite_conversion.fb_pixel_lead");
    const revenue = toNum(c.revenue ?? c.purchase_value) || actionValuesValue(c, "purchase", "offsite_conversion.fb_pixel_purchase");
    const current = safeMetrics({ spend: toNum(c.spend), impressions: toNum(c.impressions), clicks: toNum(c.clicks ?? c.link_clicks), conversions, revenue });
    return {
      id: String(c.id ?? c.campaign_id ?? `meta-c-${i}`),
      name: String(c.name ?? c.campaign_name ?? `Campagne ${i + 1}`),
      type: c.type ? String(c.type) : undefined,
      status: (["Active", "Paused", "Completed"].includes(String(c.status ?? c.effective_status ?? "")) ? String(c.status ?? c.effective_status) : "Active") as CampaignRow["status"],
      current, previous: zeroMetrics(), delta: safeDelta(current, zeroMetrics()),
    };
  });
}

function buildThumbnailMap(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw || typeof raw !== "object") return map;
  const r = raw as Record<string, unknown>;
  const list = (Array.isArray(r.data) ? r.data : Array.isArray(r.creatives) ? r.creatives : Array.isArray(r.ads) ? r.ads : Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
  for (const cr of list) {
    const id = String(cr.ad_id ?? cr.id ?? "");
    const url = String(cr.thumbnail_url ?? cr.image_url ?? cr.creative_url ?? cr.picture ?? "");
    if (id && url && url !== "undefined") map.set(id, url);
  }
  return map;
}

function extractCreatives(raw: unknown, thumbnailMap?: Map<string, string>): TopCreative[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const list = (Array.isArray(r.data) ? r.data : Array.isArray(r.ads) ? r.ads : Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
  return list.slice(0, 6).map((cr, i) => {
    const conversions = toNum(cr.conversions ?? cr.purchases) || actionsValue(cr, "purchase", "offsite_conversion.fb_pixel_purchase", "lead", "offsite_conversion.fb_pixel_lead");
    const revenue = actionValuesValue(cr, "purchase", "offsite_conversion.fb_pixel_purchase");
    const spend = toNum(cr.spend);
    const id = String(cr.id ?? cr.ad_id ?? `tc-${i}`);
    const inlineThumbnail = cr.thumbnail_url ? String(cr.thumbnail_url) : undefined;
    const mappedThumbnail = thumbnailMap?.get(id);
    return {
      id,
      name: String(cr.name ?? cr.ad_name ?? `Creative ${i + 1}`),
      format: (["Video", "Image", "Carousel"].includes(String(cr.format ?? cr.creative_type ?? "")) ? String(cr.format ?? cr.creative_type) : "Image") as TopCreative["format"],
      spend,
      roas: revenue > 0 && spend > 0 ? revenue / spend : toNum(cr.roas ?? cr.purchase_roas),
      ctr: toNum(cr.ctr),
      cpa: conversions > 0 && spend > 0 ? spend / conversions : toNum(cr.cpa ?? cr.cost_per_purchase),
      impressions: toNum(cr.impressions),
      hookRate: cr.hook_rate !== undefined ? toNum(cr.hook_rate) : undefined,
      thumbnailUrl: inlineThumbnail ?? mappedThumbnail,
    };
  });
}

async function fetchMetaDataBrowser(
  accountId: string, period: DeckPeriod, previousPeriod: DeckPeriod
): Promise<{ overview: PlatformMetrics; campaigns: CampaignRow[]; topCreatives: TopCreative[]; prevOverview: PlatformMetrics } | null> {
  try {
    const [overviewRaw, prevOverviewRaw, campaignsRaw, creativesRaw] = await Promise.allSettled([
      relaySingleTool("mcp__meta-ads-impulse__Account_Overview1", { ad_account_id: accountId, since: period.startDate, until: period.endDate }),
      relaySingleTool("mcp__meta-ads-impulse__Account_Overview1", { ad_account_id: accountId, since: previousPeriod.startDate, until: previousPeriod.endDate }),
      relaySingleTool("mcp__meta-ads-impulse__Campaign_Performance1", { ad_account_id: accountId, since: period.startDate, until: period.endDate }),
      relaySingleTool("mcp__meta-ads-impulse__Ad_Performance1", { ad_account_id: accountId, since: period.startDate, until: period.endDate }),
    ]);
    const overviewData = overviewRaw.status === "fulfilled" ? overviewRaw.value : null;
    if (!overviewData) return null;
    return {
      overview: extractOverviewMetrics(overviewData),
      prevOverview: extractOverviewMetrics(prevOverviewRaw.status === "fulfilled" ? prevOverviewRaw.value : null),
      campaigns: extractCampaigns(campaignsRaw.status === "fulfilled" ? campaignsRaw.value : null),
      topCreatives: extractCreatives(creativesRaw.status === "fulfilled" ? creativesRaw.value : null),
    };
  } catch { return null; }
}

async function fetchGoogleDataBrowser(
  customerId: string, period: DeckPeriod, previousPeriod: DeckPeriod
): Promise<{ overview: PlatformMetrics; campaigns: CampaignRow[]; prevOverview: PlatformMetrics } | null> {
  try {
    const [campaignsRaw, prevCampaignsRaw] = await Promise.allSettled([
      relaySingleTool("mcp__mcp-google-ads__Campaign_Performance", { customer_id: customerId, start_date: period.startDate, end_date: period.endDate }),
      relaySingleTool("mcp__mcp-google-ads__Campaign_Performance", { customer_id: customerId, start_date: previousPeriod.startDate, end_date: previousPeriod.endDate }),
    ]);

    function extractGoogleCampaigns(raw: unknown): { campaigns: CampaignRow[]; overview: PlatformMetrics } {
      if (!raw || typeof raw !== "object") return { campaigns: [], overview: zeroMetrics() };
      const r = raw as Record<string, unknown>;
      const list = (Array.isArray(r.data) ? r.data : Array.isArray(r.campaigns) ? r.campaigns : Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
      let totalSpend = 0, totalImpressions = 0, totalClicks = 0, totalConversions = 0, totalRevenue = 0;
      const campaigns = list.slice(0, 10).map((c, i) => {
        const spendRaw = toNum(c.cost_micros ?? c.spend ?? c.cost);
        const spend = spendRaw > 10000 ? spendRaw / 1_000_000 : spendRaw;
        const impressions = toNum(c.impressions);
        const clicks = toNum(c.clicks);
        const conversions = toNum(c.conversions);
        const revenue = toNum(c.conversions_value ?? c.revenue ?? c.conversion_value);
        totalSpend += spend; totalImpressions += impressions; totalClicks += clicks;
        totalConversions += conversions; totalRevenue += revenue;
        const current = safeMetrics({ spend, impressions, clicks, conversions, revenue });
        return {
          id: String(c.id ?? c.campaign_id ?? (c.campaign as Record<string, unknown>)?.id ?? `google-c-${i}`),
          name: String(c.name ?? c.campaign_name ?? (c.campaign as Record<string, unknown>)?.name ?? `Campagne ${i + 1}`),
          type: c.type ? String(c.type) : undefined,
          status: (["Active", "Paused", "Completed"].includes(String(c.status ?? c.campaign_status ?? "ENABLED")) ? String(c.status ?? c.campaign_status) : "Active") as CampaignRow["status"],
          current, previous: zeroMetrics(), delta: safeDelta(current, zeroMetrics()),
        };
      });
      return { campaigns, overview: safeMetrics({ spend: totalSpend, impressions: totalImpressions, clicks: totalClicks, conversions: totalConversions, revenue: totalRevenue }) };
    }

    const currentData = campaignsRaw.status === "fulfilled" ? extractGoogleCampaigns(campaignsRaw.value) : null;
    const prevData = prevCampaignsRaw.status === "fulfilled" ? extractGoogleCampaigns(prevCampaignsRaw.value) : null;
    if (!currentData) return null;
    return { overview: currentData.overview, campaigns: currentData.campaigns, prevOverview: prevData?.overview ?? zeroMetrics() };
  } catch { return null; }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fetch deck data directly from the relay (browser-side).
 * Returns null if the relay is unreachable — no mock fallback.
 */
export async function fetchDeckData(
  client: DeckClient,
  period: DeckPeriod
): Promise<DeckData | null> {
  const previousPeriod = getPreviousPeriod(period);

  const [metaResult, googleResult] = await Promise.allSettled([
    client.metaAccountId ? fetchMetaDataBrowser(client.metaAccountId, period, previousPeriod) : Promise.resolve(null),
    client.googleCustomerId ? fetchGoogleDataBrowser(client.googleCustomerId, period, previousPeriod) : Promise.resolve(null),
  ]);

  const meta = metaResult.status === "fulfilled" ? metaResult.value : null;
  const google = googleResult.status === "fulfilled" ? googleResult.value : null;

  // If neither platform returned data, fail cleanly
  if (!meta && !google) return null;

  const metaOverview = meta?.overview ?? zeroMetrics();
  const metaPrevOverview = meta?.prevOverview ?? zeroMetrics();
  const googleOverview = google?.overview ?? zeroMetrics();
  const googlePrevOverview = google?.prevOverview ?? zeroMetrics();

  // Totals
  function addMetrics(a: PlatformMetrics, b: PlatformMetrics): PlatformMetrics {
    const spend = a.spend + b.spend;
    const impressions = a.impressions + b.impressions;
    const clicks = a.clicks + b.clicks;
    const conversions = a.conversions + b.conversions;
    const revenue = a.revenue + b.revenue;
    return safeMetrics({ spend, impressions, clicks, conversions, revenue });
  }

  const totalCurrent = addMetrics(metaOverview, googleOverview);
  const totalPrevious = addMetrics(metaPrevOverview, googlePrevOverview);

  const pct = (curr: number, prev: number) => prev > 0 ? ((curr - prev) / prev) * 100 : 0;
  const spendDelta = pct(totalCurrent.spend, totalPrevious.spend);
  const roasDelta = pct(totalCurrent.roas, totalPrevious.roas);
  const cpaDelta = pct(totalCurrent.cpa, totalPrevious.cpa);
  const convDelta = pct(totalCurrent.conversions, totalPrevious.conversions);

  return {
    client,
    period,
    previousPeriod,

    highlights: [
      { title: "Spend Total", value: `${totalCurrent.spend.toLocaleString("fr-FR", { minimumFractionDigits: 0 })} €`, delta: Math.round(spendDelta), description: `${spendDelta >= 0 ? "+" : ""}${spendDelta.toFixed(1)}% vs ${previousPeriod.label}`, icon: "spend" },
      { title: "ROAS Global", value: `x${totalCurrent.roas.toFixed(2)}`, delta: Math.round(roasDelta), description: `${roasDelta >= 0 ? "+" : ""}${roasDelta.toFixed(1)}% vs ${previousPeriod.label}`, icon: "roas" },
      { title: "CPA Moyen", value: `${totalCurrent.cpa.toFixed(2)} €`, delta: Math.round(-cpaDelta), description: `${cpaDelta >= 0 ? "+" : ""}${cpaDelta.toFixed(1)}% vs ${previousPeriod.label}`, icon: "cpa" },
      { title: "Conversions", value: totalCurrent.conversions.toLocaleString("fr-FR"), delta: Math.round(convDelta), description: `${convDelta >= 0 ? "+" : ""}${convDelta.toFixed(1)}% vs ${previousPeriod.label}`, icon: "conversions" },
    ],

    globalTable: [
      { platform: "Google", current: googleOverview, previous: googlePrevOverview, delta: safeDelta(googleOverview, googlePrevOverview) },
      { platform: "Meta", current: metaOverview, previous: metaPrevOverview, delta: safeDelta(metaOverview, metaPrevOverview) },
      { platform: "Total", current: totalCurrent, previous: totalPrevious, delta: safeDelta(totalCurrent, totalPrevious) },
    ],

    ncTable: [],
    googleOverview,
    googleCampaigns: google?.campaigns ?? [],
    metaOverview,
    metaCampaigns: meta?.campaigns ?? [],
    topCreatives: meta?.topCreatives ?? [],
    budget: [],
    learnings: [],
    insightsGoogle: [],
    insightsMeta: [],
    nextStepsGlobal: [],
    nextStepsGoogle: [],
    nextStepsMeta: [],
  };
}
