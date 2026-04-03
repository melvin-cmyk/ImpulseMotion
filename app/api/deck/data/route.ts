/**
 * POST /api/deck/data
 * Fetches real Meta Ads + Google Ads data for a client/period via the relay proxy MCP.
 * Falls back to mock data if relay is unavailable.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
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

export const maxDuration = 120; // Vercel Pro: allow up to 120s

// Server-side: prefer RELAY_URL (server-only), fall back to NEXT_PUBLIC_RELAY_URL, then hardcoded public IP
const rawRelayUrl = (process.env.RELAY_URL || process.env.NEXT_PUBLIC_RELAY_URL || "").trim();
const CONFIGURED_RELAY_URL = rawRelayUrl
  ? rawRelayUrl.startsWith("http") ? rawRelayUrl : `https://${rawRelayUrl}`
  : null;

const RELAY_FALLBACK_URL = "http://72.62.29.196:3457";
// Try localhost first (when running locally), then configured URL, then hardcoded public IP
const RELAY_URLS_TO_TRY = [
  "http://localhost:3457",
  ...(CONFIGURED_RELAY_URL && CONFIGURED_RELAY_URL !== RELAY_FALLBACK_URL ? [CONFIGURED_RELAY_URL] : []),
  RELAY_FALLBACK_URL,
];

// ── Relay helpers ─────────────────────────────────────────────────────────────

async function relayChat(prompt: string, timeoutMs = 90000): Promise<string> {
  const urls = RELAY_URLS_TO_TRY;

  let lastError: Error | null = null;
  for (const url of urls) {
    // localhost gets a short timeout — fail fast if relay isn't running locally
    const isLocalhost = url.includes("localhost");
    const actualTimeout = isLocalhost ? Math.min(timeoutMs, 5000) : timeoutMs;
    try {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(actualTimeout),
      });
      if (!res.ok) { lastError = new Error(`Relay ${url} responded ${res.status}`); continue; }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let fullText = "";
      let toolResultText = ""; // Raw MCP tool output — more reliable than LLM-formatted text
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete lines (keep incomplete line in buffer)
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;

          try {
            const event = JSON.parse(data);
            // tool_result — raw MCP output (highest priority — use directly)
            if (event.type === "tool_result" && typeof event.content === "string") { toolResultText += event.content; continue; }
            // OpenClaw custom format
            if (event.type === "delta" && typeof event.text === "string") { fullText += event.text; continue; }
            // "content" is final complete text — replace, don't append
            if (event.type === "content" && typeof event.text === "string") { fullText = event.text; continue; }
            if (event.type === "content" && typeof event.content === "string") { fullText = event.content; continue; }
            // Anthropic standard streaming format (content_block_delta)
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta?.text === "string") {
              fullText += event.delta.text; continue;
            }
            // OpenAI-style (choices[0].delta.content)
            if (event.choices?.[0]?.delta?.content) { fullText += event.choices[0].delta.content; continue; }
            // Generic text field
            if (event.type === "text" && typeof event.text === "string") { fullText += event.text; continue; }
            // message.content string
            if (event.message?.content && typeof event.message.content === "string") { fullText += event.message.content; continue; }
          } catch {
            // Not JSON — treat as raw text fragment
            fullText += data;
          }
        }
      }

      // Prefer raw tool result over LLM-formatted text
      const result = toolResultText.trim() || fullText.trim();
      console.log(`[relay] ${url} toolResult=${toolResultText.length}b fullText=${fullText.length}b`);
      if (result) return result;
      lastError = new Error(`Empty response from ${url}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error("All relay URLs failed");
}

function extractJson<T>(text: string): T | null {
  // Try multiple strategies to extract JSON from relay response
  // 1. Strip markdown code blocks first
  const stripped = text.replace(/```(?:json)?\n?([\s\S]*?)\n?```/g, "$1").trim();

  // 2. Try to find a JSON object or array (greedy match)
  for (const candidate of [stripped, text]) {
    const objectMatch = candidate.match(/\{[\s\S]*\}/);
    const arrayMatch = candidate.match(/\[[\s\S]*\]/);
    const match = objectMatch || arrayMatch;
    if (!match) continue;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      // Try to find the last valid JSON by finding matching braces
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
            try {
              return JSON.parse(raw.slice(start, i + 1)) as T;
            } catch { continue; }
          }
        }
      }
    }
  }
  return null;
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
    delta[key] = prev !== 0 ? ((curr - prev) / Math.abs(prev)) * 100 : curr !== 0 ? 999 : 0;
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

// Make a single-tool relay call and return the raw JSON result
async function relaySingleTool(toolName: string, params: Record<string, string>, timeoutMs = 60000): Promise<unknown> {
  const paramStr = Object.entries(params).map(([k, v]) => `${k}="${v}"`).join(", ");
  const prompt = `Call the tool ${toolName} with params: ${paramStr}. Return ONLY the raw JSON result from the tool. No explanation, no markdown, no text before or after. Just the raw JSON.`;
  const text = await relayChat(prompt, timeoutMs);
  return extractJson(text);
}

async function fetchMetaData(
  accountId: string,
  period: DeckPeriod,
  previousPeriod: DeckPeriod,
  metaToken: string
): Promise<{ overview: PlatformMetrics; campaigns: CampaignRow[]; topCreatives: TopCreative[]; prevOverview: PlatformMetrics } | null> {
  try {
    // Normalise account ID to act_XXXXX format
    const rawId = accountId.startsWith("act_") ? accountId.slice(4) : accountId;
    const actId = `act_${rawId}`;

    const BASE = "https://graph.facebook.com/v22.0";
    const timeRange = (p: DeckPeriod) => encodeURIComponent(JSON.stringify({ since: p.startDate, until: p.endDate }));
    const tok = encodeURIComponent(metaToken);

    async function metaFetch(url: string): Promise<unknown> {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Meta API ${res.status}: ${body.slice(0, 200)}`);
      }
      return res.json();
    }

    const overviewFields = "impressions,reach,clicks,spend,ctr,cpc,cpm,actions,action_values";
    const campaignFields = "campaign_name,impressions,clicks,spend,ctr,cpc,cpm,actions,action_values";
    const adFields = "ad_name,adset_name,campaign_name,impressions,clicks,spend,ctr,cpc,cpm,actions,action_values,creative{thumbnail_url,image_url}";

    // Fire 4 parallel direct Graph API calls
    const [overviewRaw, prevOverviewRaw, campaignsRaw, creativesRaw] = await Promise.allSettled([
      metaFetch(`${BASE}/${actId}/insights?fields=${overviewFields}&time_range=${timeRange(period)}&level=account&access_token=${tok}`),
      metaFetch(`${BASE}/${actId}/insights?fields=${overviewFields}&time_range=${timeRange(previousPeriod)}&level=account&access_token=${tok}`),
      metaFetch(`${BASE}/${actId}/insights?level=campaign&fields=${campaignFields}&time_range=${timeRange(period)}&access_token=${tok}`),
      metaFetch(`${BASE}/${actId}/insights?level=ad&fields=${adFields}&time_range=${timeRange(period)}&sort=spend_descending&limit=10&access_token=${tok}`),
    ]);

    const logResult = (name: string, r: PromiseSettledResult<unknown>) =>
      r.status === "fulfilled"
        ? console.log(`[deck/data] meta ${name} ok:`, JSON.stringify(r.value).slice(0, 500))
        : console.error(`[deck/data] meta ${name} failed:`, r.reason);
    logResult("overview", overviewRaw);
    logResult("prevOverview", prevOverviewRaw);
    logResult("campaigns", campaignsRaw);
    logResult("creatives", creativesRaw);

    // Extract a value from Meta actions array by action_type(s)
    function actionsValue(obj: Record<string, unknown>, ...types: string[]): number {
      const actions = Array.isArray(obj.actions) ? obj.actions as Array<{action_type: string; value: string}> : [];
      for (const t of types) {
        const found = actions.find(a => a.action_type === t);
        if (found) return toNum(found.value);
      }
      return 0;
    }

    // Extract revenue from action_values array
    function actionValuesValue(obj: Record<string, unknown>, ...types: string[]): number {
      const actionValues = Array.isArray(obj.action_values) ? obj.action_values as Array<{action_type: string; value: string}> : [];
      for (const t of types) {
        const found = actionValues.find(a => a.action_type === t);
        if (found) return toNum(found.value);
      }
      return 0;
    }

    // Extract overview metrics — Meta Ads API returns conversions/revenue inside `actions` and `action_values` arrays
    function extractOverviewMetrics(raw: unknown): PlatformMetrics {
      if (!raw || typeof raw !== "object") return zeroMetrics();
      const r = raw as Record<string, unknown>;
      const data = (r.data ?? r.overview ?? r.account_overview ?? r) as Record<string, unknown>;
      const arr = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
      if (!arr || typeof arr !== "object") return zeroMetrics();

      // Conversions: try direct field first, then Meta actions array (leads, purchases)
      const conversions = toNum(arr.conversions ?? arr.purchases)
        || actionsValue(arr, "purchase", "offsite_conversion.fb_pixel_purchase", "lead", "offsite_conversion.fb_pixel_lead", "complete_registration");

      // Revenue: try direct field first, then Meta action_values array
      const revenue = toNum(arr.revenue ?? arr.purchase_roas_value ?? arr.action_values_purchase)
        || actionValuesValue(arr, "purchase", "offsite_conversion.fb_pixel_purchase");

      return safeMetrics({
        spend: toNum(arr.spend ?? arr.amount_spent ?? arr.total_spend),
        impressions: toNum(arr.impressions),
        clicks: toNum(arr.clicks ?? arr.link_clicks),
        conversions,
        revenue,
      });
    }

    function extractCampaigns(raw: unknown): CampaignRow[] {
      if (!raw || typeof raw !== "object") return [];
      const r = raw as Record<string, unknown>;
      const list = (Array.isArray(r.data) ? r.data : Array.isArray(r.campaigns) ? r.campaigns : Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
      return list.slice(0, 10).map((c, i) => {
        const conversions = toNum(c.conversions ?? c.purchases)
          || actionsValue(c, "purchase", "offsite_conversion.fb_pixel_purchase", "lead", "offsite_conversion.fb_pixel_lead");
        const revenue = toNum(c.revenue ?? c.purchase_value)
          || actionValuesValue(c, "purchase", "offsite_conversion.fb_pixel_purchase");
        const current = safeMetrics({
          spend: toNum(c.spend), impressions: toNum(c.impressions), clicks: toNum(c.clicks ?? c.link_clicks),
          conversions, revenue,
        });
        return {
          id: String(c.id ?? c.campaign_id ?? `meta-c-${i}`),
          name: String(c.name ?? c.campaign_name ?? `Campagne ${i + 1}`),
          type: c.type ? String(c.type) : undefined,
          status: (["Active", "Paused", "Completed"].includes(String(c.status ?? c.effective_status ?? "")) ? String(c.status ?? c.effective_status) : "Active") as CampaignRow["status"],
          current,
          previous: zeroMetrics(),
          delta: safeDelta(current, zeroMetrics()),
        };
      });
    }

    function extractCreatives(raw: unknown): TopCreative[] {
      if (!raw || typeof raw !== "object") return [];
      const r = raw as Record<string, unknown>;
      const list = (Array.isArray(r.data) ? r.data : Array.isArray(r.ads) ? r.ads : Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
      return list.slice(0, 6).map((cr, i) => {
        const conversions = toNum(cr.conversions ?? cr.purchases)
          || actionsValue(cr, "purchase", "offsite_conversion.fb_pixel_purchase", "lead", "offsite_conversion.fb_pixel_lead");
        const revenue = actionValuesValue(cr, "purchase", "offsite_conversion.fb_pixel_purchase");
        const spend = toNum(cr.spend);
        return {
          id: String(cr.id ?? cr.ad_id ?? `tc-${i}`),
          name: String(cr.name ?? cr.ad_name ?? `Creative ${i + 1}`),
          format: (["Video", "Image", "Carousel"].includes(String(cr.format ?? cr.creative_type ?? "")) ? String(cr.format ?? cr.creative_type) : "Image") as TopCreative["format"],
          spend,
          roas: revenue > 0 && spend > 0 ? revenue / spend : toNum(cr.roas ?? cr.purchase_roas),
          ctr: toNum(cr.ctr),
          cpa: conversions > 0 && spend > 0 ? spend / conversions : toNum(cr.cpa ?? cr.cost_per_purchase),
          impressions: toNum(cr.impressions),
          hookRate: cr.hook_rate !== undefined ? toNum(cr.hook_rate) : undefined,
          thumbnailUrl: (() => {
            // Direct thumbnail_url field OR nested creative object
            if (cr.thumbnail_url) return String(cr.thumbnail_url);
            const creative = cr.creative as Record<string, unknown> | undefined;
            if (creative?.thumbnail_url) return String(creative.thumbnail_url);
            if (creative?.image_url) return String(creative.image_url);
            return undefined;
          })(),
        };
      });
    }

    const overviewData = overviewRaw.status === "fulfilled" ? overviewRaw.value : null;
    const prevOverviewData = prevOverviewRaw.status === "fulfilled" ? prevOverviewRaw.value : null;
    const campaignsData = campaignsRaw.status === "fulfilled" ? campaignsRaw.value : null;
    const creativesData = creativesRaw.status === "fulfilled" ? creativesRaw.value : null;

    // Need at least the overview to return real data
    if (!overviewData) return null;

    const overview = extractOverviewMetrics(overviewData);
    const prevOverview = extractOverviewMetrics(prevOverviewData);
    const campaigns = extractCampaigns(campaignsData);
    const topCreatives = extractCreatives(creativesData);

    return { overview, campaigns, topCreatives, prevOverview };
  } catch (e) {
    console.error("[deck/data] fetchMetaData error:", e);
    return null;
  }
}

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.-]/g, "")) : Number(v);
  return isFinite(n) ? n : 0;
}

async function fetchGoogleData(
  customerId: string,
  period: DeckPeriod,
  previousPeriod: DeckPeriod
): Promise<{ overview: PlatformMetrics; campaigns: CampaignRow[]; prevOverview: PlatformMetrics } | null> {
  // Google Ads tools require customer_id without dashes (e.g. "1234567890" not "123-456-7890")
  const cleanId = customerId.replace(/-/g, "");
  try {
    const [campaignsRaw, prevCampaignsRaw] = await Promise.allSettled([
      relaySingleTool("mcp__mcp-google-ads__Campaign_Performance", {
        customer_id: cleanId, start_date: period.startDate, end_date: period.endDate,
      }),
      relaySingleTool("mcp__mcp-google-ads__Campaign_Performance", {
        customer_id: cleanId, start_date: previousPeriod.startDate, end_date: previousPeriod.endDate,
      }),
    ]);

    console.log("[deck/data] google campaigns ok:", campaignsRaw.status);

    function extractGoogleCampaigns(raw: unknown): { campaigns: CampaignRow[]; overview: PlatformMetrics } {
      if (!raw || typeof raw !== "object") return { campaigns: [], overview: zeroMetrics() };
      const r = raw as Record<string, unknown>;
      const list = (Array.isArray(r.data) ? r.data : Array.isArray(r.campaigns) ? r.campaigns : Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
      let totalSpend = 0, totalImpressions = 0, totalClicks = 0, totalConversions = 0, totalRevenue = 0;
      const campaigns = list.slice(0, 10).map((c, i) => {
        // Google Ads costs are in micros — divide by 1,000,000
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
          id: String(c.id ?? c.campaign_id ?? (c.campaign as Record<string,unknown>)?.id ?? `google-c-${i}`),
          name: String(c.name ?? c.campaign_name ?? (c.campaign as Record<string,unknown>)?.name ?? `Campagne ${i + 1}`),
          type: c.type ? String(c.type) : undefined,
          status: (["Active", "Paused", "Completed"].includes(String(c.status ?? c.campaign_status ?? "ENABLED")) ? String(c.status ?? c.campaign_status) : "Active") as CampaignRow["status"],
          current,
          previous: zeroMetrics(),
          delta: safeDelta(current, zeroMetrics()),
        };
      });
      return {
        campaigns,
        overview: safeMetrics({ spend: totalSpend, impressions: totalImpressions, clicks: totalClicks, conversions: totalConversions, revenue: totalRevenue }),
      };
    }

    const currentData = campaignsRaw.status === "fulfilled" ? extractGoogleCampaigns(campaignsRaw.value) : null;
    const prevData = prevCampaignsRaw.status === "fulfilled" ? extractGoogleCampaigns(prevCampaignsRaw.value) : null;

    if (!currentData) return null;

    return {
      overview: currentData.overview,
      campaigns: currentData.campaigns,
      prevOverview: prevData?.overview ?? zeroMetrics(),
    };
  } catch (e) {
    console.error("[deck/data] fetchGoogleData error:", e);
    return null;
  }
}

// ── AI text content ───────────────────────────────────────────────────────────

interface AiTextContent {
  learnings: string[];
  insightsGoogle: string[];
  insightsMeta: string[];
  nextStepsGlobal: string[];
  nextStepsGoogle: string[];
  nextStepsMeta: string[];
}

async function fetchAiTextContent(
  data: {
    googleOverview: PlatformMetrics;
    metaOverview: PlatformMetrics;
    clientName: string;
    periodLabel: string;
  },
  userContext?: string
): Promise<AiTextContent | null> {
  const g = data.googleOverview;
  const m = data.metaOverview;
  const fmt = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const contextBlock = userContext ? `\n\nAdditional context from the analyst: ${userContext}` : "";

  const prompt = `You are an expert digital marketing analyst. Based on the following real ad performance data for ${data.clientName} (${data.periodLabel}), generate concise bullet points for a Monthly Business Review deck.${contextBlock}

Google Ads data:
- Spend: €${fmt(g.spend)}
- Impressions: ${Math.round(g.impressions).toLocaleString()}
- Clicks: ${Math.round(g.clicks).toLocaleString()}
- Conversions: ${Math.round(g.conversions)}
- Revenue: €${fmt(g.revenue)}
- ROAS: ${fmt(g.roas)}x
- CPA: €${fmt(g.cpa)}
- CTR: ${fmt(g.ctr)}%

Meta Ads data:
- Spend: €${fmt(m.spend)}
- Impressions: ${Math.round(m.impressions).toLocaleString()}
- Clicks: ${Math.round(m.clicks).toLocaleString()}
- Conversions: ${Math.round(m.conversions)}
- Revenue: €${fmt(m.revenue)}
- ROAS: ${fmt(m.roas)}x
- CPA: €${fmt(m.cpa)}
- CTR: ${fmt(m.ctr)}%

Generate exactly this JSON structure (no markdown, no explanation, just raw JSON):
{
  "learnings": ["3-4 key learnings about overall performance this month"],
  "insightsGoogle": ["3-4 insights specific to Google Ads performance"],
  "insightsMeta": ["3-4 insights specific to Meta Ads performance"],
  "nextStepsGlobal": ["3-4 global action items for next month"],
  "nextStepsGoogle": ["3-4 specific Google Ads optimisations for next month"],
  "nextStepsMeta": ["3-4 specific Meta Ads optimisations for next month"]
}`;

  try {
    const text = await relayChat(prompt, 25000);
    const result = extractJson<AiTextContent>(text);
    if (!result) return null;
    // Validate structure
    const keys: (keyof AiTextContent)[] = ["learnings", "insightsGoogle", "insightsMeta", "nextStepsGlobal", "nextStepsGoogle", "nextStepsMeta"];
    for (const key of keys) {
      if (!Array.isArray(result[key])) return null;
    }
    return result;
  } catch {
    return null;
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let client: DeckClient, period: DeckPeriod, userContext: string | undefined;
  try {
    const body = await req.json();
    client = body.client;
    period = body.period;
    userContext = typeof body.userContext === "string" ? body.userContext : undefined;
    if (!client || !period) throw new Error("Missing client or period");
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const session = await auth();
  const metaToken = (session as { metaAccessToken?: string | null } | null)?.metaAccessToken ?? null;

  const previousPeriod = getPreviousPeriod(period);

  // Try to fetch real data in parallel
  const [metaResult, googleResult] = await Promise.allSettled([
    client.metaAccountId && metaToken
      ? fetchMetaData(client.metaAccountId, period, previousPeriod, metaToken)
      : Promise.resolve(null),
    client.googleCustomerId
      ? fetchGoogleData(client.googleCustomerId, period, previousPeriod)
      : Promise.resolve(null),
  ]);
  // Note: calls run in parallel, each capped at 35s → ~35s total (parallel)

  const meta = metaResult.status === "fulfilled" ? metaResult.value : null;
  const google = googleResult.status === "fulfilled" ? googleResult.value : null;
  const metaError = metaResult.status === "rejected" ? String(metaResult.reason) : (meta === null && client.metaAccountId ? "No data parsed from relay response" : null);
  const googleError = googleResult.status === "rejected" ? String(googleResult.reason) : (google === null && client.googleCustomerId ? "No data parsed from relay response" : null);

  console.error("[deck/data] relay results:", {
    relayUrls: RELAY_URLS_TO_TRY,
    metaAccountId: client.metaAccountId,
    googleCustomerId: client.googleCustomerId,
    metaOk: !!meta,
    googleOk: !!google,
    metaError,
    googleError,
  });

  // If both failed, fallback to mock data entirely
  if (!meta && !google) {
    const mockData = generateMockDeckData(client, period);
    const reason = [metaError, googleError].filter(Boolean).join(" | ");
    return NextResponse.json({ data: mockData, source: "mock", reason });
  }

  // At least one is real — fetch AI text content in parallel with building the deck


  // Build DeckData from real data, filling in missing parts from mock
  const mockFallback = generateMockDeckData(client, period);

  const metaOverview = meta?.overview ?? mockFallback.metaOverview;
  const metaPrevOverview = meta?.prevOverview ?? zeroMetrics();
  const googleOverview = google?.overview ?? mockFallback.googleOverview;
  const googlePrevOverview = google?.prevOverview ?? zeroMetrics();

  // Fetch AI text content with a tight budget (20s max) — non-blocking if it fails
  const aiTextPromise = Promise.race([
    fetchAiTextContent(
      { googleOverview, metaOverview, clientName: client.name, periodLabel: period.label },
      userContext
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 30000)),
  ]);

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
    ? ((totalCurrent.spend - totalPrevious.spend) / totalPrevious.spend) * 100 : null;
  const roasDelta = totalPrevious.roas > 0
    ? ((totalCurrent.roas - totalPrevious.roas) / totalPrevious.roas) * 100 : null;
  const cpaDelta = totalPrevious.cpa > 0
    ? ((totalCurrent.cpa - totalPrevious.cpa) / totalPrevious.cpa) * 100 : null;
  const convDelta = totalPrevious.conversions > 0
    ? ((totalCurrent.conversions - totalPrevious.conversions) / totalPrevious.conversions) * 100 : null;

  const deckData: DeckData = {
    client,
    period,
    previousPeriod,

    highlights: [
      {
        title: "Spend Total",
        value: `${totalCurrent.spend.toLocaleString("fr-FR", { minimumFractionDigits: 0 })} €`,
        delta: spendDelta !== null ? Math.round(spendDelta) : undefined,
        description: spendDelta !== null ? `${spendDelta >= 0 ? "+" : ""}${spendDelta.toFixed(1)}% vs ${previousPeriod.label}` : `vs ${previousPeriod.label}`,
        icon: "spend",
      },
      {
        title: "ROAS Global",
        value: `x${totalCurrent.roas.toFixed(2)}`,
        delta: roasDelta !== null ? Math.round(roasDelta) : undefined,
        description: roasDelta !== null ? `${roasDelta >= 0 ? "+" : ""}${roasDelta.toFixed(1)}% vs ${previousPeriod.label}` : `vs ${previousPeriod.label}`,
        icon: "roas",
      },
      {
        title: "CPA Moyen",
        value: `${totalCurrent.cpa.toFixed(2)} €`,
        delta: cpaDelta !== null ? Math.round(-cpaDelta) : undefined, // negative delta is good for CPA
        description: cpaDelta !== null ? `${cpaDelta >= 0 ? "+" : ""}${cpaDelta.toFixed(1)}% vs ${previousPeriod.label}` : `vs ${previousPeriod.label}`,
        icon: "cpa",
      },
      {
        title: "Conversions",
        value: totalCurrent.conversions.toLocaleString("fr-FR"),
        delta: convDelta !== null ? Math.round(convDelta) : undefined,
        description: convDelta !== null ? `${convDelta >= 0 ? "+" : ""}${convDelta.toFixed(1)}% vs ${previousPeriod.label}` : `vs ${previousPeriod.label}`,
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
    googleCampaigns: (google?.campaigns?.length ? google.campaigns : null) ?? mockFallback.googleCampaigns,

    metaOverview,
    metaCampaigns: (meta?.campaigns?.length ? meta.campaigns : null) ?? mockFallback.metaCampaigns,
    topCreatives: (meta?.topCreatives?.length ? meta.topCreatives : null) ?? mockFallback.topCreatives,

    budget: mockFallback.budget,

    // Filled in after AI text resolves below
    learnings: mockFallback.learnings,
    insightsGoogle: mockFallback.insightsGoogle,
    insightsMeta: mockFallback.insightsMeta,
    nextStepsGlobal: mockFallback.nextStepsGlobal,
    nextStepsGoogle: mockFallback.nextStepsGoogle,
    nextStepsMeta: mockFallback.nextStepsMeta,
  };

  // Await AI text content and override mock fallbacks if successful
  const aiText = await aiTextPromise;
  if (aiText) {
    deckData.learnings = aiText.learnings;
    deckData.insightsGoogle = aiText.insightsGoogle;
    deckData.insightsMeta = aiText.insightsMeta;
    deckData.nextStepsGlobal = aiText.nextStepsGlobal;
    deckData.nextStepsGoogle = aiText.nextStepsGoogle;
    deckData.nextStepsMeta = aiText.nextStepsMeta;
  }

  return NextResponse.json({ data: deckData, source: "real" });
}
