/**
 * POST /api/deck/generate
 * Fetches real Meta Ads + Google Ads data via the relay proxy MCP,
 * then calls Anthropic API directly to generate a structured JSON slide plan.
 *
 * Body: { customerId, platform, dateRange, sections[], context, budgets }
 * Returns: { slides: Slide[], dataSource: "real"|"partial"|"mock" }
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getPreviousPeriod,
  type DeckPeriod,
  type PlatformMetrics,
  type CampaignRow,
  type TopCreative,
} from "@/lib/deck-data";
import { getDeckHistory, saveDeckHistory } from "@/lib/deck-history-storage";

export const maxDuration = 120; // Vercel Pro: allow up to 120s

// ── Relay URL resolution (same pattern as data/route.ts) ──────────────────────

const rawRelayUrl = (process.env.RELAY_URL || process.env.NEXT_PUBLIC_RELAY_URL || "").trim();
const CONFIGURED_RELAY_URL = rawRelayUrl
  ? rawRelayUrl.startsWith("http") ? rawRelayUrl : `https://${rawRelayUrl}`
  : null;

const RELAY_FALLBACK_URL = "http://72.62.29.196:3457";
// Try localhost first (fast fail when not running locally), then configured, then hardcoded public IP
const RELAY_URLS_TO_TRY = [
  "http://localhost:3457",
  ...(CONFIGURED_RELAY_URL && CONFIGURED_RELAY_URL !== RELAY_FALLBACK_URL ? [CONFIGURED_RELAY_URL] : []),
  RELAY_FALLBACK_URL,
];

// ── Slide types ───────────────────────────────────────────────────────────────

export interface SlideKpi {
  label: string;
  value: string;
  delta?: string;
  trend?: "up" | "down" | "flat";
}

export interface SlideChart {
  type: "bar" | "line" | "pie" | "funnel";
  data: Record<string, unknown>;
}

export interface SlideImage {
  url: string;
  label?: string;
  metrics?: string;
}

export interface Slide {
  id: string;
  type: "overview" | "performance" | "creative" | "funnel" | "alert" | "recommendation" | "comparison";
  title: string;
  subtitle?: string;
  kpis?: SlideKpi[];
  insights?: string[];
  chart?: SlideChart;
  images?: SlideImage[];
  recommendation?: string;
  severity?: "ok" | "warning" | "alert";
}

// ── Relay helpers (same as data/route.ts) ─────────────────────────────────────

async function relayChat(prompt: string, timeoutMs = 90000): Promise<string> {
  let lastError: Error | null = null;
  for (const url of RELAY_URLS_TO_TRY) {
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

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;

          try {
            const event = JSON.parse(data);
            if (event.type === "tool_result" && typeof event.content === "string") { toolResultText += event.content; continue; }
            if (event.type === "delta" && typeof event.text === "string") { fullText += event.text; continue; }
            if (event.type === "content" && typeof event.text === "string") { fullText = event.text; continue; }
            if (event.type === "content" && typeof event.content === "string") { fullText = event.content; continue; }
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta?.text === "string") {
              fullText += event.delta.text; continue;
            }
            if (event.choices?.[0]?.delta?.content) { fullText += event.choices[0].delta.content; continue; }
            if (event.type === "text" && typeof event.text === "string") { fullText += event.text; continue; }
            if (event.message?.content && typeof event.message.content === "string") { fullText += event.message.content; continue; }
          } catch {
            fullText += data;
          }
        }
      }

      const result = toolResultText.trim() || fullText.trim();
      console.log(`[deck/generate] relay ${url} toolResult=${toolResultText.length}b fullText=${fullText.length}b`);
      if (result) return result;
      lastError = new Error(`Empty response from ${url}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error("All relay URLs failed");
}

function extractJson<T>(text: string): T | null {
  const stripped = text.replace(/```(?:json)?\n?([\s\S]*?)\n?```/g, "$1").trim();

  for (const candidate of [stripped, text]) {
    const arrayMatch = candidate.match(/\[[\s\S]*\]/);
    const objectMatch = candidate.match(/\{[\s\S]*\}/);
    const match = arrayMatch || objectMatch;
    if (!match) continue;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
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

// ── Raw types for MCP responses ───────────────────────────────────────────────

interface RawCampaign {
  id?: string;
  campaign_id?: string;
  name?: string;
  campaign_name?: string;
  type?: string;
  status?: string;
  campaign_status?: string;
  effective_status?: string;
  spend?: number;
  impressions?: number;
  clicks?: number;
  link_clicks?: number;
  conversions?: number;
  purchases?: number;
  revenue?: number;
  purchase_value?: number;
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
  // Google Ads micros format
  cost_micros?: number;
  cost?: number;
  conversions_value?: number;
  conversion_value?: number;
  // Meta actions
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
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
  conversions?: number;
  purchases?: number;
  // Meta actions arrays
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
}

// ── MCP single-tool call helper ───────────────────────────────────────────────

async function relaySingleTool(toolName: string, params: Record<string, string>, timeoutMs = 60000): Promise<unknown> {
  const paramStr = Object.entries(params).map(([k, v]) => `${k}="${v}"`).join(", ");
  const prompt = `Call the tool ${toolName} with params: ${paramStr}. Return ONLY the raw JSON result from the tool. No explanation, no markdown, no text before or after. Just the raw JSON.`;
  const text = await relayChat(prompt, timeoutMs);
  return extractJson(text);
}

// ── Meta Ads data fetcher ─────────────────────────────────────────────────────

async function fetchMetaData(
  accountId: string,
  period: DeckPeriod,
  previousPeriod: DeckPeriod
): Promise<{ overview: PlatformMetrics; campaigns: CampaignRow[]; topCreatives: TopCreative[]; prevOverview: PlatformMetrics } | null> {
  try {
    const [overviewRaw, prevOverviewRaw, campaignsRaw, creativesRaw] = await Promise.allSettled([
      relaySingleTool("mcp__meta-ads-impulse__Account_Overview1", {
        ad_account_id: accountId, since: period.startDate, until: period.endDate,
      }),
      relaySingleTool("mcp__meta-ads-impulse__Account_Overview1", {
        ad_account_id: accountId, since: previousPeriod.startDate, until: previousPeriod.endDate,
      }),
      relaySingleTool("mcp__meta-ads-impulse__Campaign_Performance1", {
        ad_account_id: accountId, since: period.startDate, until: period.endDate,
      }),
      relaySingleTool("mcp__meta-ads-impulse__Ad_Performance1", {
        ad_account_id: accountId, since: period.startDate, until: period.endDate,
      }),
    ]);

    const logResult = (name: string, r: PromiseSettledResult<unknown>) =>
      r.status === "fulfilled"
        ? console.log(`[deck/generate] ${name} ok:`, JSON.stringify(r.value).slice(0, 300))
        : console.error(`[deck/generate] ${name} failed:`, r.reason);

    logResult("meta/overview", overviewRaw);
    logResult("meta/prevOverview", prevOverviewRaw);
    logResult("meta/campaigns", campaignsRaw);
    logResult("meta/creatives", creativesRaw);

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
          name: String(c.name ?? c.campaign_name ?? `Campaign ${i + 1}`),
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
        const rc = cr as RawCreative;
        const conversions = toNum(rc.conversions ?? rc.purchases)
          || (rc.actions ? actionsValue(cr as Record<string, unknown>, "purchase", "offsite_conversion.fb_pixel_purchase", "lead") : 0);
        const revenue = rc.action_values ? actionValuesValue(cr as Record<string, unknown>, "purchase", "offsite_conversion.fb_pixel_purchase") : 0;
        const spend = toNum(rc.spend);
        return {
          id: String(rc.id ?? `tc-${i}`),
          name: String(rc.name ?? `Creative ${i + 1}`),
          format: (["Video", "Image", "Carousel"].includes(String(rc.format ?? "")) ? String(rc.format) : "Image") as TopCreative["format"],
          spend,
          roas: revenue > 0 && spend > 0 ? revenue / spend : toNum(rc.roas),
          ctr: toNum(rc.ctr),
          cpa: conversions > 0 && spend > 0 ? spend / conversions : toNum(rc.cpa),
          impressions: toNum(rc.impressions),
          hookRate: rc.hookRate !== undefined ? toNum(rc.hookRate) : undefined,
          thumbnailUrl: rc.thumbnailUrl ? String(rc.thumbnailUrl) : undefined,
        };
      });
    }

    const overviewData = overviewRaw.status === "fulfilled" ? overviewRaw.value : null;
    const prevOverviewData = prevOverviewRaw.status === "fulfilled" ? prevOverviewRaw.value : null;
    const campaignsData = campaignsRaw.status === "fulfilled" ? campaignsRaw.value : null;
    const creativesData = creativesRaw.status === "fulfilled" ? creativesRaw.value : null;

    if (!overviewData) return null;

    return {
      overview: extractOverviewMetrics(overviewData),
      prevOverview: extractOverviewMetrics(prevOverviewData),
      campaigns: extractCampaigns(campaignsData),
      topCreatives: extractCreatives(creativesData),
    };
  } catch (e) {
    console.error("[deck/generate] fetchMetaData error:", e);
    return null;
  }
}

// ── Direct Meta Graph API fetcher (faster and more reliable than relay MCP) ──

async function fetchMetaDataDirect(
  accountId: string,
  period: DeckPeriod,
  previousPeriod: DeckPeriod,
  metaToken: string
): Promise<{ overview: PlatformMetrics; campaigns: CampaignRow[]; topCreatives: TopCreative[]; prevOverview: PlatformMetrics } | null> {
  try {
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

    const [overviewRaw, prevOverviewRaw, campaignsRaw, creativesRaw] = await Promise.allSettled([
      metaFetch(`${BASE}/${actId}/insights?fields=${overviewFields}&time_range=${timeRange(period)}&level=account&access_token=${tok}`),
      metaFetch(`${BASE}/${actId}/insights?fields=${overviewFields}&time_range=${timeRange(previousPeriod)}&level=account&access_token=${tok}`),
      metaFetch(`${BASE}/${actId}/insights?level=campaign&fields=${campaignFields}&time_range=${timeRange(period)}&access_token=${tok}`),
      metaFetch(`${BASE}/${actId}/insights?level=ad&fields=${adFields}&time_range=${timeRange(period)}&sort=spend_descending&limit=10&access_token=${tok}`),
    ]);

    function actionsValue(obj: Record<string, unknown>, ...types: string[]): number {
      const actions = Array.isArray(obj.actions) ? obj.actions as Array<{ action_type: string; value: string }> : [];
      for (const t of types) { const f = actions.find(a => a.action_type === t); if (f) return toNum(f.value); }
      return 0;
    }

    function actionValuesValue(obj: Record<string, unknown>, ...types: string[]): number {
      const vals = Array.isArray(obj.action_values) ? obj.action_values as Array<{ action_type: string; value: string }> : [];
      for (const t of types) { const f = vals.find(a => a.action_type === t); if (f) return toNum(f.value); }
      return 0;
    }

    function extractOverview(raw: unknown): PlatformMetrics {
      if (!raw || typeof raw !== "object") return zeroMetrics();
      const r = raw as Record<string, unknown>;
      const data = (r.data ?? r) as Record<string, unknown>;
      const arr = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
      if (!arr || typeof arr !== "object") return zeroMetrics();
      const conversions = toNum(arr.conversions ?? arr.purchases)
        || actionsValue(arr, "purchase", "offsite_conversion.fb_pixel_purchase", "lead", "offsite_conversion.fb_pixel_lead", "complete_registration");
      const revenue = toNum(arr.revenue ?? arr.purchase_roas_value)
        || actionValuesValue(arr, "purchase", "offsite_conversion.fb_pixel_purchase");
      return safeMetrics({ spend: toNum(arr.spend), impressions: toNum(arr.impressions), clicks: toNum(arr.clicks), conversions, revenue });
    }

    function extractCamps(raw: unknown): CampaignRow[] {
      if (!raw || typeof raw !== "object") return [];
      const r = raw as Record<string, unknown>;
      const list = (Array.isArray(r.data) ? r.data : Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
      return list.slice(0, 10).map((c, i) => {
        const conversions = toNum(c.conversions) || actionsValue(c, "purchase", "offsite_conversion.fb_pixel_purchase", "lead");
        const revenue = actionValuesValue(c, "purchase", "offsite_conversion.fb_pixel_purchase");
        const current = safeMetrics({ spend: toNum(c.spend), impressions: toNum(c.impressions), clicks: toNum(c.clicks), conversions, revenue });
        return {
          id: String(c.campaign_id ?? `meta-c-${i}`),
          name: String(c.campaign_name ?? `Campagne ${i + 1}`),
          status: "Active" as CampaignRow["status"],
          current, previous: zeroMetrics(), delta: safeDelta(current, zeroMetrics()),
        };
      });
    }

    function extractCreats(raw: unknown): TopCreative[] {
      if (!raw || typeof raw !== "object") return [];
      const r = raw as Record<string, unknown>;
      const list = (Array.isArray(r.data) ? r.data : Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
      return list.slice(0, 6).map((cr, i) => {
        const conversions = toNum(cr.conversions) || actionsValue(cr, "purchase", "offsite_conversion.fb_pixel_purchase", "lead");
        const revenue = actionValuesValue(cr, "purchase", "offsite_conversion.fb_pixel_purchase");
        const spend = toNum(cr.spend);
        const creative = cr.creative as Record<string, unknown> | undefined;
        const thumbnailUrl = creative?.thumbnail_url ? String(creative.thumbnail_url)
          : creative?.image_url ? String(creative.image_url)
          : (cr.thumbnail_url ? String(cr.thumbnail_url) : undefined);
        return {
          id: String(cr.ad_id ?? cr.id ?? `tc-${i}`),
          name: String(cr.ad_name ?? cr.name ?? `Creative ${i + 1}`),
          format: "Image" as TopCreative["format"],
          spend, roas: revenue > 0 && spend > 0 ? revenue / spend : 0,
          ctr: toNum(cr.ctr), cpa: conversions > 0 && spend > 0 ? spend / conversions : 0,
          impressions: toNum(cr.impressions), thumbnailUrl,
        };
      });
    }

    const overviewData = overviewRaw.status === "fulfilled" ? overviewRaw.value : null;
    const prevOverviewData = prevOverviewRaw.status === "fulfilled" ? prevOverviewRaw.value : null;
    if (!overviewData) return null;

    console.log("[deck/generate] direct Meta API ok, overview:", JSON.stringify(overviewData).slice(0, 300));
    return {
      overview: extractOverview(overviewData),
      prevOverview: extractOverview(prevOverviewData),
      campaigns: extractCamps(campaignsRaw.status === "fulfilled" ? campaignsRaw.value : null),
      topCreatives: extractCreats(creativesRaw.status === "fulfilled" ? creativesRaw.value : null),
    };
  } catch (e) {
    console.error("[deck/generate] fetchMetaDataDirect error:", e);
    return null;
  }
}

// ── Google Ads data fetcher ───────────────────────────────────────────────────

async function fetchGoogleData(
  customerId: string,
  period: DeckPeriod,
  previousPeriod: DeckPeriod
): Promise<{ overview: PlatformMetrics; campaigns: CampaignRow[]; prevOverview: PlatformMetrics } | null> {
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

    console.log("[deck/generate] google campaigns:", campaignsRaw.status);

    function extractGoogleCampaigns(raw: unknown): { campaigns: CampaignRow[]; overview: PlatformMetrics } {
      if (!raw || typeof raw !== "object") return { campaigns: [], overview: zeroMetrics() };
      const r = raw as Record<string, unknown>;
      const list = (Array.isArray(r.data) ? r.data : Array.isArray(r.campaigns) ? r.campaigns : Array.isArray(raw) ? raw : []) as RawCampaign[];
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
          id: String(c.id ?? c.campaign_id ?? `google-c-${i}`),
          name: String(c.name ?? c.campaign_name ?? `Campaign ${i + 1}`),
          type: c.type ? String(c.type) : undefined,
          status: (["Active", "Paused", "Completed"].includes(String(c.status ?? "ENABLED")) ? String(c.status) : "Active") as CampaignRow["status"],
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
    console.error("[deck/generate] fetchGoogleData error:", e);
    return null;
  }
}

// ── Anthropic slide generation ────────────────────────────────────────────────

interface GenerateConfig {
  customerId: string;
  platform: string;
  metaAccountId?: string;
  googleCustomerId?: string;
  dateRange: { startDate: string; endDate: string; label?: string };
  sections: string[];
  context?: string;
  budgets?: Record<string, number>;
}

async function generateSlidePlan(
  config: GenerateConfig,
  meta: { overview: PlatformMetrics; campaigns: CampaignRow[]; topCreatives: TopCreative[]; prevOverview: PlatformMetrics } | null,
  google: { overview: PlatformMetrics; campaigns: CampaignRow[]; prevOverview: PlatformMetrics } | null,
  previousDeckMetrics?: Record<string, unknown> | null,
): Promise<Slide[]> {
  const fmt = (n: number) => `€${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtPct = (n: number) => `${n.toFixed(2)}%`;
  const fmtX = (n: number) => `${n.toFixed(2)}x`;
  const delta = (curr: number, prev: number) => prev > 0 ? `${curr >= prev ? "+" : ""}${(((curr - prev) / prev) * 100).toFixed(1)}%` : "N/A";

  // Build a compact data summary for the prompt
  let dataSummary = "";

  if (meta) {
    const m = meta.overview;
    const pm = meta.prevOverview;
    dataSummary += `
META ADS (${config.dateRange.label ?? `${config.dateRange.startDate} to ${config.dateRange.endDate}`}):
  Spend: ${fmt(m.spend)} (prev: ${fmt(pm.spend)}, Δ: ${delta(m.spend, pm.spend)})
  Impressions: ${Math.round(m.impressions).toLocaleString()} (prev: ${Math.round(pm.impressions).toLocaleString()})
  Clicks: ${Math.round(m.clicks).toLocaleString()} | CTR: ${fmtPct(m.ctr)}
  Conversions: ${Math.round(m.conversions)} (prev: ${Math.round(pm.conversions)}, Δ: ${delta(m.conversions, pm.conversions)})
  Revenue: ${fmt(m.revenue)} | ROAS: ${fmtX(m.roas)} (prev: ${fmtX(pm.roas)})
  CPA: ${fmt(m.cpa)} | CPM: ${fmt(m.cpm)}

TOP META CAMPAIGNS:
${meta.campaigns.slice(0, 5).map(c =>
  `  - ${c.name} | Spend: ${fmt(c.current.spend)} | ROAS: ${fmtX(c.current.roas)} | CPA: ${fmt(c.current.cpa)} | CTR: ${fmtPct(c.current.ctr)} | Status: ${c.status}`
).join("\n")}

TOP META CREATIVES:
${meta.topCreatives.slice(0, 5).map(cr =>
  `  - ${cr.name} (${cr.format}) | Spend: ${fmt(cr.spend)} | ROAS: ${fmtX(cr.roas)} | CTR: ${fmtPct(cr.ctr)} | CPA: ${fmt(cr.cpa)}${cr.thumbnailUrl ? ` | thumbnail: ${cr.thumbnailUrl}` : ""}`
).join("\n")}`;
  } else {
    dataSummary += "\nMETA ADS: No data available.";
  }

  if (google) {
    const g = google.overview;
    const pg = google.prevOverview;
    dataSummary += `

GOOGLE ADS (${config.dateRange.label ?? `${config.dateRange.startDate} to ${config.dateRange.endDate}`}):
  Spend: ${fmt(g.spend)} (prev: ${fmt(pg.spend)}, Δ: ${delta(g.spend, pg.spend)})
  Impressions: ${Math.round(g.impressions).toLocaleString()} (prev: ${Math.round(pg.impressions).toLocaleString()})
  Clicks: ${Math.round(g.clicks).toLocaleString()} | CTR: ${fmtPct(g.ctr)}
  Conversions: ${Math.round(g.conversions)} (prev: ${Math.round(pg.conversions)}, Δ: ${delta(g.conversions, pg.conversions)})
  Revenue: ${fmt(g.revenue)} | ROAS: ${fmtX(g.roas)} (prev: ${fmtX(pg.roas)})
  CPA: ${fmt(g.cpa)} | CPM: ${fmt(g.cpm)}

TOP GOOGLE CAMPAIGNS:
${google.campaigns.slice(0, 5).map(c =>
  `  - ${c.name} | Spend: ${fmt(c.current.spend)} | ROAS: ${fmtX(c.current.roas)} | CPA: ${fmt(c.current.cpa)} | CTR: ${fmtPct(c.current.ctr)} | Status: ${c.status}`
).join("\n")}`;
  } else {
    dataSummary += "\nGOOGLE ADS: No data available.";
  }

  if (config.budgets && Object.keys(config.budgets).length > 0) {
    dataSummary += `\n\nBUDGETS:\n${Object.entries(config.budgets).map(([k, v]) => `  ${k}: ${fmt(v)}`).join("\n")}`;
  }

  const sectionsInstruction = config.sections.length > 0
    ? `Required slide sections (in order): ${config.sections.join(", ")}.`
    : "Generate a complete deck covering: overview, performance, creative, alerts, and recommendations.";

  const contextBlock = config.context
    ? `\nAdditional analyst context: ${config.context}`
    : "";

  // ── Pre-analysis: detect alerts ───────────────────────────────────────────
  const alerts: string[] = [];

  if (meta) {
    const m = meta.overview;
    const pm = meta.prevOverview;
    if (m.roas > 0 && m.roas < 1) alerts.push(`ROAS Meta: ${fmtX(m.roas)} — SOUS 1x, chaque € dépensé génère moins de 1€ de revenue`);
    if (pm.cpa > 0 && m.cpa > pm.cpa * 1.3) alerts.push(`CPA Meta: ${fmt(m.cpa)} vs ${fmt(pm.cpa)} période préc. — hausse de ${delta(m.cpa, pm.cpa)}`);
    if (m.ctr > 0 && m.ctr < 0.5) alerts.push(`CTR Meta: ${fmtPct(m.ctr)} — Fatigue créative détectée (seuil: 0.5%)`);
    if (pm.spend > 0 && Math.abs(m.spend - pm.spend) / pm.spend > 0.3) alerts.push(`Budget Meta: ${fmt(m.spend)} vs ${fmt(pm.spend)} — variation de ${delta(m.spend, pm.spend)}`);
    if (pm.conversions > 0 && m.conversions < pm.conversions * 0.8) alerts.push(`Conversions Meta: ${Math.round(m.conversions)} vs ${Math.round(pm.conversions)} — chute de ${delta(m.conversions, pm.conversions)}`);
  }

  if (google) {
    const g = google.overview;
    const pg = google.prevOverview;
    if (g.roas > 0 && g.roas < 1) alerts.push(`ROAS Google: ${fmtX(g.roas)} — SOUS 1x`);
    if (pg.cpa > 0 && g.cpa > pg.cpa * 1.3) alerts.push(`CPA Google: ${fmt(g.cpa)} vs ${fmt(pg.cpa)} — hausse de ${delta(g.cpa, pg.cpa)}`);
    if (g.ctr > 0 && g.ctr < 0.5) alerts.push(`CTR Google: ${fmtPct(g.ctr)} — CTR bas (seuil: 0.5%)`);
    if (pg.spend > 0 && Math.abs(g.spend - pg.spend) / pg.spend > 0.3) alerts.push(`Budget Google: ${fmt(g.spend)} vs ${fmt(pg.spend)} — variation de ${delta(g.spend, pg.spend)}`);
  }

  const alertsBlock = alerts.length > 0
    ? `\n\nSIGNAUX CRITIQUES DÉTECTÉS (génère des slides "alert" pour ces points en priorité):\n${alerts.map(a => `- ${a}`).join("\n")}`
    : "";

  // Build a previous-deck comparison block if we have historical data from our deck storage
  let previousDeckBlock = "";
  if (previousDeckMetrics && typeof previousDeckMetrics === "object") {
    const pm = previousDeckMetrics as Record<string, unknown>;
    const lines: string[] = [];
    if (pm.period) lines.push(`  Period: ${pm.period}`);
    if (pm.meta && typeof pm.meta === "object") {
      const m = pm.meta as Record<string, unknown>;
      lines.push("  META (previous deck):");
      if (m.spend !== undefined) lines.push(`    Spend: ${fmt(Number(m.spend))}`);
      if (m.roas !== undefined) lines.push(`    ROAS: ${fmtX(Number(m.roas))}`);
      if (m.cpa !== undefined) lines.push(`    CPA: ${fmt(Number(m.cpa))}`);
      if (m.conversions !== undefined) lines.push(`    Conversions: ${Math.round(Number(m.conversions))}`);
      if (m.ctr !== undefined) lines.push(`    CTR: ${fmtPct(Number(m.ctr))}`);
    }
    if (pm.google && typeof pm.google === "object") {
      const g = pm.google as Record<string, unknown>;
      lines.push("  GOOGLE (previous deck):");
      if (g.spend !== undefined) lines.push(`    Spend: ${fmt(Number(g.spend))}`);
      if (g.roas !== undefined) lines.push(`    ROAS: ${fmtX(Number(g.roas))}`);
      if (g.cpa !== undefined) lines.push(`    CPA: ${fmt(Number(g.cpa))}`);
      if (g.conversions !== undefined) lines.push(`    Conversions: ${Math.round(Number(g.conversions))}`);
      if (g.ctr !== undefined) lines.push(`    CTR: ${fmtPct(Number(g.ctr))}`);
    }
    if (lines.length > 0) {
      previousDeckBlock = `\n\nPREVIOUS DECK METRICS (for M-1 comparisons — use these to highlight deltas vs current period):\n${lines.join("\n")}`;
    }
  }
  const systemPrompt = `You are a media buying analyst. Your job is to generate structured slide deck plans for digital advertising performance reviews. You always respond with valid JSON only — no markdown, no explanation, no text outside the JSON array.`;

  const userPrompt = `Based on the real advertising data below, generate a JSON array of slides for a performance deck.

ACCOUNT: ${config.customerId}
PLATFORM: ${config.platform}
PERIOD: ${config.dateRange.label ?? `${config.dateRange.startDate} to ${config.dateRange.endDate}`}
${sectionsInstruction}${contextBlock}${alertsBlock}

REAL DATA:
${dataSummary}${previousDeckBlock}

Return a JSON array where each element has this exact shape (all fields optional except id, type, title):
{
  "id": "slide-1",
  "type": "overview" | "performance" | "creative" | "funnel" | "alert" | "recommendation" | "comparison",
  "title": "Slide title",
  "subtitle": "Optional subtitle",
  "kpis": [{ "label": "ROAS", "value": "3.42x", "delta": "+12%", "trend": "up" | "down" | "flat" }],
  "insights": ["Key insight 1", "Key insight 2"],
  "chart": { "type": "bar" | "line" | "pie" | "funnel", "data": {} },
  "images": [{ "url": "https://...", "label": "Creative name", "metrics": "ROAS 3.4x · CPA €12" }],
  "recommendation": "Action to take",
  "severity": "ok" | "warning" | "alert"
}

Rules:
- Use ONLY the real numbers from the data provided above. Never invent data.
- Generate between 4 and 8 slides.
- Each slide must have at least a title and either kpis or insights.
- Format money as €X,XXX.XX, percentages as X.XX%, ROAS as X.XXx.
- Severity "alert" = something urgently needs attention, "warning" = watch this, "ok" = performing well.
- For "comparison" slides, include period-over-period delta in kpis.
- If PREVIOUS DECK METRICS are provided, add explicit M-1 comparisons in kpi deltas (e.g. "ROAS 2.3x vs 1.8x M-1 (+28%)") and include at least one "comparison" type slide.
- For "creative" type slides: you MUST include an "images" array. Use the thumbnail URLs from the TOP CREATIVES data above (the "thumbnail:" field). Each image entry must have "url" set to the thumbnail URL, "label" set to the creative name, and "metrics" set to a summary string like "ROAS 3.4x · CPA €12 · CTR 1.2%". Always include at least the top 3 creatives with their real thumbnail URLs.
- Return ONLY the JSON array. No markdown. No explanation.`;

  // Route through the relay (which has Claude access) instead of calling Anthropic SDK directly.
  // This avoids needing ANTHROPIC_API_KEY in Vercel environment variables.
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
  const rawText = await relayChat(fullPrompt, 90000);

  console.log(`[deck/generate] Relay response (500):`, rawText.slice(0, 500));

  const parsed = extractJson<Slide[]>(rawText);
  if (!parsed || !Array.isArray(parsed)) {
    console.error("[deck/generate] Failed to parse relay slide JSON. Raw:", rawText.slice(0, 2000));
    return [];
  }

  // Validate and normalise each slide
  const validTypes = ["overview", "performance", "creative", "funnel", "alert", "recommendation", "comparison"] as const;
  return parsed
    .filter((s): s is Slide => !!s && typeof s.title === "string")
    .map((s, i) => ({
      ...s,
      id: s.id ?? `slide-${i + 1}`,
      type: validTypes.includes(s.type) ? s.type : "overview",
    }));
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let config: GenerateConfig;
  try {
    const body = await req.json();
    // Support both the new config shape and the legacy client/period shape
    if (body.customerId) {
      // Extract real account IDs: prefer explicit fields, fall back to parsing customerId prefix
      const rawId = body.customerId as string;
      const metaId = body.metaAccountId ?? (rawId.startsWith("meta-") ? rawId.slice(5) : undefined);
      const googleId = body.googleCustomerId ?? (rawId.startsWith("google-") ? rawId.slice(7) : undefined);
      config = {
        customerId: rawId,
        platform: body.platform ?? "both",
        metaAccountId: metaId,
        googleCustomerId: googleId,
        dateRange: body.dateRange ?? { startDate: body.period?.startDate ?? "", endDate: body.period?.endDate ?? "", label: body.period?.label },
        sections: Array.isArray(body.sections) ? body.sections : [],
        context: typeof body.context === "string" ? body.context : undefined,
        budgets: typeof body.budgets === "object" && body.budgets !== null ? body.budgets : undefined,
      };
    } else if (body.client && body.period) {
      // Legacy shape: { client: { metaAccountId, googleCustomerId, name }, period }
      const c = body.client;
      config = {
        customerId: c.metaAccountId ?? c.googleCustomerId ?? c.id ?? "unknown",
        platform: c.metaAccountId && c.googleCustomerId ? "both" : c.metaAccountId ? "meta" : "google",
        metaAccountId: c.metaAccountId,
        googleCustomerId: c.googleCustomerId,
        dateRange: { startDate: body.period.startDate, endDate: body.period.endDate, label: body.period.label },
        sections: [],
        context: typeof body.userPrompt === "string" ? body.userPrompt : undefined,
      };
    } else {
      throw new Error("Missing required fields: customerId (or client + period)");
    }

    if (!config.dateRange.startDate || !config.dateRange.endDate) {
      throw new Error("Missing dateRange.startDate or dateRange.endDate");
    }
  } catch (e) {
    return NextResponse.json({ error: `Invalid request body: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
  }

  // Derive "month" field (YYYY-MM) from the start date for DeckPeriod compatibility
  const monthStr = config.dateRange.startDate.slice(0, 7); // e.g. "2026-02"
  const period: DeckPeriod = {
    month: monthStr,
    startDate: config.dateRange.startDate,
    endDate: config.dateRange.endDate,
    label: config.dateRange.label ?? `${config.dateRange.startDate} – ${config.dateRange.endDate}`,
  };
  const previousPeriod = getPreviousPeriod(period);

  // Determine which platforms to fetch and resolve actual account IDs
  const metaAccId = config.metaAccountId ?? (config.customerId.startsWith("meta-") ? config.customerId.slice(5) : config.customerId);
  const googleAccId = config.googleCustomerId ?? (config.customerId.startsWith("google-") ? config.customerId.slice(7) : config.customerId);
  const fetchMeta = (config.platform === "meta" || config.platform === "both") && !!metaAccId;
  const fetchGoogle = (config.platform === "google" || config.platform === "both") && !!googleAccId;

  // Get session for Meta token (direct API is faster and more reliable than relay)
  const session = await auth();
  const metaToken = (session as { metaAccessToken?: string | null } | null)?.metaAccessToken ?? null;

  console.log("[deck/generate] resolved IDs:", { metaAccId, googleAccId, fetchMeta, fetchGoogle, hasMetaToken: !!metaToken });

  // Fetch raw data in parallel — use direct Meta Graph API when token is available, relay MCP otherwise
  const [metaResult, googleResult] = await Promise.allSettled([
    fetchMeta
      ? (metaToken
          ? fetchMetaDataDirect(metaAccId, period, previousPeriod, metaToken)
              .then(r => r ?? fetchMetaData(metaAccId, period, previousPeriod)) // fallback to relay
          : fetchMetaData(metaAccId, period, previousPeriod))
      : Promise.resolve(null),
    fetchGoogle
      ? fetchGoogleData(googleAccId, period, previousPeriod)
      : Promise.resolve(null),
  ]);

  const meta = metaResult.status === "fulfilled" ? metaResult.value : null;
  const google = googleResult.status === "fulfilled" ? googleResult.value : null;

  const metaError = metaResult.status === "rejected" ? String(metaResult.reason) : null;
  const googleError = googleResult.status === "rejected" ? String(googleResult.reason) : null;

  console.log("[deck/generate] relay results:", {
    relayUrls: RELAY_URLS_TO_TRY,
    customerId: config.customerId,
    platform: config.platform,
    metaOk: !!meta,
    googleOk: !!google,
    metaError,
    googleError,
  });

  const hasRealData = !!(meta || google);
  const dataSource = hasRealData
    ? (meta && google) || (!fetchMeta && google) || (!fetchGoogle && meta) ? "real" : "partial"
    : "mock";

  // Fetch previous deck from history for M-1 comparisons
  let previousDeckMetrics: Record<string, unknown> | null = null;
  try {
    const history = await getDeckHistory(config.customerId, 1);
    if (history.length > 0) {
      previousDeckMetrics = history[0].metrics;
      console.log("[deck/generate] found previous deck for M-1 comparison, period:", history[0].period);
    }
  } catch (err) {
    console.warn("[deck/generate] could not fetch deck history:", err);
  }

  // Generate slide plan via Anthropic API
  let slides: Slide[] = [];
  let generateError: string | null = null;
  try {
    slides = await generateSlidePlan(config, meta, google, previousDeckMetrics);
  } catch (err) {
    generateError = err instanceof Error ? err.message : String(err);
    console.error("[deck/generate] generateSlidePlan failed:", generateError);
  }

  // Save this deck to history (fire-and-forget, do not block response)
  if (slides.length > 0) {
    const metricsSnapshot: Record<string, unknown> = {
      period: period.label,
      startDate: period.startDate,
      endDate: period.endDate,
    };
    if (meta) metricsSnapshot.meta = meta.overview;
    if (google) metricsSnapshot.google = google.overview;

    saveDeckHistory({
      id: `${config.customerId}-${period.startDate}-${Date.now().toString(36)}`,
      clientId: config.customerId,
      clientName: config.customerId, // will be enriched client-side if needed
      platform: config.platform,
      period: period.label,
      startDate: period.startDate,
      endDate: period.endDate,
      slides,
      metrics: metricsSnapshot,
      createdAt: new Date().toISOString(),
    }).catch(err => console.warn("[deck/generate] failed to save deck history:", err));
  }

  return NextResponse.json({
    slides,
    dataSource,
    ...(generateError ? { generateError } : {}),
    ...(metaError ? { metaError } : {}),
    ...(googleError ? { googleError } : {}),
  });
}
