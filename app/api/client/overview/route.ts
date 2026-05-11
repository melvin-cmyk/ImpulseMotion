import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import {
  getAccountInsights,
  getAdInsights,
  getAds,
  getMetaSystemToken,
  computeRoas,
  computeCpa,
  getActionValue,
} from "@/lib/meta-api";
import { assertAccountAllowed } from "@/lib/acl";
import { relayDirectTool } from "@/lib/relay-tool";

export const maxDuration = 60;

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.-]/g, "")) : Number(v);
  return isFinite(n) ? n : 0;
}

interface Kpi {
  spend: number;
  revenue: number;
  conversions: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpm: number;
  cpc: number;
  cpa: number;
  roas: number;
}

function zeroKpi(): Kpi {
  return { spend: 0, revenue: 0, conversions: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, cpc: 0, cpa: 0, roas: 0 };
}

function derive(spend: number, impressions: number, clicks: number, conversions: number, revenue: number): Kpi {
  return {
    spend,
    revenue,
    conversions,
    impressions,
    clicks,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpa: conversions > 0 ? spend / conversions : 0,
    roas: spend > 0 ? revenue / spend : 0,
  };
}

interface MetaCreativeOut {
  id: string;
  name: string;
  spend: number;
  impressions: number;
  ctr: number;
  roas: number;
  cpa: number;
  hookRate: number | null;
  thumbnailUrl: string | null;
}

async function fetchMetaSide(
  accountId: string,
  since: string,
  until: string,
): Promise<{ kpi: Kpi; topCreatives: MetaCreativeOut[] } | null> {
  try {
    const token = getMetaSystemToken();
    const range = { since, until };
    const [acct, ads, insights] = await Promise.all([
      getAccountInsights(token, accountId, range).catch(() => null),
      getAds(token, accountId, 50).catch(() => []),
      getAdInsights(token, accountId, range, 50).catch(() => []),
    ]);

    const spend = toNum(acct?.spend);
    const impressions = toNum(acct?.impressions);
    const clicks = toNum(acct?.clicks);
    const purchases = acct ? getActionValue(acct.actions, "purchase") : 0;
    // Meta returns purchase count; revenue we approximate from purchase value
    // when present, else fall back to count × AOV proxy (20€) consistent with
    // /api/me/accounts/preview.
    const purchaseValue = acct
      ? toNum(acct.actions?.find((a) => a.action_type === "purchase_value")?.value) ||
        getActionValue(acct.actions, "purchase") * 20
      : 0;

    const adsById = new Map(ads.map((a) => [a.id, a]));
    const topCreatives = [...insights]
      .sort((a, b) => parseFloat(b.spend) - parseFloat(a.spend))
      .slice(0, 8)
      .map((i): MetaCreativeOut => {
        const ad = adsById.get(i.ad_id);
        const imp = parseInt(i.impressions, 10) || 0;
        const thruplay = toNum(i.video_thruplay_watched_actions?.find((a) => a.action_type === "video_view")?.value);
        return {
          id: i.ad_id,
          name: ad?.name ?? i.ad_name ?? i.ad_id,
          spend: Math.round(parseFloat(i.spend)),
          impressions: imp,
          ctr: parseFloat(i.ctr),
          roas: computeRoas(i),
          cpa: computeCpa(i),
          hookRate: imp > 0 ? (thruplay / imp) * 100 : null,
          thumbnailUrl: ad?.creative?.thumbnail_url ?? ad?.creative?.image_url ?? null,
        };
      });

    return {
      kpi: derive(spend, impressions, clicks, purchases, purchaseValue),
      topCreatives,
    };
  } catch (e) {
    console.error("[client/overview] meta side failed:", e);
    return null;
  }
}

interface GoogleCampaign { id: string; name: string; spend: number; clicks: number; conversions: number; revenue: number; roas: number }
interface GoogleKeyword { keyword: string; matchType: string; campaign: string; impressions: number; clicks: number; spend: number; conversions: number; ctr: number; roas: number }
interface GoogleSearchTerm { term: string; impressions: number; clicks: number; spend: number; conversions: number }

function extractRows(raw: unknown): Array<Record<string, unknown>> {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const first = (raw as unknown[])[0];
    if (first && typeof first === "object" && Array.isArray((first as Record<string, unknown>).results)) {
      return (first as { results: Array<Record<string, unknown>> }).results;
    }
    return raw as Array<Record<string, unknown>>;
  }
  if (typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const arr = r.results ?? r.data ?? r.rows;
    if (Array.isArray(arr)) return arr as Array<Record<string, unknown>>;
  }
  return [];
}

function micros(v: unknown): number {
  const n = toNum(v);
  return n > 10000 ? n / 1_000_000 : n;
}

async function fetchGoogleSide(
  customerId: string,
  since: string,
  until: string,
): Promise<{ kpi: Kpi; topCampaigns: GoogleCampaign[]; topKeywords: GoogleKeyword[]; topSearchTerms: GoogleSearchTerm[] } | null> {
  const cleanId = customerId.replace(/-/g, "").replace(/^0+/, "") || customerId;
  try {
    const period = { customer_id: cleanId, start_date: since, end_date: until };
    // Run all three queries in parallel via the Custom_GAQL endpoint.
    // Campaign_Performance is its own tool; keywords + search terms via GAQL.
    const keywordQuery = `
      SELECT
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        campaign.name,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversions_value,
        metrics.ctr
      FROM keyword_view
      WHERE segments.date BETWEEN '${since}' AND '${until}'
        AND metrics.impressions > 0
      ORDER BY metrics.cost_micros DESC
      LIMIT 30
    `.trim();

    const searchTermQuery = `
      SELECT
        search_term_view.search_term,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions
      FROM search_term_view
      WHERE segments.date BETWEEN '${since}' AND '${until}'
        AND metrics.impressions > 0
      ORDER BY metrics.cost_micros DESC
      LIMIT 30
    `.trim();

    const [campaignsRaw, keywordsRaw, searchTermsRaw] = await Promise.allSettled([
      relayDirectTool("mcp-google-ads.Campaign_Performance", {
        input: JSON.stringify(period),
      }, 20000),
      relayDirectTool("mcp-google-ads.Custom_GAQL_Query", {
        input: JSON.stringify({ customer_id: cleanId, query: keywordQuery }),
      }, 20000),
      relayDirectTool("mcp-google-ads.Custom_GAQL_Query", {
        input: JSON.stringify({ customer_id: cleanId, query: searchTermQuery }),
      }, 20000),
    ]);

    // Campaigns
    const cRows = campaignsRaw.status === "fulfilled" ? extractRows(campaignsRaw.value) : [];
    let totalSpend = 0, totalImpressions = 0, totalClicks = 0, totalConversions = 0, totalRevenue = 0;
    const topCampaigns: GoogleCampaign[] = cRows.slice(0, 10).map((row, i) => {
      const c = (row.campaign as Record<string, unknown>) ?? row;
      const m = (row.metrics as Record<string, unknown>) ?? row;
      const spend = micros(m.costMicros ?? m.cost_micros ?? m.cost);
      const clicks = toNum(m.clicks);
      const impressions = toNum(m.impressions);
      const conversions = toNum(m.conversions ?? m.allConversions);
      const revenue = toNum(m.conversionsValue ?? m.conversions_value ?? m.revenue);
      totalSpend += spend;
      totalImpressions += impressions;
      totalClicks += clicks;
      totalConversions += conversions;
      totalRevenue += revenue;
      return {
        id: String(c.id ?? c.campaign_id ?? `google-c-${i}`),
        name: String(c.name ?? c.campaign_name ?? `Campagne ${i + 1}`),
        spend: Math.round(spend),
        clicks: Math.round(clicks),
        conversions: Math.round(conversions * 10) / 10,
        revenue: Math.round(revenue),
        roas: spend > 0 ? revenue / spend : 0,
      };
    });

    // Keywords
    const kRows = keywordsRaw.status === "fulfilled" ? extractRows(keywordsRaw.value) : [];
    const topKeywords: GoogleKeyword[] = kRows.slice(0, 30).map((row) => {
      const kw = (row.adGroupCriterion as Record<string, unknown>)?.keyword as Record<string, unknown> | undefined
        ?? (row.ad_group_criterion as Record<string, unknown>)?.keyword as Record<string, unknown> | undefined
        ?? row;
      const m = (row.metrics as Record<string, unknown>) ?? row;
      const c = (row.campaign as Record<string, unknown>) ?? {};
      const spend = micros(m.costMicros ?? m.cost_micros);
      const impressions = toNum(m.impressions);
      const clicks = toNum(m.clicks);
      const revenue = toNum(m.conversionsValue ?? m.conversions_value);
      return {
        keyword: String(kw?.text ?? row.text ?? "—"),
        matchType: String(kw?.matchType ?? kw?.match_type ?? "—"),
        campaign: String(c.name ?? "—"),
        impressions: Math.round(impressions),
        clicks: Math.round(clicks),
        spend: Math.round(spend),
        conversions: toNum(m.conversions),
        ctr: toNum(m.ctr) || (impressions > 0 ? (clicks / impressions) * 100 : 0),
        roas: spend > 0 ? revenue / spend : 0,
      };
    });

    // Search terms
    const stRows = searchTermsRaw.status === "fulfilled" ? extractRows(searchTermsRaw.value) : [];
    const topSearchTerms: GoogleSearchTerm[] = stRows.slice(0, 30).map((row) => {
      const st = (row.searchTermView as Record<string, unknown>) ?? (row.search_term_view as Record<string, unknown>) ?? row;
      const m = (row.metrics as Record<string, unknown>) ?? row;
      return {
        term: String(st?.searchTerm ?? st?.search_term ?? row.text ?? "—"),
        impressions: Math.round(toNum(m.impressions)),
        clicks: Math.round(toNum(m.clicks)),
        spend: Math.round(micros(m.costMicros ?? m.cost_micros)),
        conversions: toNum(m.conversions),
      };
    });

    return {
      kpi: derive(totalSpend, totalImpressions, totalClicks, totalConversions, totalRevenue),
      topCampaigns,
      topKeywords,
      topSearchTerms,
    };
  } catch (e) {
    console.error("[client/overview] google side failed:", e);
    return null;
  }
}

function normLabel(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function pickGoogleAccountForUser(
  userId: string,
  metaLabel: string | null,
  explicitGoogleId: string | null,
): Promise<{ accountId: string; label: string | null } | null> {
  const rows = await prisma.userAdAccount.findMany({
    where: { userId, platform: "google" },
    select: { accountId: true, label: true },
  });
  if (rows.length === 0) return null;

  if (explicitGoogleId) {
    const clean = explicitGoogleId.replace(/-/g, "");
    const match = rows.find((r) => r.accountId.replace(/-/g, "") === clean);
    if (match) return { accountId: match.accountId, label: match.label };
  }

  // Pair by normalized label similarity (e.g. "Saveurs et Vie" ≈ "Saveurs & Vie")
  const metaNorm = normLabel(metaLabel);
  if (metaNorm) {
    const scored = rows
      .map((r) => {
        const rn = normLabel(r.label);
        const longest = Math.max(rn.length, metaNorm.length);
        const tokens = new Set([...rn.split(" "), ...metaNorm.split(" ")].filter(Boolean));
        const shared = rn.split(" ").filter((t) => metaNorm.split(" ").includes(t) && t.length > 2).length;
        return { row: r, score: longest > 0 ? shared / tokens.size : 0 };
      })
      .sort((a, b) => b.score - a.score);
    if (scored[0] && scored[0].score >= 0.4) {
      return { accountId: scored[0].row.accountId, label: scored[0].row.label };
    }
  }

  // Fallback: first Google account in ACL
  return { accountId: rows[0].accountId, label: rows[0].label };
}

function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const url = new URL(req.url);
  const metaAccountId = url.searchParams.get("metaAccountId");
  const explicitGoogleId = url.searchParams.get("googleAccountId");
  const since = url.searchParams.get("since") ?? offsetDate(-30);
  const until = url.searchParams.get("until") ?? offsetDate(0);

  if (!metaAccountId) {
    return NextResponse.json({ error: "metaAccountId required" }, { status: 400 });
  }

  // Authorization: non-admins must have ACL on the meta account
  if (guard.session.role !== "admin") {
    const allowed = await assertAccountAllowed(guard.session.userId, "meta", metaAccountId);
    if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Resolve labels from ACL (best source) — fall back to ID
  const metaRow = await prisma.userAdAccount.findFirst({
    where: {
      userId: guard.session.userId,
      platform: "meta",
      OR: [
        { accountId: metaAccountId },
        { accountId: metaAccountId.replace(/^act_/, "") },
        { accountId: `act_${metaAccountId.replace(/^act_/, "")}` },
      ],
    },
    select: { label: true, accountId: true },
  });

  const googlePick = await pickGoogleAccountForUser(
    guard.session.userId,
    metaRow?.label ?? null,
    explicitGoogleId,
  );

  const [metaResult, googleResult] = await Promise.all([
    fetchMetaSide(metaAccountId, since, until),
    googlePick ? fetchGoogleSide(googlePick.accountId, since, until) : Promise.resolve(null),
  ]);

  const meta = metaResult ?? { kpi: zeroKpi(), topCreatives: [] };
  const google = googleResult ?? null;

  const combined = derive(
    meta.kpi.spend + (google?.kpi.spend ?? 0),
    meta.kpi.impressions + (google?.kpi.impressions ?? 0),
    meta.kpi.clicks + (google?.kpi.clicks ?? 0),
    meta.kpi.conversions + (google?.kpi.conversions ?? 0),
    meta.kpi.revenue + (google?.kpi.revenue ?? 0),
  );

  return NextResponse.json({
    range: { since, until },
    metaAccount: { id: metaAccountId, label: metaRow?.label ?? null },
    googleAccount: googlePick ? { id: googlePick.accountId, label: googlePick.label } : null,
    meta,
    google,
    combined,
  });
}
