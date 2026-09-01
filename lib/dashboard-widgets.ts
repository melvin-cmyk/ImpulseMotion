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
import { cached, cachedWithMeta, ttlForRange } from "@/lib/kpi-cache";
import {
  getMetaSystemToken,
  getAdsPaged,
  getAdInsightsPaged,
  getAccountDailyInsightsPaged,
  getCampaignInsightsPaged,
  getAccountBreakdownInsightsPaged,
  computeRevenue,
  computeHookRate,
  computeRoas,
  computeCpa,
  purchasesFor,
  type MetaAccountInsight,
  type MetaBreakdownInsight,
} from "@/lib/meta-api";
import { getAccountInsightsCachedWithMeta } from "@/lib/insights";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { relayDirectTool } from "@/lib/relay-tool";
import { computePacing, findBudgetForMetaAccount } from "@/lib/budgets";
import { prevRange as prevRangeOf } from "@/lib/date-ranges";

import {
  WIDGET_TYPES,
  widgetIssue as issue,
  type WidgetType,
  type ResolvedWidget,
} from "@/lib/dashboard-types";

// Re-export the client-safe surface so server code can import everything here.
export {
  WIDGET_TYPES, KPI_METRICS, SERIES_METRICS, TABLE_KINDS, WIDGET_WIDTHS,
  DEMOGRAPHICS_METRICS, GEO_DEVICE_DIMENSIONS,
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
 *  An unlinked dashboard (no Meta nor Google account) is an error — there is
 *  no more "first ACL account of the owner" fallback, which used to show a
 *  random client's numbers on an unbound dashboard. */
export async function resolveBinding(
  ownerId: string,
  dashboard: { metaAccountId: string | null; googleCustomerId: string | null },
): Promise<DashboardBinding> {
  if (!dashboard.metaAccountId && !dashboard.googleCustomerId) {
    throw issue("Ce dashboard n'est lié à aucun compte publicitaire (Meta ou Google) — liez un compte dans ses réglages");
  }
  const acl = await prisma.userAdAccount.findMany({ where: { userId: ownerId } });
  const metaIds = acl.filter((a) => a.platform === "meta").map((a) => normMeta(a.accountId));
  const googleIds = acl.filter((a) => a.platform === "google").map((a) => normGoogle(a.accountId));

  const metaAccountId =
    dashboard.metaAccountId && metaIds.includes(normMeta(dashboard.metaAccountId)) ? normMeta(dashboard.metaAccountId) : null;
  const googleCustomerId =
    dashboard.googleCustomerId && googleIds.includes(normGoogle(dashboard.googleCustomerId)) ? normGoogle(dashboard.googleCustomerId) : null;

  return { metaAccountId, googleCustomerId };
}

// ── Google fetch helpers (via relay MCP) ─────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toNum(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Explicit micros → units conversion (Google Ads `cost_micros`). No heuristic. */
export function micros(v: unknown): number {
  return toNum(v) / 1_000_000;
}

/**
 * Cost in account currency from a GAQL metrics object: `cost_micros` /
 * `costMicros` are divided by 1e6; a plain `cost` field is taken as-is.
 */
export function costFrom(m: Record<string, unknown>): number {
  if (m.costMicros !== undefined && m.costMicros !== null) return micros(m.costMicros);
  if (m.cost_micros !== undefined && m.cost_micros !== null) return micros(m.cost_micros);
  return toNum(m.cost);
}

function isRowArray(v: unknown): v is Array<Record<string, unknown>> {
  return Array.isArray(v) && v.every((r) => r !== null && typeof r === "object" && !Array.isArray(r));
}

function relayErrorMessage(obj: Record<string, unknown>): string | null {
  const e = obj.error ?? obj.errors;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const m = (e as Record<string, unknown>).message;
    return typeof m === "string" ? m : JSON.stringify(e);
  }
  if (obj.isError === true) return typeof obj.message === "string" ? obj.message : "relay error";
  return null;
}

/**
 * Normalises a relay GAQL result into rows. Accepts:
 * - an array of rows
 * - an array of `{ results: [...] }` page chunks (ALL pages are concatenated)
 * - a single `{ results | data | rows: [...] }` object
 * Throws a descriptive Error for error objects / unknown shapes so nothing
 * empty produced by a failure ever reaches the cache.
 */
export function extractRows(raw: unknown): Array<Record<string, unknown>> {
  if (raw === null || raw === undefined) throw new Error("Relay Google Ads: réponse vide (null)");
  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Relay Google Ads: réponse non-JSON: ${raw.slice(0, 120)}`);
    }
    return extractRows(parsed);
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    if (!isRowArray(raw)) throw new Error("Relay Google Ads: tableau de forme inattendue");
    // An error object anywhere in the array (a failed page) fails the whole read.
    for (const c of raw) {
      const err = relayErrorMessage(c);
      if (err) throw new Error(`Relay Google Ads: ${err}`);
    }
    const isPaged = raw.some((c) => "results" in c);
    if (isPaged) {
      const out: Array<Record<string, unknown>> = [];
      for (const c of raw) {
        if (!isRowArray(c.results)) throw new Error("Relay Google Ads: page sans tableau `results`");
        out.push(...c.results);
      }
      return out;
    }
    return raw;
  }
  if (typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const err = relayErrorMessage(r);
    if (err) throw new Error(`Relay Google Ads: ${err}`);
    const arr = r.results ?? r.data ?? r.rows;
    if (isRowArray(arr)) return arr;
    if (Array.isArray(arr)) throw new Error("Relay Google Ads: lignes de forme inattendue");
    throw new Error(`Relay Google Ads: objet sans results/data/rows (clés: ${Object.keys(r).slice(0, 6).join(",")})`);
  }
  throw new Error(`Relay Google Ads: type de réponse inattendu (${typeof raw})`);
}

interface GoogleTotals { spend: number; clicks: number; impressions: number; conversions: number; revenue: number; currency: string | null }

async function fetchGoogleCampaignRows(
  customerId: string,
  since: string,
  until: string,
): Promise<Array<Record<string, unknown>>> {
  // GAQL rather than the Campaign_Performance tool: that n8n workflow ignores
  // its start/end dates (verified: identical totals for any period), which
  // silently broke period selection and previous-period deltas.
  const query = `SELECT campaign.id, campaign.name, customer.currency_code, metrics.cost_micros, metrics.clicks,
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
    { ttlMs: ttlForRange({ since, until }) },
  );
}

/** `customer.currency_code` from the first row that carries it. */
function googleCurrency(rows: Array<Record<string, unknown>>): string | null {
  for (const row of rows) {
    const c = row.customer as Record<string, unknown> | undefined;
    const code = c?.currencyCode ?? c?.currency_code;
    if (typeof code === "string" && code) return code;
  }
  return null;
}

function googleTotals(rows: Array<Record<string, unknown>>): GoogleTotals {
  const t: GoogleTotals = { spend: 0, clicks: 0, impressions: 0, conversions: 0, revenue: 0, currency: googleCurrency(rows) };
  for (const row of rows) {
    const m = (row.metrics as Record<string, unknown>) ?? row;
    t.spend += costFrom(m);
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
    { ttlMs: ttlForRange({ since, until }) },
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
  /** Configured AOV or null → revenue "unavailable" when Meta tracks no value. */
  aov: number | null;
  /** Account currency (ISO 4217) from the Meta profile, null when unknown. */
  currency: string | null;
  /** purchase | lead | complete_registration | custom:<action_type> */
  conversionEvent: string;
  /** null = comparison disabled */
  compare: CompareRange | null;
}

/** Shape of a resolved KPI value (also returned by the kpi widget). */
export interface KpiResult {
  value: number;
  estimated: boolean;
  /** true when one platform of a combined source failed — value covers the others only */
  partial?: boolean;
  errors?: string[];
  currency?: string;
  fetchedAt?: string;
  /** revenue/roas only: no tracked value and no AOV configured */
  unavailable?: boolean;
}

function metaMetricValue(
  insight: MetaAccountInsight | null,
  metric: string,
  aov: number | null,
  conversionEvent = "purchase",
): { value: number; estimated: boolean; unavailable?: boolean } {
  if (!insight) return { value: 0, estimated: false };
  const spend = toNum(insight.spend);
  const rev = computeRevenue(insight, aov);
  const purchases = purchasesFor(insight, conversionEvent);
  switch (metric) {
    case "spend": return { value: spend, estimated: false };
    case "revenue": return { value: rev.revenue, estimated: rev.estimated, unavailable: rev.unavailable };
    case "roas": return { value: spend > 0 ? rev.revenue / spend : 0, estimated: rev.estimated, unavailable: rev.unavailable };
    case "ctr": return { value: toNum(insight.ctr), estimated: false };
    case "cpa": return { value: purchases > 0 ? spend / purchases : 0, estimated: false };
    case "purchases": return { value: purchases, estimated: false };
    case "clicks": return { value: toNum(insight.clicks), estimated: false };
    case "impressions": return { value: toNum(insight.impressions), estimated: false };
    case "cpc": {
      const clicks = toNum(insight.clicks);
      return { value: clicks > 0 ? spend / clicks : 0, estimated: false };
    }
    case "cr": {
      const clicks = toNum(insight.clicks);
      return { value: clicks > 0 ? (purchases / clicks) * 100 : 0, estimated: false };
    }
    default: return { value: 0, estimated: false };
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * One KPI value over an arbitrary range, for the widget's source.
 * - single source: any fetch error propagates (the widget shows the error);
 * - combined: one platform failing yields the other's value with
 *   `partial: true` + `errors` — never a silent 0. Both failing → throws.
 */
async function kpiValue(
  metric: string,
  source: string,
  ctx: ResolveContext,
  since: string,
  until: string,
): Promise<KpiResult> {
  const useMeta = source !== "google";
  const useGoogle = source !== "meta";
  if (useMeta && !ctx.binding.metaAccountId) throw issue("Aucun compte Meta autorisé pour ce dashboard");
  if (useGoogle && !ctx.binding.googleCustomerId) throw issue("Aucun compte Google Ads autorisé pour ce dashboard");

  const [metaRes, googleRes] = await Promise.allSettled([
    useMeta
      ? getAccountInsightsCachedWithMeta(ctx.token, ctx.binding.metaAccountId!, { since, until })
      : Promise.resolve(null),
    useGoogle
      ? fetchGoogleCampaignRows(ctx.binding.googleCustomerId!, since, until).then(googleTotals)
      : Promise.resolve(null),
  ]);

  const errors: string[] = [];
  let insight: MetaAccountInsight | null = null;
  let fetchedAt: string | undefined;
  if (metaRes.status === "fulfilled") {
    insight = metaRes.value?.data ?? null;
    fetchedAt = metaRes.value?.fetchedAt;
  } else {
    errors.push(`Meta: ${errMsg(metaRes.reason)}`);
  }
  let google: GoogleTotals | null = null;
  if (googleRes.status === "fulfilled") google = googleRes.value;
  else errors.push(`Google: ${errMsg(googleRes.reason)}`);

  const metaOk = useMeta && !!insight;
  const googleOk = useGoogle && !!google;
  if (errors.length > 0 && !metaOk && !googleOk) {
    throw new Error(errors.join(" · "));
  }
  if (errors.length > 0 && source !== "combined") {
    throw new Error(errors[0]);
  }

  const metaRev = insight ? computeRevenue(insight, ctx.aov) : { revenue: 0, estimated: false, unavailable: false };
  const metaPurchases = insight ? purchasesFor(insight, ctx.conversionEvent) : 0;
  const g = google ?? { spend: 0, clicks: 0, impressions: 0, conversions: 0, revenue: 0, currency: null };

  const spend = (metaOk ? toNum(insight?.spend) : 0) + (googleOk ? g.spend : 0);
  const revenue = (metaOk ? metaRev.revenue : 0) + (googleOk ? g.revenue : 0);
  const purchases = (metaOk ? metaPurchases : 0) + (googleOk ? g.conversions : 0);
  const clicks = (metaOk ? toNum(insight?.clicks) : 0) + (googleOk ? g.clicks : 0);
  const impressions = (metaOk ? toNum(insight?.impressions) : 0) + (googleOk ? g.impressions : 0);

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
  const isRevenueMetric = metric === "revenue" || metric === "roas";
  const estimated = metaOk && metaRev.estimated && isRevenueMetric;
  // Revenue is unavailable only when Meta is the sole contributor and has no value.
  const unavailable = isRevenueMetric && metaOk && !!metaRev.unavailable && !googleOk;

  // Currency: Meta's account currency, else Google's; flagged mismatch when both differ.
  const metaCur = metaOk ? insight?.currency ?? null : null;
  const googleCur = googleOk ? g.currency : null;
  const currency = metaCur ?? googleCur ?? ctx.currency ?? undefined;
  if (metaCur && googleCur && metaCur !== googleCur) {
    errors.push(`Devises différentes: Meta ${metaCur} / Google ${googleCur} — total non homogène`);
  }

  const out: KpiResult = { value, estimated };
  if (errors.length > 0) { out.partial = true; out.errors = errors; }
  if (currency) out.currency = currency;
  if (fetchedAt) out.fetchedAt = fetchedAt;
  if (unavailable) out.unavailable = true;
  return out;
}

/** Previous window of the same length, ending the day before `since`. */
export function prevRange(since: string, until: string): { since: string; until: string } {
  return prevRangeOf({ since, until });
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
    ...(current.partial ? { partial: true, errors: current.errors } : {}),
    ...(current.currency ? { currency: current.currency } : {}),
    ...(current.fetchedAt ? { fetchedAt: current.fetchedAt } : {}),
    ...(current.unavailable ? { unavailable: true } : {}),
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
    { ttlMs: ttlForRange({ since, until }) },
  );
}

function googleDailyMetric(row: Record<string, unknown>, metric: string): number {
  const m = (row.metrics as Record<string, unknown>) ?? row;
  const spend = costFrom(m);
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
  const { data: paged, fetchedAt } = await cachedWithMeta(
    `meta:daily:${ctx.binding.metaAccountId}:${ctx.since}_${ctx.until}`,
    () => getAccountDailyInsightsPaged(ctx.token, `act_${ctx.binding.metaAccountId}`, {
      since: ctx.since, until: ctx.until,
    }),
    { ttlMs: ttlForRange({ since: ctx.since, until: ctx.until }) },
  );
  let estimated = false;
  let unavailable = false;
  const points = paged.data.map((r) => {
    const m = metaMetricValue(r, metric, ctx.aov, ctx.conversionEvent);
    if (m.estimated) estimated = true;
    if (m.unavailable) unavailable = true;
    return { date: r.date_start, value: Math.round(m.value * 100) / 100 };
  });
  const currency = paged.data.find((r) => r.currency)?.currency ?? ctx.currency ?? undefined;
  return { metric, source, points, estimated, truncated: paged.truncated, fetchedAt, ...(currency ? { currency } : {}), ...(unavailable ? { unavailable: true } : {}) };
}

async function resolveTable(cfg: Record<string, unknown>, ctx: ResolveContext) {
  const kind = String(cfg.kind);
  const source = String(cfg.source ?? "google");
  const limit = Number(cfg.limit ?? 10);

  if (source === "meta") {
    if (!ctx.binding.metaAccountId) throw issue("Aucun compte Meta autorisé pour ce dashboard");
    const accountId = ctx.binding.metaAccountId;
    const { data: paged, fetchedAt } = await cachedWithMeta(
      `meta:campaigns:${accountId}:${ctx.since}_${ctx.until}`,
      () => getCampaignInsightsPaged(ctx.token, accountId, { since: ctx.since, until: ctx.until }),
      { ttlMs: ttlForRange({ since: ctx.since, until: ctx.until }) },
    );
    const currency = paged.data.find((r) => r.currency)?.currency ?? ctx.currency ?? undefined;
    return {
      kind,
      source,
      truncated: paged.truncated,
      fetchedAt,
      ...(currency ? { currency } : {}),
      rows: [...paged.data]
        .sort((a, b) => toNum(b.spend) - toNum(a.spend))
        .slice(0, limit)
        .map((r, i) => {
          const spend = toNum(r.spend);
          const rev = computeRevenue(r, ctx.aov);
          const purchases = purchasesFor(r, ctx.conversionEvent);
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
        const spend = costFrom(m);
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
          spend: Math.round(costFrom(m)),
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
        spend: Math.round(costFrom(m)),
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

  // Full paginated lists (max 5000 each) — errors propagate, nothing empty is cached.
  const { data: payload, fetchedAt } = await cachedWithMeta(
    `meta:top-creatives:${accountId}:${ctx.since}_${ctx.until}`,
    async () => {
      const [ads, insights] = await Promise.all([
        getAdsPaged(ctx.token, accountId, { max: 5000 }),
        getAdInsightsPaged(ctx.token, accountId, { since: ctx.since, until: ctx.until }, { max: 5000 }),
      ]);
      return { ads: ads.data, insights: insights.data, truncated: ads.truncated || insights.truncated };
    },
    { ttlMs: ttlForRange({ since: ctx.since, until: ctx.until }) },
  );

  const adsById = new Map(payload.ads.map((a) => [a.id, a]));
  const currency = payload.insights.find((i) => i.account_currency)?.account_currency ?? ctx.currency ?? undefined;
  const creatives = [...payload.insights]
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
        cpa: computeCpa(i, ctx.conversionEvent),
        estimated: rev.estimated,
        ...(rev.unavailable ? { unavailable: true } : {}),
      };
    });
  return { creatives, truncated: payload.truncated, fetchedAt, ...(currency ? { currency } : {}) };
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
    const { data: insight } = await getAccountInsightsCachedWithMeta(ctx.token, ctx.binding.metaAccountId, { since, until });
    const purchases = purchasesFor(insight, ctx.conversionEvent);
    return statsFrom(toNum(insight.spend), toNum(insight.impressions), toNum(insight.clicks), purchases);
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
  // Same lookup as the portfolio: Dashboard.monthlyBudget first, then any
  // AccountBudget for the ACCOUNT (not the owner) so /d/[id] and /portfolio agree.
  const budget = await findBudgetForMetaAccount(ctx.binding.metaAccountId, ctx.currency);
  if (!budget) throw issue("Aucun budget mensuel configuré pour ce client (fiche client → Budget mensuel)");
  return computePacing(ctx.binding.metaAccountId, budget.monthlyTarget, budget.currency, { source: budget.source });
}

// ── Funnel ───────────────────────────────────────────────────────────────────

async function resolveFunnel(cfg: Record<string, unknown>, ctx: ResolveContext) {
  const source = String(cfg.source ?? "combined");
  // Same data sources as resolveKpi; "combined" sums whatever platforms are
  // bound (a single-platform dashboard still gets its funnel).
  let insight: MetaAccountInsight | null = null;
  let google: GoogleTotals | null = null;
  const wantMeta = source === "meta" || (source === "combined" && !!ctx.binding.metaAccountId);
  const wantGoogle = source === "google" || (source === "combined" && !!ctx.binding.googleCustomerId);
  if (wantMeta && !ctx.binding.metaAccountId) throw issue("Aucun compte Meta autorisé pour ce dashboard");
  if (wantGoogle && !ctx.binding.googleCustomerId) throw issue("Aucun compte Google Ads autorisé pour ce dashboard");
  if (!wantMeta && !wantGoogle) throw issue("Aucun compte lié à ce dashboard");

  const errors: string[] = [];
  const [metaRes, googleRes] = await Promise.allSettled([
    wantMeta ? getAccountInsightsCachedWithMeta(ctx.token, ctx.binding.metaAccountId!, { since: ctx.since, until: ctx.until }) : Promise.resolve(null),
    wantGoogle ? fetchGoogleCampaignRows(ctx.binding.googleCustomerId!, ctx.since, ctx.until).then(googleTotals) : Promise.resolve(null),
  ]);
  if (metaRes.status === "fulfilled") insight = metaRes.value?.data ?? null;
  else errors.push(`Meta: ${errMsg(metaRes.reason)}`);
  if (googleRes.status === "fulfilled") google = googleRes.value;
  else errors.push(`Google: ${errMsg(googleRes.reason)}`);
  // Single source or both platforms down → error; combined with one down → partial.
  if (errors.length > 0 && (source !== "combined" || (!insight && !google))) throw new Error(errors.join(" · "));

  const metaPurchases = insight ? purchasesFor(insight, ctx.conversionEvent) : 0;
  const impressions = toNum(insight?.impressions) + (google?.impressions ?? 0);
  const clicks = toNum(insight?.clicks) + (google?.clicks ?? 0);
  const conversions = metaPurchases + (google?.conversions ?? 0);
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const cr = clicks > 0 ? (conversions / clicks) * 100 : 0;

  return {
    source,
    ...(errors.length > 0 ? { partial: true, errors } : {}),
    steps: [
      { label: "Impressions", value: Math.round(impressions) },
      { label: "Clics", value: Math.round(clicks) },
      { label: "Conversions", value: Math.round(conversions * 10) / 10 },
    ],
    rates: [
      { label: "CTR", pct: Math.round(ctr * 100) / 100 },
      { label: "Taux de conversion", pct: Math.round(cr * 100) / 100 },
    ],
  };
}

// ── Meta breakdowns (demographics / geo_device) ──────────────────────────────

function breakdownPurchases(row: MetaBreakdownInsight, conversionEvent = "purchase"): number {
  return purchasesFor(row, conversionEvent);
}

function breakdownMetricValue(row: MetaBreakdownInsight, metric: string, conversionEvent = "purchase"): number {
  switch (metric) {
    case "clicks": return toNum(row.clicks);
    case "purchases": return breakdownPurchases(row, conversionEvent);
    default: return toNum(row.spend);
  }
}

function fetchMetaBreakdown(ctx: ResolveContext, accountId: string, breakdowns: string) {
  // The fetched fields (spend,clicks,actions) never depend on the widget's
  // metric, so the cache key doesn't either.
  return cachedWithMeta(
    `meta:breakdown-${breakdowns.replace(/,/g, "-")}:${accountId}:${ctx.since}_${ctx.until}`,
    () => getAccountBreakdownInsightsPaged(ctx.token, accountId, { since: ctx.since, until: ctx.until }, breakdowns),
    { ttlMs: ttlForRange({ since: ctx.since, until: ctx.until }) },
  );
}

async function resolveDemographics(cfg: Record<string, unknown>, ctx: ResolveContext) {
  if (!ctx.binding.metaAccountId) throw issue("Compte Meta requis");
  const metric = String(cfg.metric ?? "spend");
  const { data: paged, fetchedAt } = await fetchMetaBreakdown(ctx, ctx.binding.metaAccountId, "age,gender");

  const byKey = new Map<string, { age: string; gender: string; value: number }>();
  for (const r of paged.data) {
    const age = String(r.age ?? "unknown");
    const gender = String(r.gender ?? "unknown");
    const key = `${age}|${gender}`;
    const entry = byKey.get(key) ?? { age, gender, value: 0 };
    entry.value += breakdownMetricValue(r, metric, ctx.conversionEvent);
    byKey.set(key, entry);
  }
  const out = [...byKey.values()]
    .map((e) => ({ ...e, value: Math.round(e.value * 100) / 100 }))
    .sort((a, b) => b.value - a.value);
  return { metric, rows: out, truncated: paged.truncated, fetchedAt, ...(ctx.currency ? { currency: ctx.currency } : {}) };
}

async function fetchGoogleDeviceRows(
  customerId: string,
  since: string,
  until: string,
): Promise<Array<Record<string, unknown>>> {
  const query = `SELECT segments.device, metrics.cost_micros, metrics.clicks, metrics.conversions
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}'`;
  return cached(
    `google:device:${customerId}:${since}_${until}`,
    async () => {
      const raw = await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", {
        input: JSON.stringify({ customer_id: customerId, gaql_query: query.replace(/\s+/g, " ") }),
      }, 20000);
      return extractRows(raw);
    },
    { ttlMs: ttlForRange({ since, until }) },
  );
}

interface GeoDeviceRow { key: string; spend: number; clicks: number; conversions: number }

function roundGeoDeviceRows(byKey: Map<string, GeoDeviceRow>): GeoDeviceRow[] {
  return [...byKey.values()]
    .map((e) => ({
      key: e.key,
      spend: Math.round(e.spend * 100) / 100,
      clicks: Math.round(e.clicks),
      conversions: Math.round(e.conversions * 10) / 10,
    }))
    .sort((a, b) => b.spend - a.spend);
}

async function resolveGeoDevice(cfg: Record<string, unknown>, ctx: ResolveContext) {
  const source = String(cfg.source ?? "meta");
  const dimension = String(cfg.dimension ?? "device");

  if (source === "google") {
    if (!ctx.binding.googleCustomerId) throw issue("Aucun compte Google Ads autorisé pour ce dashboard");
    if (dimension !== "device") throw issue("La source google ne supporte que dimension=device (répartition pays indisponible)");
    const rows = await fetchGoogleDeviceRows(ctx.binding.googleCustomerId, ctx.since, ctx.until);
    const byKey = new Map<string, GeoDeviceRow>();
    for (const row of rows) {
      const seg = ((row.segments as Record<string, unknown>) ?? row) as Record<string, unknown>;
      const m = ((row.metrics as Record<string, unknown>) ?? row) as Record<string, unknown>;
      const key = String(seg.device ?? "UNKNOWN").toLowerCase();
      const e = byKey.get(key) ?? { key, spend: 0, clicks: 0, conversions: 0 };
      e.spend += costFrom(m);
      e.clicks += toNum(m.clicks);
      e.conversions += toNum(m.conversions);
      byKey.set(key, e);
    }
    return { dimension, source, rows: roundGeoDeviceRows(byKey) };
  }

  if (!ctx.binding.metaAccountId) throw issue("Aucun compte Meta autorisé pour ce dashboard");
  const breakdown = dimension === "country" ? "country" : "device_platform";
  const { data: paged, fetchedAt } = await fetchMetaBreakdown(ctx, ctx.binding.metaAccountId, breakdown);
  const byKey = new Map<string, GeoDeviceRow>();
  for (const r of paged.data) {
    const key = String((dimension === "country" ? r.country : r.device_platform) ?? "unknown");
    const e = byKey.get(key) ?? { key, spend: 0, clicks: 0, conversions: 0 };
    e.spend += toNum(r.spend);
    e.clicks += toNum(r.clicks);
    e.conversions += breakdownPurchases(r, ctx.conversionEvent);
    byKey.set(key, e);
  }
  return { dimension, source, rows: roundGeoDeviceRows(byKey), truncated: paged.truncated, fetchedAt, ...(ctx.currency ? { currency: ctx.currency } : {}) };
}

// ── Alerts ───────────────────────────────────────────────────────────────────

async function resolveAlerts(cfg: Record<string, unknown>, ctx: ResolveContext) {
  const limit = Math.min(Math.max(Number(cfg.limit ?? 5) || 5, 1), 20);
  // AlertEvent.clientId stores the ad-account id; Meta ids appear with or
  // without the act_ prefix depending on which scan wrote the event.
  const clientIds: string[] = [];
  if (ctx.binding.metaAccountId) {
    clientIds.push(ctx.binding.metaAccountId, `act_${ctx.binding.metaAccountId}`);
  }
  if (ctx.binding.googleCustomerId) clientIds.push(ctx.binding.googleCustomerId);
  if (clientIds.length === 0) throw issue("Aucun compte lié à ce dashboard");

  const events = await prisma.alertEvent.findMany({
    where: { clientId: { in: clientIds } },
    orderBy: { triggeredAt: "desc" },
    take: limit,
  });
  return {
    events: events.map((e) => ({
      id: e.id,
      metric: e.metric,
      value: e.value,
      threshold: e.threshold,
      message: e.message,
      acknowledged: e.acknowledged,
      triggeredAt: e.triggeredAt.toISOString(),
    })),
  };
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
    case "funnel": return resolveFunnel(cfg, ctx);
    case "demographics": return resolveDemographics(cfg, ctx);
    case "geo_device": return resolveGeoDevice(cfg, ctx);
    case "alerts": return resolveAlerts(cfg, ctx);
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
  // Per-account profile: AOV (null = not configured → revenue unavailable),
  // currency/timezone from the Meta profile, conversion event for CPA/CR.
  const profile = binding.metaAccountId
    ? await getAccountProfileSettings("meta", binding.metaAccountId)
    : { aov: null, currency: null, timezone: null, conversionEvent: "purchase" };
  // undefined = default (previous window of equal length); null = disabled
  const effectiveCompare: CompareRange | null =
    compare === undefined ? { ...prevRange(since, until), kind: "prev" } : compare;
  const ctx: ResolveContext = {
    binding, ownerId: dashboard.userId, since, until, token,
    aov: profile.aov,
    currency: profile.currency,
    conversionEvent: profile.conversionEvent,
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
    // ── Entonnoir + alertes : rangée complète (half + half) ───────────────
    { type: "funnel", title: "Entonnoir de conversion", width: "half", config: { source } },
    { type: "alerts", title: "Dernières alertes", width: "half", config: { limit: 5 } },
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

  // ── Répartitions d'audience (Meta) : rangée complète après les courbes ─
  if (hasMeta) {
    w.push({ type: "demographics", title: "Démographie Meta", width: "half", config: { metric: "spend" } });
    w.push({ type: "geo_device", title: "Répartition par appareil", width: "half", config: { source: "meta", dimension: "device" } });
  }

  // ── Tops & tables : rangées complètes ──────────────────────────────────
  if (hasMeta) {
    w.push({ type: "top_creatives", title: "Top créas Meta", width: "half", config: { limit: 6 } });
    w.push({ type: "table", title: "Campagnes Meta", width: "half", config: { kind: "campaigns", source: "meta", limit: 10 } });
  }
  if (hasGoogle && hasMeta) {
    w.push({ type: "table", title: "Campagnes Google Ads", width: "full", config: { kind: "campaigns", source: "google", limit: 10 } });
    w.push({ type: "table", title: "Top mots-clés", width: "half", config: { kind: "keywords", source: "google", limit: 10 } });
    w.push({ type: "table", title: "Termes de recherche", width: "half", config: { kind: "search_terms", source: "google", limit: 10 } });
  } else if (hasGoogle) {
    // Google seul : la répartition appareil (half) est complétée par le
    // demi "Top mots-clés" ; "Termes de recherche" passe en full pour
    // garder des rangées complètes (nombre pair de "half").
    w.push({ type: "table", title: "Campagnes Google Ads", width: "full", config: { kind: "campaigns", source: "google", limit: 10 } });
    w.push({ type: "geo_device", title: "Répartition par appareil", width: "half", config: { source: "google", dimension: "device" } });
    w.push({ type: "table", title: "Top mots-clés", width: "half", config: { kind: "keywords", source: "google", limit: 10 } });
    w.push({ type: "table", title: "Termes de recherche", width: "full", config: { kind: "search_terms", source: "google", limit: 10 } });
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
  // Serialise per user: concurrent first loads (React strict mode, two tabs)
  // used to race past the "existing" check and create duplicate dashboards.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
    return provisionDashboardsForUserTx(tx, userId);
  }, { timeout: 30000 });
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function provisionDashboardsForUserTx(prisma: Tx, userId: string) {
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
