/**
 * POST /api/deck/data
 * Fetches real Meta Ads + Google Ads data for a client/period via the relay proxy MCP.
 * Falls back to mock data if relay is unavailable.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { assertAccountAllowed } from "@/lib/acl";
import { getMetaSystemToken } from "@/lib/meta-api";
import { relayHeaders } from "@/lib/relay-headers";
import {
  generateMockDeckData,
  getPreviousPeriod,
  type DeckClient,
  type DeckPeriod,
  type DeckData,
  type PlatformMetrics,
  type CampaignRow,
  type TopCreative,
  type GAOverview,
  type GATopPage,
  type GADeviceRow,
  type GASourceRow,
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
        headers: relayHeaders(),
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          allowedServers: ["meta-ads-impulse", "mcp-google-ads", "mcp-google-analytics"],
        }),
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

/** Direct /api/tool call — bypasses AI, much faster (~1-2s) for Google Ads MCP tools */
async function relayDirectTool(tool: string, input: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
  let lastError: Error | null = null;
  for (const url of RELAY_URLS_TO_TRY) {
    const isLocalhost = url.includes("localhost");
    const actualTimeout = isLocalhost ? Math.min(timeoutMs, 2000) : timeoutMs;
    try {
      const res = await fetch(`${url}/api/tool`, {
        method: "POST",
        headers: relayHeaders(),
        body: JSON.stringify({ tool, input }),
        signal: AbortSignal.timeout(actualTimeout),
      });
      if (!res.ok) { lastError = new Error(`Relay ${url} /api/tool ${res.status}`); continue; }
      const json = await res.json() as { result?: unknown; error?: string };
      if (json.error) { lastError = new Error(json.error); continue; }
      return json.result;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error("All relay URLs failed for /api/tool");
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
    // Note: creative{} is NOT supported on /insights endpoint — must use /ads endpoint separately
    const adInsightFields = "ad_id,ad_name,adset_name,campaign_name,impressions,clicks,spend,ctr,cpc,cpm,actions,action_values";

    // Fire 4 parallel direct Graph API calls
    const [overviewRaw, prevOverviewRaw, campaignsRaw, creativesRaw] = await Promise.allSettled([
      metaFetch(`${BASE}/${actId}/insights?fields=${overviewFields}&time_range=${timeRange(period)}&level=account&access_token=${tok}`),
      metaFetch(`${BASE}/${actId}/insights?fields=${overviewFields}&time_range=${timeRange(previousPeriod)}&level=account&access_token=${tok}`),
      metaFetch(`${BASE}/${actId}/insights?level=campaign&fields=${campaignFields}&time_range=${timeRange(period)}&access_token=${tok}`),
      metaFetch(`${BASE}/${actId}/insights?level=ad&fields=${adInsightFields}&time_range=${timeRange(period)}&sort=spend_descending&limit=10&access_token=${tok}`),
    ]);

    // Fetch creative thumbnails for the top ads (separate API call since /insights doesn't support creative{})
    let adCreativeMap: Record<string, { thumbnail_url?: string; image_url?: string }> = {};
    if (creativesRaw.status === "fulfilled") {
      try {
        const creativesData = creativesRaw.value as Record<string, unknown>;
        const adIds = (Array.isArray(creativesData.data) ? creativesData.data : [])
          .map((ad: Record<string, unknown>) => String(ad.ad_id ?? ad.id ?? ""))
          .filter(Boolean)
          .slice(0, 10);
        if (adIds.length > 0) {
          // Batch fetch creative data + image_hash + video_id for all top ads.
          // video_id (direct + nested in object_story_spec.video_data) lets us
          // resolve HD frames via /{video_id}?fields=thumbnails, which is how
          // Motion gets crisp thumbs for video creatives.
          const creativeFields =
            "creative%7B" +
            "thumbnail_url,image_url,image_hash,video_id," +
            "asset_feed_spec,object_story_spec%7Bvideo_data%7Bvideo_id,image_url%7D%7D" +
            "%7D";
          const creativeResults = await Promise.allSettled(
            adIds.map((adId: string) =>
              metaFetch(`${BASE}/${adId}?fields=${creativeFields}&access_token=${tok}`)
            )
          );
          // Collect image hashes and video IDs for high-res resolution
          const imageHashes: string[] = [];
          const adVideoIds: Record<string, string> = {};
          creativeResults.forEach((r, i) => {
            if (r.status === "fulfilled") {
              const data = r.value as Record<string, unknown>;
              const creative = data.creative as Record<string, unknown> | undefined;
              if (creative) {
                const hash = creative.image_hash as string | undefined;
                // Also try to get hash from asset_feed_spec.images[0].hash
                const assetFeed = creative.asset_feed_spec as Record<string, unknown> | undefined;
                const feedImages = assetFeed?.images as Array<{ hash?: string }> | undefined;
                const feedHash = feedImages?.[0]?.hash;
                const resolvedHash = hash || feedHash;
                // Extract video_id from direct field or nested object_story_spec
                const directVideoId = creative.video_id ? String(creative.video_id) : undefined;
                const storySpec = creative.object_story_spec as Record<string, unknown> | undefined;
                const videoData = storySpec?.video_data as Record<string, unknown> | undefined;
                const nestedVideoId = videoData?.video_id ? String(videoData.video_id) : undefined;
                const videoId = directVideoId || nestedVideoId;
                adCreativeMap[adIds[i]] = {
                  thumbnail_url: creative.thumbnail_url ? String(creative.thumbnail_url) : undefined,
                  image_url: creative.image_url ? String(creative.image_url) : undefined,
                };
                if (resolvedHash) imageHashes.push(resolvedHash);
                if (videoId) adVideoIds[adIds[i]] = videoId;
              }
            }
          });

          // Resolve video IDs to HD thumbnail URLs via /{video_id}/thumbnails.
          // Meta returns an array of thumbnails at various sizes — pick the
          // largest (or is_preferred if no size info).
          const uniqueVideoIds = [...new Set(Object.values(adVideoIds))];
          if (uniqueVideoIds.length > 0) {
            try {
              const videoResults = await Promise.allSettled(
                uniqueVideoIds.map((vid) =>
                  metaFetch(`${BASE}/${vid}/thumbnails?access_token=${tok}`)
                )
              );
              const videoIdToUrl: Record<string, string> = {};
              videoResults.forEach((vr, i) => {
                if (vr.status === "fulfilled") {
                  const vdata = vr.value as Record<string, unknown>;
                  const thumbs = Array.isArray(vdata.data) ? vdata.data as Array<Record<string, unknown>> : [];
                  if (thumbs.length === 0) return;
                  // Prefer the largest by width*height; fall back to is_preferred
                  let best = thumbs[0];
                  let bestScore = (Number(best.width) || 0) * (Number(best.height) || 0);
                  for (const t of thumbs) {
                    const score = (Number(t.width) || 0) * (Number(t.height) || 0);
                    if (score > bestScore || (bestScore === 0 && t.is_preferred)) {
                      best = t;
                      bestScore = score;
                    }
                  }
                  if (best.uri) videoIdToUrl[uniqueVideoIds[i]] = String(best.uri);
                }
              });
              // Apply HD video thumb to the ad creative map
              for (const [adId, videoId] of Object.entries(adVideoIds)) {
                const hdUrl = videoIdToUrl[videoId];
                if (hdUrl) {
                  adCreativeMap[adId] = {
                    ...adCreativeMap[adId],
                    image_url: hdUrl, // Promote HD video thumb to image_url
                  };
                }
              }
              console.log(`[deck/data] resolved ${Object.keys(videoIdToUrl).length}/${uniqueVideoIds.length} video HD thumbnails`);
            } catch (e) {
              console.warn("[deck/data] video thumbnails resolution failed (non-blocking):", e);
            }
          }

          // Resolve image hashes to full-size URLs via adimages endpoint
          if (imageHashes.length > 0) {
            try {
              const hashesParam = encodeURIComponent(JSON.stringify([...new Set(imageHashes)]));
              const adImagesRes = await metaFetch(`${BASE}/${actId}/adimages?hashes=${hashesParam}&fields=url,url_128&access_token=${tok}`);
              const adImagesData = adImagesRes as Record<string, unknown>;
              const adImagesList = Array.isArray(adImagesData.data) ? adImagesData.data as Array<Record<string, unknown>> : [];
              const hashToUrl: Record<string, string> = {};
              adImagesList.forEach((img) => {
                const id = String(img.id ?? "");
                const hash = id.split(":")[1] || "";
                if (hash && img.url) hashToUrl[hash] = String(img.url);
              });
              // Update adCreativeMap with high-res URLs
              creativeResults.forEach((r, i) => {
                if (r.status === "fulfilled") {
                  const data = r.value as Record<string, unknown>;
                  const creative = data.creative as Record<string, unknown> | undefined;
                  if (creative) {
                    const hash = (creative.image_hash as string) ||
                      ((creative.asset_feed_spec as Record<string, unknown>)?.images as Array<{ hash?: string }>)?.[0]?.hash;
                    if (hash && hashToUrl[hash]) {
                      adCreativeMap[adIds[i]] = {
                        ...adCreativeMap[adIds[i]],
                        image_url: hashToUrl[hash], // Full-size URL from adimages
                      };
                    }
                  }
                }
              });
              console.log(`[deck/data] resolved ${Object.keys(hashToUrl).length} image hashes to full-res URLs`);
            } catch (e) {
              console.warn("[deck/data] adimages hash resolution failed (non-blocking):", e);
            }
          }
          console.log(`[deck/data] fetched creatives for ${Object.keys(adCreativeMap).length}/${adIds.length} ads`);
        }
      } catch (e) {
        console.warn("[deck/data] creative fetch failed (non-blocking):", e);
      }
    }

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

    function extractCreatives(raw: unknown, creativeMap: Record<string, { thumbnail_url?: string; image_url?: string }>): TopCreative[] {
      if (!raw || typeof raw !== "object") return [];
      const r = raw as Record<string, unknown>;
      const list = (Array.isArray(r.data) ? r.data : Array.isArray(r.ads) ? r.ads : Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
      return list.slice(0, 6).map((cr, i) => {
        const conversions = toNum(cr.conversions ?? cr.purchases)
          || actionsValue(cr, "purchase", "offsite_conversion.fb_pixel_purchase", "lead", "offsite_conversion.fb_pixel_lead");
        const revenue = actionValuesValue(cr, "purchase", "offsite_conversion.fb_pixel_purchase");
        const spend = toNum(cr.spend);
        const adId = String(cr.id ?? cr.ad_id ?? "");
        // Look up creative thumbnail from the separate /ads API call
        const creativeData = adId ? creativeMap[adId] : undefined;
        return {
          id: adId || `tc-${i}`,
          name: String(cr.name ?? cr.ad_name ?? `Creative ${i + 1}`),
          format: (["Video", "Image", "Carousel"].includes(String(cr.format ?? cr.creative_type ?? "")) ? String(cr.format ?? cr.creative_type) : "Image") as TopCreative["format"],
          spend,
          roas: revenue > 0 && spend > 0 ? revenue / spend : toNum(cr.roas ?? cr.purchase_roas),
          ctr: toNum(cr.ctr),
          cpa: conversions > 0 && spend > 0 ? spend / conversions : toNum(cr.cpa ?? cr.cost_per_purchase),
          impressions: toNum(cr.impressions),
          hookRate: cr.hook_rate !== undefined ? toNum(cr.hook_rate) : undefined,
          thumbnailUrl: (() => {
            // 1. From separate /ads API creative fetch — prefer full-res image_url over 64px thumbnail
            if (creativeData?.image_url) return creativeData.image_url;
            if (creativeData?.thumbnail_url) return creativeData.thumbnail_url;
            // 2. Fallback: direct fields or nested creative (from relay/MCP responses)
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
    const topCreatives = extractCreatives(creativesData, adCreativeMap);

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
  // Google Ads tools require customer_id without dashes
  const cleanId = customerId.replace(/-/g, "");
  try {
    const inputFn = (p: DeckPeriod) => JSON.stringify({
      customer_id: cleanId, start_date: p.startDate, end_date: p.endDate,
    });
    const [campaignsRaw, prevCampaignsRaw] = await Promise.allSettled([
      relayDirectTool("mcp-google-ads.Campaign_Performance", { input: inputFn(period) }, 15000),
      relayDirectTool("mcp-google-ads.Campaign_Performance", { input: inputFn(previousPeriod) }, 15000),
    ]);

    console.log("[deck/data] google campaigns:", campaignsRaw.status);

    function extractGoogleCampaigns(raw: unknown): { campaigns: CampaignRow[]; overview: PlatformMetrics } {
      if (!raw) return { campaigns: [], overview: zeroMetrics() };

      // Structure: [{results: [{campaign: {...}, metrics: {...}}]}]  (from /api/tool)
      // or flat array of campaign objects
      let rows: Array<{ campaign?: Record<string, unknown>; metrics?: Record<string, unknown> }> = [];
      if (Array.isArray(raw)) {
        const first = (raw as unknown[])[0];
        if (first && typeof first === "object" && Array.isArray((first as Record<string, unknown>).results)) {
          rows = ((first as Record<string, unknown>).results as typeof rows);
        } else {
          // Flat array of campaign objects
          rows = (raw as typeof rows);
        }
      } else if (typeof raw === "object") {
        const r = raw as Record<string, unknown>;
        const arr = r.results || r.data || r.campaigns;
        if (Array.isArray(arr)) rows = arr as typeof rows;
      }

      let totalSpend = 0, totalImpressions = 0, totalClicks = 0, totalConversions = 0, totalRevenue = 0;
      const campaigns = rows.slice(0, 10).map((row, i) => {
        const c = row.campaign ?? row as Record<string, unknown>;
        const m = row.metrics ?? row as Record<string, unknown>;

        // Google Ads costs in micros — divide by 1,000,000
        const costRaw = toNum(m.costMicros ?? m.cost_micros ?? m.cost ?? 0);
        const spend = costRaw > 10000 ? costRaw / 1_000_000 : costRaw;
        const impressions = toNum(m.impressions ?? 0);
        const clicks = toNum(m.clicks ?? 0);
        const conversions = toNum(m.conversions ?? m.allConversions ?? 0);
        const revenue = toNum(m.conversionsValue ?? m.conversions_value ?? m.revenue ?? 0);

        totalSpend += spend; totalImpressions += impressions; totalClicks += clicks;
        totalConversions += conversions; totalRevenue += revenue;

        const current = safeMetrics({ spend, impressions, clicks, conversions, revenue });
        const rawStatus = String(c.status ?? m.status ?? "ENABLED").toUpperCase();
        const status: CampaignRow["status"] = rawStatus === "PAUSED" ? "Paused" : rawStatus === "REMOVED" ? "Completed" : "Active";

        return {
          id: String(c.id ?? c.campaign_id ?? `google-c-${i}`),
          name: String(c.name ?? c.campaign_name ?? `Campagne ${i + 1}`),
          type: c.advertisingChannelType ? String(c.advertisingChannelType) : undefined,
          status,
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

// ── Google Analytics data ────────────────────────────────────────────────────

function zeroGAOverview(): GAOverview {
  return { sessions: 0, users: 0, newUsers: 0, pageviews: 0, bounceRate: 0, avgSessionDuration: 0, conversions: 0, conversionRate: 0 };
}

async function fetchGAData(
  propertyId: string,
  period: DeckPeriod,
  previousPeriod: DeckPeriod
): Promise<{
  overview: GAOverview;
  prevOverview: GAOverview;
  topPages: GATopPage[];
  devices: GADeviceRow[];
  sources: GASourceRow[];
} | null> {
  try {
    // 1. Overview report — sessions, users, pageviews, bounce rate, conversions
    const overviewInput = (p: DeckPeriod) => ({
      property_id: propertyId,
      start_date: p.startDate,
      end_date: p.endDate,
      dimensions: ["date"],
      metrics: ["sessions", "totalUsers", "newUsers", "screenPageViews", "bounceRate", "averageSessionDuration", "conversions"],
    });

    // 2. Top pages report
    const topPagesInput = {
      property_id: propertyId,
      start_date: period.startDate,
      end_date: period.endDate,
      dimensions: ["pagePath", "pageTitle"],
      metrics: ["sessions", "totalUsers", "bounceRate", "averageSessionDuration", "conversions"],
      limit: 10,
      order_by: [{ metric: "sessions", desc: true }],
    };

    // 3. Device report
    const devicesInput = {
      property_id: propertyId,
      start_date: period.startDate,
      end_date: period.endDate,
      dimensions: ["deviceCategory"],
      metrics: ["sessions", "totalUsers", "conversions", "bounceRate"],
    };

    // 4. Source/medium report
    const sourcesInput = {
      property_id: propertyId,
      start_date: period.startDate,
      end_date: period.endDate,
      dimensions: ["sessionSource", "sessionMedium"],
      metrics: ["sessions", "totalUsers", "conversions", "bounceRate"],
      limit: 10,
      order_by: [{ metric: "sessions", desc: true }],
    };

    const [overviewRaw, prevOverviewRaw, pagesRaw, devicesRaw, sourcesRaw] = await Promise.allSettled([
      relayDirectTool("mcp-google-analytics.run_report", overviewInput(period), 15000),
      relayDirectTool("mcp-google-analytics.run_report", overviewInput(previousPeriod), 15000),
      relayDirectTool("mcp-google-analytics.run_report", topPagesInput, 15000),
      relayDirectTool("mcp-google-analytics.run_report", devicesInput, 15000),
      relayDirectTool("mcp-google-analytics.run_report", sourcesInput, 15000),
    ]);

    console.log("[deck/data] GA results:", {
      overview: overviewRaw.status,
      prevOverview: prevOverviewRaw.status,
      pages: pagesRaw.status,
      devices: devicesRaw.status,
      sources: sourcesRaw.status,
    });

    // Parse overview — GA4 returns rows with dimensionValues + metricValues
    function parseGAOverview(raw: unknown): GAOverview {
      if (!raw) return zeroGAOverview();
      // Structure: { rows: [{dimensionValues: [...], metricValues: [...]}], ...}
      // or could be wrapped in an array
      let rows: Array<{ metricValues?: Array<{ value?: string }> }> = [];
      if (Array.isArray(raw)) {
        const first = raw[0];
        if (first && typeof first === "object" && Array.isArray((first as Record<string, unknown>).rows)) {
          rows = (first as Record<string, unknown>).rows as typeof rows;
        }
      } else if (typeof raw === "object" && raw !== null) {
        const r = raw as Record<string, unknown>;
        if (Array.isArray(r.rows)) rows = r.rows as typeof rows;
      }

      // Aggregate across all date rows
      let sessions = 0, users = 0, newUsers = 0, pageviews = 0, totalBounce = 0, totalDuration = 0, conversions = 0;
      for (const row of rows) {
        const mv = row.metricValues ?? [];
        sessions += toNum(mv[0]?.value);
        users += toNum(mv[1]?.value);
        newUsers += toNum(mv[2]?.value);
        pageviews += toNum(mv[3]?.value);
        totalBounce += toNum(mv[4]?.value) * toNum(mv[0]?.value); // weighted bounce
        totalDuration += toNum(mv[5]?.value) * toNum(mv[0]?.value); // weighted duration
        conversions += toNum(mv[6]?.value);
      }

      return {
        sessions,
        users,
        newUsers,
        pageviews,
        bounceRate: sessions > 0 ? (totalBounce / sessions) * 100 : 0,
        avgSessionDuration: sessions > 0 ? totalDuration / sessions : 0,
        conversions,
        conversionRate: sessions > 0 ? (conversions / sessions) * 100 : 0,
      };
    }

    function parseGATopPages(raw: unknown): GATopPage[] {
      if (!raw) return [];
      let rows: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }> = [];
      if (Array.isArray(raw)) {
        const first = raw[0];
        if (first && typeof first === "object" && Array.isArray((first as Record<string, unknown>).rows)) {
          rows = (first as Record<string, unknown>).rows as typeof rows;
        }
      } else if (typeof raw === "object" && raw !== null) {
        const r = raw as Record<string, unknown>;
        if (Array.isArray(r.rows)) rows = r.rows as typeof rows;
      }

      return rows.slice(0, 10).map(row => {
        const dv = row.dimensionValues ?? [];
        const mv = row.metricValues ?? [];
        return {
          pagePath: dv[0]?.value ?? "/",
          pageTitle: dv[1]?.value ?? "—",
          sessions: toNum(mv[0]?.value),
          users: toNum(mv[1]?.value),
          bounceRate: toNum(mv[2]?.value) * 100,
          avgDuration: toNum(mv[3]?.value),
          conversions: toNum(mv[4]?.value),
        };
      });
    }

    function parseGADevices(raw: unknown): GADeviceRow[] {
      if (!raw) return [];
      let rows: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }> = [];
      if (Array.isArray(raw)) {
        const first = raw[0];
        if (first && typeof first === "object" && Array.isArray((first as Record<string, unknown>).rows)) {
          rows = (first as Record<string, unknown>).rows as typeof rows;
        }
      } else if (typeof raw === "object" && raw !== null) {
        const r = raw as Record<string, unknown>;
        if (Array.isArray(r.rows)) rows = r.rows as typeof rows;
      }

      return rows.map(row => {
        const dv = row.dimensionValues ?? [];
        const mv = row.metricValues ?? [];
        const sessions = toNum(mv[0]?.value);
        const conversions = toNum(mv[2]?.value);
        return {
          device: dv[0]?.value ?? "unknown",
          sessions,
          users: toNum(mv[1]?.value),
          conversions,
          conversionRate: sessions > 0 ? (conversions / sessions) * 100 : 0,
          bounceRate: toNum(mv[3]?.value) * 100,
        };
      });
    }

    function parseGASources(raw: unknown): GASourceRow[] {
      if (!raw) return [];
      let rows: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }> = [];
      if (Array.isArray(raw)) {
        const first = raw[0];
        if (first && typeof first === "object" && Array.isArray((first as Record<string, unknown>).rows)) {
          rows = (first as Record<string, unknown>).rows as typeof rows;
        }
      } else if (typeof raw === "object" && raw !== null) {
        const r = raw as Record<string, unknown>;
        if (Array.isArray(r.rows)) rows = r.rows as typeof rows;
      }

      return rows.slice(0, 10).map(row => {
        const dv = row.dimensionValues ?? [];
        const mv = row.metricValues ?? [];
        return {
          source: dv[0]?.value ?? "(direct)",
          medium: dv[1]?.value ?? "(none)",
          sessions: toNum(mv[0]?.value),
          users: toNum(mv[1]?.value),
          conversions: toNum(mv[2]?.value),
          bounceRate: toNum(mv[3]?.value) * 100,
        };
      });
    }

    const overview = overviewRaw.status === "fulfilled" ? parseGAOverview(overviewRaw.value) : zeroGAOverview();
    const prevOverview = prevOverviewRaw.status === "fulfilled" ? parseGAOverview(prevOverviewRaw.value) : zeroGAOverview();
    const topPages = pagesRaw.status === "fulfilled" ? parseGATopPages(pagesRaw.value) : [];
    const devices = devicesRaw.status === "fulfilled" ? parseGADevices(devicesRaw.value) : [];
    const sources = sourcesRaw.status === "fulfilled" ? parseGASources(sourcesRaw.value) : [];

    // If we got zero sessions from all reports, consider it a failure
    if (overview.sessions === 0 && topPages.length === 0) {
      console.warn("[deck/data] GA returned 0 sessions — likely bad property ID or no data");
      return null;
    }

    return { overview, prevOverview, topPages, devices, sources };
  } catch (e) {
    console.error("[deck/data] fetchGAData error:", e);
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

// Deterministic insight generator — no relay/AI call needed, always correct
function generateInsightsFromData(
  data: {
    googleOverview: PlatformMetrics | null;
    metaOverview: PlatformMetrics | null;
    clientName: string;
    periodLabel: string;
  }
): AiTextContent {
  const fmtC = (n: number) => `${n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} €`;
  const fmtX = (n: number) => `${n.toFixed(2)}x`;
  const fmtPct = (n: number) => `${n.toFixed(2)}%`;
  const pctDelta = (curr: number, prev: number) => prev > 0 ? ((curr - prev) / prev) * 100 : 0;
  const sign = (n: number) => n >= 0 ? "+" : "";

  const m = data.metaOverview;
  const g = data.googleOverview;

  // ── Meta insights ─────────────────────────────────────────────────────────
  const insightsMeta: string[] = [];
  const nextStepsMeta: string[] = [];
  if (m && m.spend > 0) {
    // ROAS assessment
    if (m.roas >= 4) insightsMeta.push(`ROAS Meta excellent à ${fmtX(m.roas)} — pour ${fmtC(m.spend)} dépensés, ${fmtC(m.revenue)} générés.`);
    else if (m.roas >= 2) insightsMeta.push(`ROAS Meta correct à ${fmtX(m.roas)} — marge de progression vers les 4x.`);
    else if (m.roas >= 1) insightsMeta.push(`ROAS Meta insuffisant à ${fmtX(m.roas)} — rentabilité à améliorer en priorité.`);
    else insightsMeta.push(`ROAS Meta négatif à ${fmtX(m.roas)} — les campagnes coûtent plus qu'elles ne rapportent. Action urgente.`);

    // CPA
    insightsMeta.push(`CPA Meta à ${fmtC(m.cpa)} pour ${Math.round(m.conversions)} conversions — ${m.ctr >= 1 ? "CTR sain à " + fmtPct(m.ctr) : "CTR faible à " + fmtPct(m.ctr) + " (fatigue créative probable)"}.`);

    // Spend / volume
    insightsMeta.push(`Budget Meta investi : ${fmtC(m.spend)} pour ${Math.round(m.impressions / 1000)}k impressions et ${Math.round(m.clicks / 1000 * 10) / 10}k clics.`);

    // Next steps Meta
    if (m.roas < 2) nextStepsMeta.push("Revoir le mix créatif Meta — tester des angles UGC et témoignages pour améliorer le ROAS.");
    if (m.ctr < 0.5) nextStepsMeta.push("Rafraîchir les créatives Meta : CTR sous 0,5% signale une fatigue. Rotation recommandée.");
    else nextStepsMeta.push("Maintenir la cadence créative actuelle et tester 2-3 nouvelles variantes par campagne active.");
    nextStepsMeta.push(`Scaler les campagnes avec CPA < ${fmtC(m.cpa * 0.8)} et mettre en pause celles au-dessus de ${fmtC(m.cpa * 1.3)}.`);
    if (m.roas >= 3) nextStepsMeta.push("Augmenter le budget des campagnes top performers de +15-20% pour capitaliser sur le ROAS actuel.");
  }

  // ── Google insights ───────────────────────────────────────────────────────
  const insightsGoogle: string[] = [];
  const nextStepsGoogle: string[] = [];
  if (g && g.spend > 0) {
    if (g.roas >= 4) insightsGoogle.push(`ROAS Google excellent à ${fmtX(g.roas)} — pour ${fmtC(g.spend)} dépensés, ${fmtC(g.revenue)} générés.`);
    else if (g.roas >= 2) insightsGoogle.push(`ROAS Google correct à ${fmtX(g.roas)} — optimisation possible vers les 4x.`);
    else if (g.roas >= 1) insightsGoogle.push(`ROAS Google insuffisant à ${fmtX(g.roas)} — rentabilité à revoir.`);
    else insightsGoogle.push(`ROAS Google négatif à ${fmtX(g.roas)} — campagnes non rentables. Action urgente.`);

    insightsGoogle.push(`CPA Google à ${fmtC(g.cpa)} pour ${Math.round(g.conversions)} conversions — CTR ${g.ctr >= 2 ? "sain" : "faible"} à ${fmtPct(g.ctr)}.`);
    insightsGoogle.push(`Budget Google investi : ${fmtC(g.spend)} pour ${Math.round(g.impressions / 1000)}k impressions et ${Math.round(g.clicks / 1000 * 10) / 10}k clics.`);

    if (g.ctr < 2) nextStepsGoogle.push("Optimiser les annonces avec CTR faible — tester de nouveaux titres et descriptions.");
    nextStepsGoogle.push(`Identifier et ajouter des negative keywords pour réduire le CPA actuel de ${fmtC(g.cpa)}.`);
    if (g.roas >= 3) nextStepsGoogle.push("Augmenter les enchères sur les mots-clés à fort ROAS et réduire sur les non-convertisseurs.");
    else nextStepsGoogle.push("Revoir la stratégie d'enchères — passer en Target CPA ou Target ROAS si volume suffisant.");
  }

  // ── Global learnings ──────────────────────────────────────────────────────
  const learnings: string[] = [];
  const nextStepsGlobal: string[] = [];

  const hasMeta = m !== null && m.spend > 0;
  const hasGoogle = g !== null && g.spend > 0;
  const totalSpend = (m?.spend ?? 0) + (g?.spend ?? 0);
  const totalRevenue = (m?.revenue ?? 0) + (g?.revenue ?? 0);
  const globalRoas = totalSpend > 0 ? totalRevenue / totalSpend : 0;
  const totalConv = Math.round((m?.conversions ?? 0) + (g?.conversions ?? 0));

  if (hasMeta && hasGoogle) {
    learnings.push(`ROAS global ${fmtX(globalRoas)} sur un budget total de ${fmtC(totalSpend)} — ${totalConv} conversions générées toutes plateformes.`);
    const metaPct = Math.round(m!.spend / totalSpend * 100);
    learnings.push(`Répartition budget : Meta ${metaPct}% / Google ${100 - metaPct}% — ${m!.roas > g!.roas ? "Meta plus rentable (ROAS " + fmtX(m!.roas) + " vs " + fmtX(g!.roas) + ")" : "Google plus rentable (ROAS " + fmtX(g!.roas) + " vs " + fmtX(m!.roas) + ")"}.`);
    learnings.push(`${totalConv} conversions totales pour un investissement moyen de ${fmtC(totalSpend / totalConv)} par conversion.`);
    nextStepsGlobal.push(`Réallouer budget vers la plateforme la plus rentable : ${m!.roas > g!.roas ? "augmenter Meta, réduire Google" : "augmenter Google, réduire Meta"}.`);
    nextStepsGlobal.push("Définir des objectifs CPA cibles par plateforme et ajuster les budgets en conséquence.");
    nextStepsGlobal.push(`Maintenir la dynamique actuelle : ${globalRoas >= 3 ? "excellent ROAS global, chercher à scaler" : "optimiser la rentabilité avant de scaler"}.`);
  } else if (hasMeta) {
    learnings.push(`Investissement Meta Ads de ${fmtC(m!.spend)} pour ${fmtC(m!.revenue)} de revenus générés — ROAS ${fmtX(m!.roas)}.`);
    learnings.push(`${totalConv} conversions Meta à un CPA de ${fmtC(m!.cpa)} — ${m!.roas >= 3 ? "performance solide" : "marge d'amélioration identifiée"}.`);
    learnings.push(`CTR Meta à ${fmtPct(m!.ctr)} — ${m!.ctr >= 1 ? "audiences bien ciblées, créatives performantes" : "signal de fatigue créative, rotation recommandée"}.`);
    nextStepsGlobal.push(`${m!.roas >= 3 ? "Scaler le budget Meta de +15-20% sur les campagnes performantes" : "Optimiser le ROAS Meta avant d'augmenter le budget"}.`);
    nextStepsGlobal.push("Tester l'activation de Google Ads pour diversifier les canaux d'acquisition.");
    nextStepsGlobal.push("Analyser les créatives top performers et produire de nouvelles itérations.");
  } else if (hasGoogle) {
    learnings.push(`Investissement Google Ads de ${fmtC(g!.spend)} pour ${fmtC(g!.revenue)} de revenus — ROAS ${fmtX(g!.roas)}.`);
    learnings.push(`${totalConv} conversions Google à un CPA de ${fmtC(g!.cpa)} — ${g!.roas >= 3 ? "performance solide" : "optimisation nécessaire"}.`);
    learnings.push(`CTR Google à ${fmtPct(g!.ctr)} — ${g!.ctr >= 2 ? "annonces pertinentes" : "annonces à optimiser pour améliorer le CTR"}.`);
    nextStepsGlobal.push(`${g!.roas >= 3 ? "Augmenter le budget Google Ads sur les campagnes rentables" : "Optimiser les campagnes avant de scaler"}.`);
    nextStepsGlobal.push("Envisager d'activer Meta Ads pour diversifier les canaux d'acquisition.");
    nextStepsGlobal.push("Auditer les mots-clés non-convertisseurs et les exclure.");
  }

  void pctDelta; void sign; // suppress unused var warnings

  return { learnings, insightsGoogle, insightsMeta, nextStepsGlobal, nextStepsGoogle, nextStepsMeta };
}

// Keep as async to preserve interface compatibility; no longer calls relay
async function fetchAiTextContent(
  data: {
    googleOverview: PlatformMetrics | null;
    metaOverview: PlatformMetrics | null;
    clientName: string;
    periodLabel: string;
  },
): Promise<AiTextContent | null> {
  return generateInsightsFromData(data);
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

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

  if (guard.session.role !== "admin") {
    if (client.metaAccountId &&
        !(await assertAccountAllowed(guard.session.userId, "meta", client.metaAccountId))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (client.googleCustomerId &&
        !(await assertAccountAllowed(guard.session.userId, "google", client.googleCustomerId))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const metaToken = (() => {
    try { return getMetaSystemToken(); } catch { return null; }
  })();

  const previousPeriod = getPreviousPeriod(period);

  // Try to fetch real data in parallel (Meta + Google Ads + GA)
  const [metaResult, googleResult, gaResult] = await Promise.allSettled([
    client.metaAccountId && metaToken
      ? fetchMetaData(client.metaAccountId, period, previousPeriod, metaToken)
      : Promise.resolve(null),
    client.googleCustomerId
      ? fetchGoogleData(client.googleCustomerId, period, previousPeriod)
      : Promise.resolve(null),
    client.gaPropertyId
      ? fetchGAData(client.gaPropertyId, period, previousPeriod)
      : Promise.resolve(null),
  ]);
  // Note: calls run in parallel, each capped at 15s → ~15s total (parallel)

  const meta = metaResult.status === "fulfilled" ? metaResult.value : null;
  const google = googleResult.status === "fulfilled" ? googleResult.value : null;
  const ga = gaResult.status === "fulfilled" ? gaResult.value : null;
  const metaError = metaResult.status === "rejected" ? String(metaResult.reason) : (meta === null && client.metaAccountId ? "No data parsed from relay response" : null);
  const googleError = googleResult.status === "rejected" ? String(googleResult.reason) : (google === null && client.googleCustomerId ? "No data parsed from relay response" : null);
  const gaError = gaResult.status === "rejected" ? String(gaResult.reason) : (ga === null && client.gaPropertyId ? "No GA data parsed" : null);

  console.error("[deck/data] relay results:", {
    relayUrls: RELAY_URLS_TO_TRY,
    metaAccountId: client.metaAccountId,
    googleCustomerId: client.googleCustomerId,
    gaPropertyId: client.gaPropertyId,
    metaOk: !!meta,
    googleOk: !!google,
    gaOk: !!ga,
    metaError,
    googleError,
    gaError,
  });

  // If both failed AND there's no Google Analytics either, fallback to mock data
  // (preserves demo decks for clients with no real account linked).
  if (!meta && !google) {
    const mockData = generateMockDeckData(client, period);
    const reason = [metaError, googleError].filter(Boolean).join(" | ");
    const mockWarnings = [
      `Aucune donnée réelle disponible — affichage de chiffres de démonstration${reason ? ` (${reason.slice(0, 300)})` : ""}`,
    ];
    return NextResponse.json({ data: mockData, source: "mock", reason, warnings: mockWarnings });
  }

  // At least one platform returned real data — build the deck from real data only.
  // No mock fallback: empty/zero stays empty/zero so slides reflect reality. Warnings
  // are surfaced to the client so the UI can show a banner.
  const warnings: string[] = [];

  const metaOverview = meta?.overview ?? zeroMetrics();
  const metaPrevOverview = meta?.prevOverview ?? zeroMetrics();
  const googleOverview = google?.overview ?? zeroMetrics();
  const googlePrevOverview = google?.prevOverview ?? zeroMetrics();

  if (client.metaAccountId && metaOverview.spend === 0) {
    warnings.push(metaError
      ? `Meta : impossible de récupérer les données (${metaError.slice(0, 200)})`
      : `Meta : aucune donnée pour ${period.label}`);
  }
  if (client.googleCustomerId && googleOverview.spend === 0) {
    warnings.push(googleError
      ? `Google Ads : impossible de récupérer les données (${googleError.slice(0, 200)})`
      : `Google Ads : aucune donnée pour ${period.label}`);
  }
  if (client.gaPropertyId && !ga) {
    warnings.push(gaError
      ? `Google Analytics : ${gaError.slice(0, 200)}`
      : `Google Analytics : aucune donnée pour ${period.label}`);
  }

  // Fetch AI text content with real data — generator already returns empty arrays
  // when both platforms have 0 spend, so no need for mock substitution.
  const metaForInsights = client.metaAccountId ? metaOverview : null;
  const googleForInsights = client.googleCustomerId ? googleOverview : null;
  const aiTextPromise = fetchAiTextContent({
    googleOverview: googleForInsights,
    metaOverview: metaForInsights,
    clientName: client.name,
    periodLabel: period.label,
  });

  const metaOverviewForTotals = metaOverview;
  const googleOverviewForTotals = googleOverview;
  const metaPrevOverviewForTotals = metaPrevOverview;
  const googlePrevOverviewForTotals = googlePrevOverview;

  // Global totals
  const totalCurrent: PlatformMetrics = {
    spend: metaOverviewForTotals.spend + googleOverviewForTotals.spend,
    impressions: metaOverviewForTotals.impressions + googleOverviewForTotals.impressions,
    clicks: metaOverviewForTotals.clicks + googleOverviewForTotals.clicks,
    conversions: metaOverviewForTotals.conversions + googleOverviewForTotals.conversions,
    revenue: metaOverviewForTotals.revenue + googleOverviewForTotals.revenue,
    cpm: 0, ctr: 0, cpc: 0, cpa: 0, roas: 0,
  };
  if (totalCurrent.impressions > 0) totalCurrent.cpm = (totalCurrent.spend / totalCurrent.impressions) * 1000;
  if (totalCurrent.impressions > 0) totalCurrent.ctr = (totalCurrent.clicks / totalCurrent.impressions) * 100;
  if (totalCurrent.clicks > 0) totalCurrent.cpc = totalCurrent.spend / totalCurrent.clicks;
  if (totalCurrent.conversions > 0) totalCurrent.cpa = totalCurrent.spend / totalCurrent.conversions;
  if (totalCurrent.spend > 0) totalCurrent.roas = totalCurrent.revenue / totalCurrent.spend;

  const totalPrevious: PlatformMetrics = {
    spend: metaPrevOverviewForTotals.spend + googlePrevOverviewForTotals.spend,
    impressions: metaPrevOverviewForTotals.impressions + googlePrevOverviewForTotals.impressions,
    clicks: metaPrevOverviewForTotals.clicks + googlePrevOverviewForTotals.clicks,
    conversions: metaPrevOverviewForTotals.conversions + googlePrevOverviewForTotals.conversions,
    revenue: metaPrevOverviewForTotals.revenue + googlePrevOverviewForTotals.revenue,
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
      ...(google ? [{
        platform: "Google" as const,
        current: googleOverviewForTotals,
        previous: googlePrevOverviewForTotals,
        delta: safeDelta(googleOverviewForTotals, googlePrevOverviewForTotals),
      }] : []),
      ...(meta ? [{
        platform: "Meta" as const,
        current: metaOverviewForTotals,
        previous: metaPrevOverviewForTotals,
        delta: safeDelta(metaOverviewForTotals, metaPrevOverviewForTotals),
      }] : []),
      {
        platform: "Total" as const,
        current: totalCurrent,
        previous: totalPrevious,
        delta: safeDelta(totalCurrent, totalPrevious),
      },
    ],

    ncTable: [],

    googleOverview: googleOverviewForTotals,
    googleCampaigns: google?.campaigns ?? [],

    metaOverview: metaOverviewForTotals,
    metaCampaigns: meta?.campaigns ?? [],
    topCreatives: meta?.topCreatives ?? [],

    // Google Analytics
    gaOverview: ga?.overview,
    gaPrevOverview: ga?.prevOverview,
    gaTopPages: ga?.topPages,
    gaDevices: ga?.devices,
    gaSources: ga?.sources,

    budget: [],

    // Filled in after AI text resolves below — empty by default so empty data = empty slides
    learnings: [],
    insightsGoogle: [],
    insightsMeta: [],
    nextStepsGlobal: [],
    nextStepsGoogle: [],
    nextStepsMeta: [],
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

  return NextResponse.json({ data: deckData, source: "real", warnings });
}
