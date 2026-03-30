/**
 * POST /api/deck/generate
 * Fetches real Meta Ads + Google Ads data via the relay proxy MCP,
 * then asks the AI to build slides dynamically based on the user's prompt.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getPreviousPeriod,
  type DeckClient,
  type DeckPeriod,
  type PlatformMetrics,
  type CampaignRow,
  type TopCreative,
} from "@/lib/deck-data";

export const maxDuration = 120; // Vercel Pro: allow up to 120s

const rawRelayUrl = (process.env.NEXT_PUBLIC_RELAY_URL || "").trim();
const RELAY_URL = rawRelayUrl
  ? rawRelayUrl.startsWith("http") ? rawRelayUrl : `https://${rawRelayUrl}`
  : "http://localhost:3457";

// ── Relay helpers ─────────────────────────────────────────────────────────────

async function relayChat(prompt: string, timeoutMs = 90000): Promise<string> {
  const urls = [RELAY_URL];
  if (!RELAY_URL.includes("localhost")) urls.push("http://localhost:3457");

  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { lastError = new Error(`Relay ${url} responded ${res.status}`); continue; }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let fullText = "";
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
            if (event.type === "delta" && typeof event.text === "string") { fullText += event.text; continue; }
            if (event.type === "content" && typeof event.content === "string") { fullText += event.content; continue; }
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

      if (fullText.trim()) return fullText;
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
    const objectMatch = candidate.match(/\{[\s\S]*\}/);
    const arrayMatch = candidate.match(/\[[\s\S]*\]/);
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
  const prompt = `You are a data extraction agent. Call the following MCP tools for Meta Ads account ${accountId} and return ONLY a JSON object.

REQUIRED TOOL CALLS:
1. mcp__meta-ads-impulse__Account_Overview1 — params: ad_account_id="${accountId}", since="${period.startDate}", until="${period.endDate}"
2. mcp__meta-ads-impulse__Campaign_Performance1 — params: ad_account_id="${accountId}", since="${period.startDate}", until="${period.endDate}"
3. mcp__meta-ads-impulse__Ad_Performance1 — params: ad_account_id="${accountId}", since="${period.startDate}", until="${period.endDate}"
4. mcp__meta-ads-impulse__Account_Overview1 again — params: ad_account_id="${accountId}", since="${previousPeriod.startDate}", until="${previousPeriod.endDate}" (for prev_total)

CRITICAL INSTRUCTION: After calling ALL the tools above, your ENTIRE response must be ONLY the following JSON structure filled with the real numbers from the tool results. Do NOT write any text before or after the JSON. Do NOT use markdown code blocks. Start your response with { and end with }.

{"total":{"spend":0,"impressions":0,"clicks":0,"conversions":0,"revenue":0},"prev_total":{"spend":0,"impressions":0,"clicks":0,"conversions":0,"revenue":0},"campaigns":[{"id":"","name":"","type":"","status":"Active","spend":0,"impressions":0,"clicks":0,"conversions":0,"revenue":0,"prev_spend":0,"prev_impressions":0,"prev_clicks":0,"prev_conversions":0,"prev_revenue":0}],"creatives":[{"id":"","name":"","format":"Video","spend":0,"roas":0,"ctr":0,"cpa":0,"impressions":0,"thumbnailUrl":""}]}`;

  try {
    const text = await relayChat(prompt);
    console.log("[deck/generate] meta raw response (800):", text.slice(0, 800));
    const data = extractJson<RawPlatformData>(text);
    if (!data) {
      console.error("[deck/generate] meta extractJson failed. raw:", text.slice(0, 2000));
      return null;
    }

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
  const prompt = `You are a data extraction agent. Call the following MCP tools for Google Ads customer ${customerId} and return ONLY a JSON object.

REQUIRED TOOL CALLS:
1. mcp__mcp-google-ads__Campaign_Performance — params: customer_id="${customerId}", start_date="${period.startDate}", end_date="${period.endDate}"
2. mcp__mcp-google-ads__Campaign_Performance again — params: customer_id="${customerId}", start_date="${previousPeriod.startDate}", end_date="${previousPeriod.endDate}" (for prev_total and prev_ campaign fields)

CRITICAL INSTRUCTION: After calling ALL the tools above, your ENTIRE response must be ONLY the following JSON structure filled with the real numbers from the tool results. Do NOT write any text before or after the JSON. Do NOT use markdown code blocks. Start your response with { and end with }.

{"total":{"spend":0,"impressions":0,"clicks":0,"conversions":0,"revenue":0},"prev_total":{"spend":0,"impressions":0,"clicks":0,"conversions":0,"revenue":0},"campaigns":[{"id":"","name":"","type":"","status":"Active","spend":0,"impressions":0,"clicks":0,"conversions":0,"revenue":0,"prev_spend":0,"prev_impressions":0,"prev_clicks":0,"prev_conversions":0,"prev_revenue":0}]}`;

  try {
    const text = await relayChat(prompt);
    console.log("[deck/generate] google raw response (800):", text.slice(0, 800));
    const data = extractJson<RawPlatformData>(text);
    if (!data) {
      console.error("[deck/generate] google extractJson failed. raw:", text.slice(0, 2000));
      return null;
    }

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

// ── Slide generation ──────────────────────────────────────────────────────────

export interface GeneratedSlide {
  id: string;
  title: string;
  content: string;
  notes?: string;
  type: "custom";
}

interface RawSlide {
  title?: string;
  content?: string;
  notes?: string;
}

async function generateSlides(
  clientName: string,
  periodLabel: string,
  meta: { overview: PlatformMetrics; campaigns: CampaignRow[]; topCreatives: TopCreative[]; prevOverview: PlatformMetrics } | null,
  google: { overview: PlatformMetrics; campaigns: CampaignRow[]; prevOverview: PlatformMetrics } | null,
  userPrompt: string
): Promise<GeneratedSlide[]> {
  const fmt = (n: number) => `€${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtPct = (n: number) => `${n.toFixed(2)}%`;
  const fmtRoas = (n: number) => `${n.toFixed(2)}x`;

  let metaSection = "META ADS: (no data available)";
  if (meta) {
    const m = meta.overview;
    const campaignLines = meta.campaigns
      .slice(0, 5)
      .map(c => `  - ${c.name} | spend: ${fmt(c.current.spend)} | ROAS: ${fmtRoas(c.current.roas)} | CTR: ${fmtPct(c.current.ctr)} | CPA: ${fmt(c.current.cpa)} | status: ${c.status}`)
      .join("\n");
    const creativeLines = meta.topCreatives
      .slice(0, 5)
      .map(cr => `  - ${cr.name} | format: ${cr.format} | spend: ${fmt(cr.spend)} | ROAS: ${fmtRoas(cr.roas)} | CTR: ${fmtPct(cr.ctr)} | CPA: ${fmt(cr.cpa)}`)
      .join("\n");

    metaSection = `META ADS:
- Total Spend: ${fmt(m.spend)}
- Impressions: ${Math.round(m.impressions).toLocaleString()}
- Clicks: ${Math.round(m.clicks).toLocaleString()}
- Conversions: ${Math.round(m.conversions)}
- Revenue: ${fmt(m.revenue)}
- ROAS: ${fmtRoas(m.roas)}
- CPA: ${fmt(m.cpa)}
- CTR: ${fmtPct(m.ctr)}
- CPM: ${fmt(m.cpm)}

TOP CAMPAIGNS (Meta):
${campaignLines || "  (none)"}

TOP CREATIVES:
${creativeLines || "  (none)"}`;
  }

  let googleSection = "GOOGLE ADS: (no data available)";
  if (google) {
    const g = google.overview;
    const campaignLines = google.campaigns
      .slice(0, 5)
      .map(c => `  - ${c.name} | spend: ${fmt(c.current.spend)} | ROAS: ${fmtRoas(c.current.roas)} | CTR: ${fmtPct(c.current.ctr)} | CPA: ${fmt(c.current.cpa)} | status: ${c.status}`)
      .join("\n");

    googleSection = `GOOGLE ADS:
- Total Spend: ${fmt(g.spend)}
- Impressions: ${Math.round(g.impressions).toLocaleString()}
- Clicks: ${Math.round(g.clicks).toLocaleString()}
- Conversions: ${Math.round(g.conversions)}
- Revenue: ${fmt(g.revenue)}
- ROAS: ${fmtRoas(g.roas)}
- CPA: ${fmt(g.cpa)}
- CTR: ${fmtPct(g.ctr)}
- CPM: ${fmt(g.cpm)}

TOP CAMPAIGNS (Google):
${campaignLines || "  (none)"}`;
  }

  const prompt = `You are a digital marketing analyst building a presentation deck.

REAL DATA for ${clientName} (${periodLabel}):

${metaSection}

${googleSection}

ANALYST REQUEST:
${userPrompt}

Based on the REAL data above, build exactly the slides requested. Return ONLY a JSON array (no markdown, no text before/after):
[{"title":"...","content":"...markdown with real numbers...","notes":"optional presenter note"}]

Rules:
- Use ONLY the real numbers from the data above. Never invent data.
- Make content rich: tables, bullet points, bold KPIs
- Format: €X for money, X% for percentages, Xx for ROAS
- 2-8 slides max
- Each slide content is markdown`;

  const text = await relayChat(prompt, 60000);
  console.log("[deck/generate] slides raw response (800):", text.slice(0, 800));

  const rawSlides = extractJson<RawSlide[]>(text);
  if (!rawSlides || !Array.isArray(rawSlides)) {
    console.error("[deck/generate] slides extractJson failed. raw:", text.slice(0, 2000));
    return [];
  }

  return rawSlides
    .filter((s): s is RawSlide & { title: string; content: string } => !!s.title && !!s.content)
    .map((s, i) => ({
      id: `ai-slide-${Date.now()}-${i}`,
      title: s.title,
      content: s.content,
      notes: s.notes,
      type: "custom" as const,
    }));
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let client: DeckClient, period: DeckPeriod, userPrompt: string;
  try {
    const body = await req.json();
    client = body.client;
    period = body.period;
    userPrompt = typeof body.userPrompt === "string" ? body.userPrompt : "Génère une vue d'ensemble des performances.";
    if (!client || !period) throw new Error("Missing client or period");
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const previousPeriod = getPreviousPeriod(period);

  // Fetch real data in parallel
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
  const hasRealData = !!(meta || google);

  console.error("[deck/generate] relay results:", {
    relayUrl: RELAY_URL,
    metaAccountId: client.metaAccountId,
    googleCustomerId: client.googleCustomerId,
    metaOk: !!meta,
    googleOk: !!google,
  });

  // Generate slides from AI using real data (or fallback prompt if no data)
  let slides: GeneratedSlide[] = [];
  try {
    slides = await generateSlides(client.name, period.label, meta, google, userPrompt);
  } catch (err) {
    console.error("[deck/generate] generateSlides failed:", err);
  }

  return NextResponse.json({
    slides,
    dataSource: hasRealData ? "real" : "mock",
  });
}
