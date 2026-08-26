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
  return cached(
    `google:campaigns:${customerId}:${since}_${until}`,
    async () => {
      const raw = await relayDirectTool("mcp-google-ads.Campaign_Performance", {
        input: JSON.stringify({ customer_id: customerId, start_date: since, end_date: until }),
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

interface ResolveContext {
  binding: DashboardBinding;
  ownerId: string;
  since: string;
  until: string;
  token: string;
  aov: number;
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
    default: return { value: 0, estimated: false };
  }
}

async function resolveKpi(cfg: Record<string, unknown>, ctx: ResolveContext) {
  const metric = String(cfg.metric);
  const source = String(cfg.source ?? "meta");
  let meta = { value: 0, estimated: false };
  let google: GoogleTotals | null = null;

  if (source !== "google") {
    if (!ctx.binding.metaAccountId) throw issue("Aucun compte Meta autorisé pour ce dashboard");
    const insight = await getAccountInsightsCached(ctx.token, ctx.binding.metaAccountId, {
      since: ctx.since, until: ctx.until,
    });
    meta = metaMetricValue(insight, metric, ctx.aov);
  }
  if (source !== "meta") {
    if (!ctx.binding.googleCustomerId) throw issue("Aucun compte Google Ads autorisé pour ce dashboard");
    google = googleTotals(await fetchGoogleCampaignRows(ctx.binding.googleCustomerId, ctx.since, ctx.until));
  }

  let value = meta.value;
  if (source === "google" && google) {
    switch (metric) {
      case "spend": value = google.spend; break;
      case "revenue": value = google.revenue; break;
      case "roas": value = google.spend > 0 ? google.revenue / google.spend : 0; break;
      case "clicks": value = google.clicks; break;
      case "impressions": value = google.impressions; break;
      case "purchases": value = google.conversions; break;
      case "cpa": value = google.conversions > 0 ? google.spend / google.conversions : 0; break;
      case "ctr": value = google.impressions > 0 ? (google.clicks / google.impressions) * 100 : 0; break;
    }
  } else if (source === "combined" && google) {
    switch (metric) {
      case "spend": value = meta.value + google.spend; break;
      case "revenue": value = meta.value + google.revenue; break;
      case "clicks": value = meta.value + google.clicks; break;
      case "impressions": value = meta.value + google.impressions; break;
      case "purchases": value = meta.value + google.conversions; break;
      case "roas": {
        // recompute from combined revenue/spend
        if (!ctx.binding.metaAccountId) throw issue("Compte Meta requis pour un ROAS combiné");
        const insight = await getAccountInsightsCached(ctx.token, ctx.binding.metaAccountId, {
          since: ctx.since, until: ctx.until,
        });
        const metaSpend = toNum(insight?.spend);
        const metaRev = insight ? computeRevenue(insight, ctx.aov) : { revenue: 0, estimated: false };
        const totalSpend = metaSpend + google.spend;
        value = totalSpend > 0 ? (metaRev.revenue + google.revenue) / totalSpend : 0;
        meta.estimated = metaRev.estimated;
        break;
      }
      case "ctr": value = meta.value; break; // combined CTR is meaningless — show Meta's
      case "cpa": {
        const insight = ctx.binding.metaAccountId
          ? await getAccountInsightsCached(ctx.token, ctx.binding.metaAccountId, { since: ctx.since, until: ctx.until })
          : null;
        const metaSpend = toNum(insight?.spend);
        const purchases = getActionValue(insight?.actions, "omni_purchase") || getActionValue(insight?.actions, "purchase");
        const conv = purchases + google.conversions;
        value = conv > 0 ? (metaSpend + google.spend) / conv : 0;
        break;
      }
    }
  }

  return { metric, source, value: Math.round(value * 100) / 100, estimated: meta.estimated };
}

async function resolveTimeseries(cfg: Record<string, unknown>, ctx: ResolveContext) {
  if (!ctx.binding.metaAccountId) throw issue("Aucun compte Meta autorisé pour ce dashboard");
  const metric = String(cfg.metric);
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
  return { metric, points, estimated };
}

async function resolveTable(cfg: Record<string, unknown>, ctx: ResolveContext) {
  if (!ctx.binding.googleCustomerId) throw issue("Aucun compte Google Ads autorisé pour ce dashboard");
  const kind = String(cfg.kind);
  const limit = Number(cfg.limit ?? 10);

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
): Promise<ResolvedWidget[]> {
  if (!DATE_RE.test(since) || !DATE_RE.test(until)) {
    throw new Error("since/until must be YYYY-MM-DD");
  }
  const binding = await resolveBinding(dashboard.userId, dashboard);
  const token = getMetaSystemToken();
  const aov = binding.metaAccountId ? await getAccountAov("meta", binding.metaAccountId) : 20;
  const ctx: ResolveContext = { binding, ownerId: dashboard.userId, since, until, token, aov };

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

/** Default widget set for a dashboard, depending on which platforms it's bound to. */
export function defaultWidgets(hasMeta: boolean, hasGoogle: boolean): Array<{
  type: WidgetType; title: string; width: string; position: number; config: Record<string, unknown>;
}> {
  const source = hasMeta && hasGoogle ? "combined" : hasGoogle && !hasMeta ? "google" : "meta";
  const widgets: Array<{ type: WidgetType; title: string; width: string; position: number; config: Record<string, unknown> }> = [
    { type: "kpi", title: "Dépenses", width: "third", position: 0, config: { metric: "spend", source } },
    { type: "kpi", title: "ROAS", width: "third", position: 1, config: { metric: "roas", source } },
    { type: "kpi", title: "Conversions", width: "third", position: 2, config: { metric: "purchases", source } },
  ];
  if (hasMeta) {
    widgets.push({ type: "timeseries", title: "Dépenses quotidiennes", width: "full", position: 3, config: { metric: "spend" } });
    widgets.push({ type: "top_creatives", title: "Top créas Meta", width: hasGoogle ? "half" : "full", position: 4, config: { limit: 6 } });
  }
  if (hasGoogle) {
    widgets.push({ type: "table", title: "Campagnes Google Ads", width: hasMeta ? "half" : "full", position: 5, config: { kind: "campaigns", limit: 10 } });
  }
  return widgets;
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
          create: defaultWidgets(true, !!googleCustomerId).map((w) => ({
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
          create: defaultWidgets(false, true).map((w) => ({
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
