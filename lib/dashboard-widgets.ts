/**
 * Dashboard widget system (Lot 3).
 *
 * A dashboard belongs to a client user and is bound to one Meta account and/or
 * one Google Ads customer. Widgets are typed, their config is validated here,
 * and `resolveWidgets` fetches their data server-side with the KPI cache.
 *
 * Security invariant: whatever the widget config says, data is only ever
 * fetched for accounts present in the dashboard owner's ACL (UserAdAccount).
 * This re-check runs at resolve time so nothing — UI, API or AI copilot —
 * can point a widget at someone else's account.
 */

import { prisma } from "@/lib/prisma";
import { cached } from "@/lib/kpi-cache";
import {
  getMetaSystemToken,
  getAds,
  getAdInsights,
  getAccountDailyInsights,
  getCampaignInsights,
  computeRevenue,
  computeHookRate,
  computeRoas,
  computeCpa,
  getActionValue,
  type MetaAccountInsight,
} from "@/lib/meta-api";
import { getAccountInsightsCached } from "@/lib/insights";
import { getAccountAov } from "@/lib/account-settings";
import { relayDirectTool } from "@/lib/relay-tool";
import { computePacing } from "@/lib/budgets";

import {
  WIDGET_TYPES,
  widgetIssue as issue,
  type WidgetType,
  type ResolvedWidget,
} from "@/lib/dashboard-types";

// Re-export the client-safe surface so server code can import everything here.
export {
  WIDGET_TYPES, KPI_METRICS, SERIES_METRICS, TABLE_KINDS, WIDGET_WIDTHS,
  WIDGET_TYPE_INFO, validateWidgetConfig, validateWidgetWidth,
} from "@/lib/dashboard-types";
export type { WidgetType, ResolvedWidget } from "@/lib/dashboard-types";

// ── ACL binding ──────────────────────────────────────────────────────────────

export interface DashboardBinding {
  metaAccountId: string | null;
  googleCustomerId: string | null;
}

const normMeta = (id: string) => id.replace(/^act_/, "");
const normGoogle = (id: string) => id.replace(/-/g, "").replace(/^0+/, "");

/** Resolves the dashboard's accounts, constrained to the owner's ACL.
 *  Unbound dashboards fall back to the owner's first ACL account per platform. */
export async function resolveBinding(
  ownerId: string,
  dashboard: { metaAccountId: string | null; googleCustomerId: string | null },
): Promise<DashboardBinding> {
  const acl = await prisma.userAdAccount.findMany({ where: { userId: ownerId } });
  const metaIds = acl.filter((a) => a.platform === "meta").map((a) => normMeta(a.accountId));
  const googleIds = acl.filter((a) => a.platform === "google").map((a) => normGoogle(a.accountId));

  let metaAccountId: string | null = null;
  if (dashboard.metaAccountId && metaIds.includes(normMeta(dashboard.metaAccountId))) {
    metaAccountId = normMeta(dashboard.metaAccountId);
  } else if (!dashboard.metaAccountId && metaIds.length > 0) {
    metaAccountId = metaIds[0];
  }

  let googleCustomerId: string | null = null;
  if (dashboard.googleCustomerId && googleIds.includes(normGoogle(dashboard.googleCustomerId))) {
    googleCustomerId = normGoogle(dashboard.googleCustomerId);
  } else if (!dashboard.googleCustomerId && googleIds.length > 0) {
    googleCustomerId = googleIds[0];
  }

  return { metaAccountId, googleCustomerId };
}

// ── Google fetch helpers (via relay MCP) ─────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toNum(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

function micros(v: unknown): number {
  const n = toNum(v);
  return n > 10000 ? n / 1_000_000 : n;
}

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

interface GoogleTotals { spend: number; clicks: number; impressions: number; conversions: number; revenue: number }

async function fetchGoogleCampaignRows(
  customerId: string,
  since: string,
  until: string,
): Promise<Array<Record<string, unknown>>> {
  // GAQL rather than the Campaign_Performance tool: that n8n workflow ignores
  // its start/end dates (verified: identical totals for any period), which
  // silently broke period selection and previous-period deltas.
  const query = `SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.clicks,
      metrics.impressions, metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}'
    ORDER BY metrics.cost_micros DESC`;
  return cached(
    `google:campaigns:${customerId}:${since}_${until}`,
    async () => {
      const raw = await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", {
        input: JSON.stringify({ customer_id: customerId, gaql_query: query.replace(/\s+/g, " ") }),
      }, 20000);
      return extractRows(raw);
    },
  );
}

function googleTotals(rows: Array<Record<string, unknown>>): GoogleTotals {
  const t: GoogleTotals = { spend: 0, clicks: 0, impressions: 0, conversions: 0, revenue: 0 };
  for (const row of rows) {
    const m = (row.metrics as Record<string, unknown>) ?? row;
    t.spend += micros(m.costMicros ?? m.cost_micros ?? m.cost);
    t.clicks += toNum(m.clicks);
    t.impressions += toNum(m.impressions);
    t.conversions += toNum(m.conversions ?? m.allConversions);
    t.revenue += toNum(m.conversionsValue ?? m.conversions_value ?? m.revenue);
  }
  return t;
}

async function fetchGoogleGaqlRows(
  customerId: string,
  kind: "keywords" | "search_terms",
  since: string,
  until: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const query =
    kind === "keywords"
      ? `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, campaign.name,
           metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions,
           metrics.conversions_value, metrics.ctr
         FROM keyword_view
         WHERE segments.date BETWEEN '${since}' AND '${until}' AND metrics.impressions > 0
         ORDER BY metrics.cost_micros DESC LIMIT ${limit}`
      : `SELECT search_term_view.search_term, metrics.impressions, metrics.clicks,
           metrics.cost_micros, metrics.conversions
         FROM search_term_view
         WHERE segments.date BETWEEN '${since}' AND '${until}' AND metrics.impressions > 0
         ORDER BY metrics.cost_micros DESC LIMIT ${limit}`;
  return cached(
    `google:${kind}:${customerId}:${since}_${until}:${limit}`,
    async () => {
      const raw = await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", {
        input: JSON.stringify({ customer_id: customerId, gaql_query: query.replace(/\s+/g, " ") }),
      }, 20000);
      return extractRows(raw);
    },
  );
}

// ── Widget resolution ────────────────────────────────────────────────────────

export interface CompareRange {
  since: string;
  until: string;
  /** prev | year | custom — drives the label shown under KPI deltas */
  kind: string;
}

interface ResolveContext {
  binding: DashboardBinding;
  ownerId: string;
  since: string;
  until: string;
  token: string;
  aov: number;
  /** null = comparison disabled */
  compare: CompareRange | null;
}

function metaMetricValue(
  insight: MetaAccountInsight | null,
  metric: string,
  aov: number,
): { value: number; estimated: boolean } {
  if (!insight) return { value: 0, estimated: false };
  const spend = toNum(insight.spend);
  const rev = computeRevenue(insight, aov);
  switch (metric) {
    case "spend": return { value: spend, estimated: false };
    case "revenue": return { value: rev.revenue, estimated: rev.estimated };
    case "roas": return { value: spend > 0 ? rev.revenue / spend : 0, estimated: rev.estimated };
    case "ctr": return { value: toNum(insight.ctr), estimated: false };
    case "cpa": {
      const purchases = getActionValue(insight.actions, "omni_purchase") || getActionValue(insight.actions, "purchase");
      return { value: purchases > 0 ? spend / purchases : 0, estimated: false };
    }
    case "purchases": {
      const purchases = getActionValue(insight.actions, "omni_purchase") || getActionValue(insight.actions, "purchase");
      return { value: purchases, estimated: false };
    }
    case "clicks": return { value: toNum(insight.clicks), estimated: false };
    case "impressions": return { value: toNum(insight.impressions), estimated: false };
    case "cpc": {
      const clicks = toNum(insight.clicks);
      return { value: clicks > 0 ? spend / clicks : 0, estimated: false };
    }
    case "cr": {
      const clicks = toNum(insight.clicks);
      const purchases = getActionValue(insight.actions, "omni_purchase") || getActionValue(insight.actions, "purchase");
      return { value: clicks > 0 ? (purchases / clicks) * 100 : 0, estimated: false };
    }
    default: return { value: 0, estimated: false };
  }
}

/** One KPI value over an arbitrary range, for the widget's source. */
async function kpiValue(
  metric: string,
  source: string,
  ctx: ResolveContext,
  since: string,
  until: string,
): Promise<{ value: number; estimated: boolean }> {
  let insight: MetaAccountInsight | null = null;
  let google: GoogleTotals | null = null;
  if (source !== "google") {
    if (!ctx.binding.metaAccountId) throw issue("Aucun compte Meta autorisé pour ce dashboard");
    insight = await getAccountInsightsCached(ctx.token, ctx.binding.metaAccountId, { since, until });
  }
  if (source !== "meta") {
    if (!ctx.binding.googleCustomerId) throw issue("Aucun compte Google Ads autorisé pour ce dashboard");
    google = googleTotals(await fetchGoogleCampaignRows(ctx.binding.googleCustomerId, since, until));
  }

  const metaRev = insight ? computeRevenue(insight, ctx.aov) : { revenue: 0, estimated: false };
  const metaPurchases = insight
    ? getActionValue(insight.actions, "omni_purchase") || getActionValue(insight.actions, "purchase")
    : 0;
  const g = google ?? { spend: 0, clicks: 0, impressions: 0, conversions: 0, revenue: 0 };
  const useMeta = source !== "google";
  const useGoogle = source !== "meta";

  const spend = (useMeta ? toNum(insight?.spend) : 0) + (useGoogle ? g.spend : 0);
  const revenue = (useMeta ? metaRev.revenue : 0) + (useGoogle ? g.revenue : 0);
  const purchases = (useMeta ? metaPurchases : 0) + (useGoogle ? g.conversions : 0);
  const clicks = (useMeta ? toNum(insight?.clicks) : 0) + (useGoogle ? g.clicks : 0);
  const impressions = (useMeta ? toNum(insight?.impressions) : 0) + (useGoogle ? g.impressions : 0);

  let value = 0;
  switch (metric) {
    case "spend": value = spend; break;
    case "revenue": value = revenue; break;
    case "roas": value = spend > 0 ? revenue / spend : 0; break;
    case "purchases": value = purchases; break;
    case "clicks": value = clicks; break;
    case "impressions": value = impressions; break;
    case "cpa": value = purchases > 0 ? spend / purchases : 0; break;
    case "cpc": value = clicks > 0 ? spend / clicks : 0; break;
    case "cr": value = clicks > 0 ? (purchases / clicks) * 100 : 0; break;
    case "ctr":
      // pure-google: compute; meta & combined: Meta's own CTR (mixing platforms is meaningless)
      value = source === "google"
        ? (impressions > 0 ? (clicks / impressions) * 100 : 0)
        : toNum(insight?.ctr);
      break;
  }
  const estimated = useMeta && metaRev.estimated && (metric === "revenue" || metric === "roas");
  return { value, estimated };
}

/** Previous window of the same length, ending the day before `since`. */
export function prevRange(since: string, until: string): { since: string; until: string } {
  const DAY = 86400000;
  const s = Date.parse(since + "T00:00:00Z");
  const u = Date.parse(until + "T00:00:00Z");
  const days = Math.max(1, Math.round((u - s) / DAY) + 1);
  const prevUntil = new Date(s - DAY);
  const prevSince = new Date(s - days * DAY);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { since: fmt(prevSince), until: fmt(prevUntil) };
}

async function resolveKpi(cfg: Record<string, unknown>, ctx: ResolveContext) {
  const metric = String(cfg.metric);
  const source = String(cfg.source ?? "meta");
  const current = await kpiValue(metric, source, ctx, ctx.since, ctx.until);

  // Comparison window (configurable) — best effort, never fails the widget.
  let previous: number | null = null;
  let deltaPct: number | null = null;
  let compareKind: string | null = null;
  if (ctx.compare) {
    try {
      const prevVal = await kpiValue(metric, source, ctx, ctx.compare.since, ctx.compare.until);
      previous = Math.round(prevVal.value * 100) / 100;
      compareKind = ctx.compare.kind;
      if (prevVal.value > 0) {
        deltaPct = Math.round(((current.value - prevVal.value) / prevVal.value) * 1000) / 10;
      }
    } catch { /* comparison is optional */ }
  }

  return {
    metric,
    source,
    value: Math.round(current.value * 100) / 100,
    previous,
    deltaPct,
    compareKind,
    compareSince: ctx.compare?.since ?? null,
    compareUntil: ctx.compare?.until ?? null,
    estimated: current.estimated,
  };
}

async function fetchGoogleDailyRows(
  customerId: string,
  since: string,
  until: string,
): Promise<Array<Record<string, unknown>>> {
  const query = `SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions,
      metrics.conversions, metrics.conversions_value
    FROM customer
    WHERE segments.date BETWEEN '${since}' AND '${until}'
    ORDER BY segments.date`;
  return cached(
    `google:daily:${customerId}:${since}_${until}`,
    async () => {
      const raw = await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", {
        input: JSON.stringify({ customer_id: customerId, gaql_query: query.replace(/\s+/g, " ") }),
      }, 20000);
      return extractRows(raw);
    },
  );
}

function googleDailyMetric(row: Record<string, unknown>, metric: string): number {
  const m = (row.metrics as Record<string, unknown>) ?? row;
  const spend = micros(m.costMicros ?? m.cost_micros);
  const revenue = toNum(m.conversionsValue ?? m.conversions_value);
  const clicks = toNum(m.clicks);
  const impressions = toNum(m.impressions);
  switch (metric) {
    case "spend": return spend;
    case "revenue": return revenue;
    case "roas": return spend > 0 ? revenue / spend : 0;
    case "clicks": return clicks;
    case "purchases": return toNum(m.conversions);
    case "ctr": return impressions > 0 ? (clicks / impressions) * 100 : 0;
    case "cpc": return clicks > 0 ? spend / clicks : 0;
    case "cr": return clicks > 0 ? (toNum(m.conversions) / clicks) * 100 : 0;
    default: return 0;
  }
}

async function resolveTimeseries(cfg: Record<string, unknown>, ctx: ResolveContext) {
  const metric = String(cfg.metric);
  const source = String(cfg.source ?? "meta");

  if (source === "google") {
    if (!ctx.binding.googleCustomerId) throw issue("Aucun compte Google Ads autorisé pour ce dashboard");
    const rows = await fetchGoogleDailyRows(ctx.binding.googleCustomerId, ctx.since, ctx.until);
    const points = rows.map((row) => {
      const seg = ((row.segments as Record<string, unknown>) ?? row) as Record<string, unknown>;
      return {
        date: String(seg.date ?? ""),
        value: Math.round(googleDailyMetric(row, metric) * 100) / 100,
      };
    }).filter((p) => p.date);
    return { metric, source, points, estimated: false };
  }

  if (!ctx.binding.metaAccountId) throw issue("Aucun compte Meta autorisé pour ce dashboard");
  const rows = await cached(
    `meta:daily:${ctx.binding.metaAccountId}:${ctx.since}_${ctx.until}`,
    () => getAccountDailyInsights(getMetaSystemToken(), `act_${ctx.binding.metaAccountId}`, {
      since: ctx.since, until: ctx.until,
    }),
  );
  let estimated = false;
  const points = rows.map((r) => {
    const m = metaMetricValue(r, metric, ctx.aov);
    if (m.estimated) estimated = true;
    return { date: r.date_start, value: Math.round(m.value * 100) / 100 };
  });
  return { metric, source, points, estimated };
}

async function resolveTable(cfg: Record<string, unknown>, ctx: ResolveContext) {
  const kind = String(cfg.kind);
  const source = String(cfg.source ?? "google");
  const limit = Number(cfg.limit ?? 10);

  if (source === "meta") {
    if (!ctx.binding.metaAccountId) throw issue("Aucun compte Meta autorisé pour ce dashboard");
    const accountId = ctx.binding.metaAccountId;
    const rows = await cached(
      `meta:campaigns:${accountId}:${ctx.since}_${ctx.until}`,
      () => getCampaignInsights(ctx.token, accountId, { since: ctx.since, until: ctx.until }, 50),
    );
    return {
      kind,
      source,
      rows: [...rows]
        .sort((a, b) => toNum(b.spend) - toNum(a.spend))
        .slice(0, limit)
        .map((r, i) => {
          const spend = toNum(r.spend);
          const rev = computeRevenue(r, ctx.aov);
          const purchases = getActionValue(r.actions, "omni_purchase") || getActionValue(r.actions, "purchase");
          return {
            name: String(r.campaign_name ?? `Campagne ${i + 1}`),
            spend: Math.round(spend),
            clicks: Math.round(toNum(r.clicks)),
            conversions: Math.round(purchases * 10) / 10,
            roas: spend > 0 ? Math.round((rev.revenue / spend) * 100) / 100 : 0,
          };
        }),
    };
  }

  if (!ctx.binding.googleCustomerId) throw issue("Aucun compte Google Ads autorisé pour ce dashboard");
  if (kind === "campaigns") {
    const rows = await fetchGoogleCampaignRows(ctx.binding.googleCustomerId, ctx.since, ctx.until);
    return {
      kind,
      rows: rows.slice(0, limit).map((row, i) => {
        const c = (row.campaign as Record<string, unknown>) ?? row;
        const m = (row.metrics as Record<string, unknown>) ?? row;
        const spend = micros(m.costMicros ?? m.cost_micros ?? m.cost);
        const revenue = toNum(m.conversionsValue ?? m.conversions_value ?? m.revenue);
        return {
          name: String(c.name ?? c.campaign_name ?? `Campagne ${i + 1}`),
          spend: Math.round(spend),
          clicks: Math.round(toNum(m.clicks)),
          conversions: Math.round(toNum(m.conversions ?? m.allConversions) * 10) / 10,
          roas: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : 0,
        };
      }),
    };
  }

  const rows = await fetchGoogleGaqlRows(
    ctx.binding.googleCustomerId,
    kind as "keywords" | "search_terms",
    ctx.since, ctx.until, limit,
  );
  if (kind === "keywords") {
    return {
      kind,
      rows: rows.slice(0, limit).map((row) => {
        const crit = ((row.adGroupCriterion ?? row.ad_group_criterion) as Record<string, unknown>) ?? {};
        const kw = (crit.keyword as Record<string, unknown>) ?? {};
        const m = (row.metrics as Record<string, unknown>) ?? row;
        return {
          name: String(kw.text ?? row.keyword ?? "—"),
          matchType: String(kw.matchType ?? kw.match_type ?? ""),
          spend: Math.round(micros(m.costMicros ?? m.cost_micros)),
          clicks: Math.round(toNum(m.clicks)),
          conversions: Math.round(toNum(m.conversions) * 10) / 10,
          ctr: Math.round(toNum(m.ctr) * 10000) / 100,
        };
      }),
    };
  }
  return {
    kind,
    rows: rows.slice(0, limit).map((row) => {
      const st = ((row.searchTermView ?? row.search_term_view) as Record<string, unknown>) ?? {};
      const m = (row.metrics as Record<string, unknown>) ?? row;
      return {
        name: String(st.searchTerm ?? st.search_term ?? row.search_term ?? "—"),
        spend: Math.round(micros(m.costMicros ?? m.cost_micros)),
        clicks: Math.round(toNum(m.clicks)),
        conversions: Math.round(toNum(m.conversions) * 10) / 10,
      };
    }),
  };
}

async function resolveTopCreatives(cfg: Record<string, unknown>, ctx: ResolveContext) {
  if (!ctx.binding.metaAccountId) throw issue("Aucun compte Meta autorisé pour ce dashboard");
  const limit = Number(cfg.limit ?? 6);
  const accountId = ctx.binding.metaAccountId;

  const { ads, insights } = await cached(
    `meta:top-creatives:${accountId}:${ctx.since}_${ctx.until}`,
    async () => {
      const [ads, insights] = await Promise.all([
        getAds(ctx.token, accountId, 100).catch(() => []),
        getAdInsights(ctx.token, accountId, { since: ctx.since, until: ctx.until }, 100).catch(() => []),
      ]);
      return { ads, insights };
    },
  );

  const adsById = new Map(ads.map((a) => [a.id, a]));
  const creatives = [...insights]
    .sort((a, b) => toNum(b.spend) - toNum(a.spend))
    .slice(0, limit)
    .map((i) => {
      const ad = adsById.get(i.ad_id);
      const rev = computeRevenue(i, ctx.aov);
      return {
        adId: i.ad_id,
        name: i.ad_name,
        imageUrl: ad?.creative?.image_url ?? ad?.creative?.thumbnail_url ?? null,
        spend: Math.round(toNum(i.spend)),
        ctr: Math.round(toNum(i.ctr) * 100) / 100,
        hookRate: computeHookRate(i),
        roas: computeRoas(i, ctx.aov),
        cpa: computeCpa(i),
        estimated: rev.estimated,
      };
    });
  return { creatives };
}

// ── Platform overview table ──────────────────────────────────────────────────

interface PlatformStats {
  cost: number; impressions: number; ctr: number; clicks: number;
  cpc: number; cr: number; conversions: number; cpa: number;
}

function statsFrom(cost: number, impressions: number, clicks: number, conversions: number): PlatformStats {
  return {
    cost,
    impressions,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    clicks,
    cpc: clicks > 0 ? cost / clicks : 0,
    cr: clicks > 0 ? (conversions / clicks) * 100 : 0,
    conversions,
    cpa: conversions > 0 ? cost / conversions : 0,
  };
}

async function platformStats(
  source: "meta" | "google",
  ctx: ResolveContext,
  since: string,
  until: string,
): Promise<PlatformStats> {
  if (source === "meta") {
    if (!ctx.binding.metaAccountId) throw issue("Aucun compte Meta autorisé");
    const insight = await getAccountInsightsCached(ctx.token, ctx.binding.metaAccountId, { since, until });
    const purchases = insight
      ? getActionValue(insight.actions, "omni_purchase") || getActionValue(insight.actions, "purchase")
      : 0;
    return statsFrom(toNum(insight?.spend), toNum(insight?.impressions), toNum(insight?.clicks), purchases);
  }
  if (!ctx.binding.googleCustomerId) throw issue("Aucun compte Google Ads autorisé");
  const g = googleTotals(await fetchGoogleCampaignRows(ctx.binding.googleCustomerId, since, until));
  return statsFrom(g.spend, g.impressions, g.clicks, g.conversions);
}

const PLATFORM_METRIC_KEYS = ["cost", "impressions", "ctr", "clicks", "cpc", "cr", "conversions", "cpa"] as const;

function withDeltas(current: PlatformStats, previous: PlatformStats | null) {
  const row: Record<string, number | null> = {};
  for (const key of PLATFORM_METRIC_KEYS) {
    row[key] = Math.round(current[key] * 100) / 100;
    const prev = previous?.[key] ?? null;
    row[`${key}DeltaPct`] =
      prev !== null && prev > 0 ? Math.round(((current[key] - prev) / prev) * 1000) / 10 : null;
  }
  return row;
}

async function resolvePlatformTable(_cfg: Record<string, unknown>, ctx: ResolveContext) {
  const sources: Array<"meta" | "google"> = [];
  if (ctx.binding.metaAccountId) sources.push("meta");
  if (ctx.binding.googleCustomerId) sources.push("google");
  if (sources.length === 0) throw issue("Aucun compte lié à ce dashboard");

  const rows: Array<Record<string, unknown>> = [];
  const currentTotals: PlatformStats[] = [];
  const previousTotals: PlatformStats[] = [];

  for (const source of sources) {
    const current = await platformStats(source, ctx, ctx.since, ctx.until);
    let previous: PlatformStats | null = null;
    if (ctx.compare) {
      try {
        previous = await platformStats(source, ctx, ctx.compare.since, ctx.compare.until);
      } catch { /* comparison optional */ }
    }
    currentTotals.push(current);
    if (previous) previousTotals.push(previous);
    rows.push({ platform: source === "meta" ? "Meta" : "Google", ...withDeltas(current, previous) });
  }

  if (sources.length > 1) {
    const sum = (list: PlatformStats[]) =>
      statsFrom(
        list.reduce((s, x) => s + x.cost, 0),
        list.reduce((s, x) => s + x.impressions, 0),
        list.reduce((s, x) => s + x.clicks, 0),
        list.reduce((s, x) => s + x.conversions, 0),
      );
    rows.push({
      platform: "Total",
      ...withDeltas(sum(currentTotals), previousTotals.length === sources.length ? sum(previousTotals) : null),
    });
  }

  return { rows, compareKind: ctx.compare?.kind ?? null };
}

async function resolvePacing(_cfg: Record<string, unknown>, ctx: ResolveContext) {
  if (!ctx.binding.metaAccountId) throw issue("Aucun compte Meta autorisé pour ce dashboard");
  const budget = await prisma.accountBudget.findFirst({
    where: {
      userId: ctx.ownerId,
      platform: "meta",
      OR: [
        { accountId: ctx.binding.metaAccountId },
        { accountId: `act_${ctx.binding.metaAccountId}` },
      ],
    },
  });
  if (!budget) throw issue("Aucun budget mensuel configuré pour ce compte (voir /me/budgets)");
  const pacing = await computePacing(budget.accountId, budget.monthlyTarget, budget.currency);
  return pacing;
}

async function resolveWidgetData(
  type: string,
  cfg: Record<string, unknown>,
  ctx: ResolveContext,
): Promise<unknown> {
  switch (type as WidgetType) {
    case "kpi": return resolveKpi(cfg, ctx);
    case "platform_table": return resolvePlatformTable(cfg, ctx);
    case "timeseries": return resolveTimeseries(cfg, ctx);
    case "table": return resolveTable(cfg, ctx);
    case "top_creatives": return resolveTopCreatives(cfg, ctx);
    case "pacing": return resolvePacing(cfg, ctx);
    case "text": return { markdown: String(cfg.markdown ?? "") };
    default: throw issue(`Type inconnu: ${type}`);
  }
}

export async function resolveWidgets(
  dashboard: { id: string; userId: string; metaAccountId: string | null; googleCustomerId: string | null },
  widgets: Array<{ id: string; type: string; title: string | null; width: string; position: number; config: string }>,
  since: string,
  until: string,
  compare?: CompareRange | null,
): Promise<ResolvedWidget[]> {
  if (!DATE_RE.test(since) || !DATE_RE.test(until)) {
    throw new Error("since/until must be YYYY-MM-DD");
  }
  const binding = await resolveBinding(dashboard.userId, dashboard);
  const token = getMetaSystemToken();
  const aov = binding.metaAccountId ? await getAccountAov("meta", binding.metaAccountId) : 20;
  // undefined = default (previous window of equal length); null = disabled
  const effectiveCompare: CompareRange | null =
    compare === undefined ? { ...prevRange(since, until), kind: "prev" } : compare;
  const ctx: ResolveContext = {
    binding, ownerId: dashboard.userId, since, until, token, aov,
    compare: effectiveCompare,
  };

  return Promise.all(
    widgets.map(async (w): Promise<ResolvedWidget> => {
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(w.config || "{}");
      } catch { /* keep {} */ }
      const base = { id: w.id, type: w.type, title: w.title, width: w.width, position: w.position, config };
      try {
        const data = await resolveWidgetData(w.type, config, ctx);
        return { ...base, data };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { ...base, error: message };
      }
    }),
  );
}

// ── Provisioning ─────────────────────────────────────────────────────────────
// A "client" in agency vocabulary is an AD ACCOUNT (Leroy Merlin, …), not a
// login. Provisioning therefore creates ONE dashboard PER ACL ad account,
// named after the account's label — a user with several brands gets several
// dashboards.

/** Rich default widget set — the dashboard should tell the account's story
 *  out of the box: intro, KPI row with previous-period deltas, budget pacing,
 *  daily curves, top creatives and campaign/keyword tables per bound platform.
 *  Grid: "third" = 2/6, "half" = 3/6, "full" = 6/6 — the composition below
 *  always fills complete rows (no holes).
 *  `accountName` (optional) personalises the intro text widget. */
export function defaultWidgets(hasMeta: boolean, hasGoogle: boolean, accountName?: string | null): Array<{
  type: WidgetType; title: string; width: string; position: number; config: Record<string, unknown>;
}> {
  const source = hasMeta && hasGoogle ? "combined" : hasGoogle && !hasMeta ? "google" : "meta";
  const platforms = hasMeta && hasGoogle ? "Meta Ads + Google Ads" : hasMeta ? "Meta Ads" : "Google Ads";
  const intro = [
    `**Vue d'ensemble ${platforms}.**`,
    "Les chiffres couvrent la période sélectionnée en haut de page, avec comparaison automatique vs la période précédente.",
    "KPIs clés, suivi du budget, courbes quotidiennes puis détail par campagne : tout se lit de haut en bas.",
  ].join(" ");

  const w: Array<{ type: WidgetType; title: string; width: string; config: Record<string, unknown> }> = [
    // ── Intro (full) ──────────────────────────────────────────────────────
    {
      type: "text",
      title: (accountName ?? "").trim() || "Votre dashboard",
      width: "full",
      config: { markdown: intro },
    },
    // ── KPI row: 6 tiers = 2 rangées complètes ───────────────────────────
    { type: "kpi", title: "Dépenses", width: "third", config: { metric: "spend", source } },
    { type: "kpi", title: "ROAS", width: "third", config: { metric: "roas", source } },
    { type: "kpi", title: "Conversions", width: "third", config: { metric: "purchases", source } },
    { type: "kpi", title: "CPA", width: "third", config: { metric: "cpa", source } },
    { type: "kpi", title: "CPC", width: "third", config: { metric: "cpc", source } },
    { type: "kpi", title: "Taux de conversion", width: "third", config: { metric: "cr", source } },
  ];

  // ── Pacing budget (Meta uniquement : le resolver s'appuie sur AccountBudget/meta)
  if (hasMeta) {
    w.push({ type: "pacing", title: "Suivi du budget mensuel", width: "full", config: {} });
  }

  // ── Vue par plateforme (full) ───────────────────────────────────────────
  w.push({ type: "platform_table", title: "Vue par plateforme", width: "full", config: {} });

  // ── Courbes quotidiennes : toujours par paires de "half" ───────────────
  if (hasMeta && hasGoogle) {
    w.push({ type: "timeseries", title: "Dépenses quotidiennes — Meta", width: "half", config: { metric: "spend", source: "meta" } });
    w.push({ type: "timeseries", title: "Dépenses quotidiennes — Google", width: "half", config: { metric: "spend", source: "google" } });
    w.push({ type: "timeseries", title: "ROAS quotidien — Meta", width: "half", config: { metric: "roas", source: "meta" } });
    w.push({ type: "timeseries", title: "Conversions quotidiennes — Google", width: "half", config: { metric: "purchases", source: "google" } });
  } else if (hasMeta) {
    w.push({ type: "timeseries", title: "Dépenses quotidiennes", width: "half", config: { metric: "spend", source: "meta" } });
    w.push({ type: "timeseries", title: "ROAS quotidien", width: "half", config: { metric: "roas", source: "meta" } });
  } else {
    w.push({ type: "timeseries", title: "Dépenses quotidiennes", width: "half", config: { metric: "spend", source: "google" } });
    w.push({ type: "timeseries", title: "Conversions quotidiennes", width: "half", config: { metric: "purchases", source: "google" } });
  }

  // ── Tops & tables : rangées complètes ──────────────────────────────────
  if (hasMeta) {
    w.push({ type: "top_creatives", title: "Top créas Meta", width: "half", config: { limit: 6 } });
    w.push({ type: "table", title: "Campagnes Meta", width: "half", config: { kind: "campaigns", source: "meta", limit: 10 } });
  }
  if (hasGoogle) {
    w.push({ type: "table", title: "Campagnes Google Ads", width: "full", config: { kind: "campaigns", source: "google", limit: 10 } });
    w.push({ type: "table", title: "Top mots-clés", width: "half", config: { kind: "keywords", source: "google", limit: 10 } });
    w.push({ type: "table", title: "Termes de recherche", width: "half", config: { kind: "search_terms", source: "google", limit: 10 } });
  }

  return w.map((widget, position) => ({ ...widget, position }));
}

/** Grants the dashboard owner ACL rows for the dashboard's accounts, so the
 *  resolver's ACL re-check passes. Called when staff link a dashboard to a
 *  client login. */
export async function grantDashboardAccess(
  userId: string,
  dashboard: { name: string; metaAccountId: string | null; googleCustomerId: string | null },
): Promise<void> {
  const grants: Array<{ platform: string; accountId: string }> = [];
  if (dashboard.metaAccountId) grants.push({ platform: "meta", accountId: normMeta(dashboard.metaAccountId) });
  if (dashboard.googleCustomerId) grants.push({ platform: "google", accountId: normGoogle(dashboard.googleCustomerId) });
  for (const g of grants) {
    await prisma.userAdAccount.upsert({
      where: { userId_platform_accountId: { userId, platform: g.platform, accountId: g.accountId } },
      create: { userId, platform: g.platform, accountId: g.accountId, label: dashboard.name },
      update: {},
    });
  }
}

/** Staff-created dashboard explicitly bound to a client login + account(s).
 *  Also grants the matching ACL rows so the client can actually see it. */
export async function createDashboardForUser(input: {
  userId: string;
  name?: string;
  metaAccountId?: string | null;
  googleCustomerId?: string | null;
}) {
  const metaAccountId = input.metaAccountId ? normMeta(String(input.metaAccountId)) : null;
  const googleCustomerId = input.googleCustomerId ? normGoogle(String(input.googleCustomerId)) : null;
  if (!metaAccountId && !googleCustomerId) {
    throw new Error("Un compte Meta ou Google est requis");
  }
  const name = (input.name ?? "").trim() || dashboardName(null, metaAccountId ?? googleCustomerId ?? "");

  const dashboard = await prisma.dashboard.create({
    data: {
      userId: input.userId,
      name,
      metaAccountId,
      googleCustomerId,
      widgets: {
        create: defaultWidgets(!!metaAccountId, !!googleCustomerId, name).map((w) => ({
          type: w.type, title: w.title, width: w.width, position: w.position,
          config: JSON.stringify(w.config),
        })),
      },
    },
  });
  await grantDashboardAccess(input.userId, dashboard);
  return dashboard;
}

/** Replaces a dashboard's widgets with the current default set (staff action). */
export async function resetDashboardWidgets(dashboardId: string) {
  const dashboard = await prisma.dashboard.findUnique({ where: { id: dashboardId } });
  if (!dashboard) return null;
  const widgets = defaultWidgets(!!dashboard.metaAccountId, !!dashboard.googleCustomerId, dashboard.name);
  await prisma.$transaction([
    prisma.dashboardWidget.deleteMany({ where: { dashboardId } }),
    prisma.dashboardWidget.createMany({
      data: widgets.map((w) => ({
        dashboardId,
        type: w.type,
        title: w.title,
        width: w.width,
        position: w.position,
        config: JSON.stringify(w.config),
      })),
    }),
  ]);
  return dashboard;
}

function dashboardName(label: string | null, fallbackId: string): string {
  return (label ?? "").trim() || `Compte ${fallbackId}`;
}

/**
 * Ensures the user has one dashboard per ACL ad account and returns them all.
 * - each Meta account gets a dashboard named after its label; when the user
 *   has exactly one Google account it's bound alongside (cross-platform view)
 * - Google accounts not bound to a Meta dashboard get their own dashboard
 * - existing dashboards are never duplicated; generic "Pilotage" names left by
 *   the old per-user provisioning are upgraded to the account label
 */
export async function provisionDashboardsForUser(userId: string) {
  const [acl, existing] = await Promise.all([
    prisma.userAdAccount.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
    prisma.dashboard.findMany({ where: { userId } }),
  ]);
  const metas = acl.filter((a) => a.platform === "meta");
  const googles = acl.filter((a) => a.platform === "google");
  // Cross-platform pairing only when it's unambiguous (1 Meta + 1 Google);
  // otherwise each account gets its own dashboard and staff can rebind.
  const singleGoogle = metas.length === 1 && googles.length === 1 ? normGoogle(googles[0].accountId) : null;

  const boundGoogleIds = new Set(existing.map((d) => d.googleCustomerId).filter(Boolean) as string[]);

  for (const m of metas) {
    const metaId = normMeta(m.accountId);
    const current = existing.find((d) => d.metaAccountId === metaId);
    const name = dashboardName(m.label, metaId);
    if (current) {
      if (current.name === "Pilotage" && name !== "Pilotage") {
        await prisma.dashboard.update({ where: { id: current.id }, data: { name } });
      }
      continue;
    }
    const googleCustomerId = singleGoogle;
    if (googleCustomerId) boundGoogleIds.add(googleCustomerId);
    await prisma.dashboard.create({
      data: {
        userId,
        name,
        metaAccountId: metaId,
        googleCustomerId,
        widgets: {
          create: defaultWidgets(true, !!googleCustomerId, name).map((w) => ({
            type: w.type, title: w.title, width: w.width, position: w.position,
            config: JSON.stringify(w.config),
          })),
        },
      },
    });
  }

  for (const g of googles) {
    const gid = normGoogle(g.accountId);
    if (boundGoogleIds.has(gid)) continue;
    boundGoogleIds.add(gid);
    await prisma.dashboard.create({
      data: {
        userId,
        name: dashboardName(g.label, gid),
        metaAccountId: null,
        googleCustomerId: gid,
        widgets: {
          create: defaultWidgets(false, true, dashboardName(g.label, gid)).map((w) => ({
            type: w.type, title: w.title, width: w.width, position: w.position,
            config: JSON.stringify(w.config),
          })),
        },
      },
    });
  }

  return prisma.dashboard.findMany({
    where: { userId },
    orderBy: { name: "asc" },
    include: { _count: { select: { widgets: true } } },
  });
}
