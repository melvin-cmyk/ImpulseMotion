/**
 * Data snapshot for an AI client report.
 *
 * A report is generated from a frozen, self-contained JSON snapshot so the
 * AI, the chat and the printed PDF all read the exact same numbers. The
 * snapshot is assembled from the same resolvers the client dashboards use
 * (lib/dashboard-widgets) — one source of truth — plus creative-level detail
 * (hook / hold / drop-off), budget pacing, alerts and the previous report's
 * next steps so the AI can follow up on them.
 */

import { prisma } from "@/lib/prisma";
import {
  resolveBinding,
  resolveWidgets,
  prevRange,
  findHubspotSourceDashboard,
  type CompareRange,
} from "@/lib/dashboard-widgets";
import type { CrmAttributionData, CrmFunnelData } from "@/lib/crm-view";
import type { CrmAttributionDiagnostic } from "@/lib/hubspot/types";
import { getAccountAov } from "@/lib/account-settings";
import {
  getAds,
  getAdInsights,
  getMetaSystemToken,
  computeRevenue,
  computeRoas,
  computeCpa,
  computeHookRate,
  computeHoldRate,
  computeVideoDropoff,
  getActionValue,
} from "@/lib/meta-api";
import { cached } from "@/lib/kpi-cache";
import { lastCalendarMonth, lastFullDays } from "@/lib/date-ranges";
import { computePacing, type PacingResult } from "@/lib/budgets";

// ── Types (client-safe) ──────────────────────────────────────────────────────

export interface ReportKpi {
  metric: string;
  label: string;
  source: string;
  value: number;
  previous: number | null;
  deltaPct: number | null;
  estimated?: boolean;
}

export interface ReportCreative {
  adId: string;
  name: string;
  imageUrl: string | null;
  format: "video" | "image";
  spend: number;
  impressions: number;
  ctr: number;
  hookRate: number | null;
  holdRate: number | null;
  dropoff: { p25: number; p50: number; p75: number } | null;
  roas: number;
  cpa: number;
  purchases: number;
  estimated: boolean;
}

export interface ReportNextStep {
  id: string;
  title: string;
  detail: string;
  priority: "high" | "medium" | "low";
  /** crm = attribution / CRM setup action (HubSpot, UTM…) */
  platform?: "meta" | "google" | "global" | "crm";
  done: boolean;
}

/** CRM / real business section (HubSpot) — present only when the client has a HubSpot source that resolved. */
export interface ReportCrm {
  level: 0 | 1 | 2;
  currency: string | null;
  funnel: CrmFunnelData["steps"];
  ratios: CrmFunnelData["ratios"];
  bySource: CrmAttributionData["bySource"];
  /** Max 10 rows. */
  topCampaigns: CrmAttributionData["byCampaign"];
  diagnostic: CrmAttributionDiagnostic;
  warnings: string[];
}

export interface ReportData {
  client: {
    dashboardId: string;
    name: string;
    metaAccountId: string | null;
    googleCustomerId: string | null;
    platforms: Array<"meta" | "google">;
  };
  period: { since: string; until: string };
  compare: { since: string; until: string; kind: string } | null;
  kpis: ReportKpi[];
  platforms: { rows: Array<Record<string, number | string | null>>; compareKind: string | null } | null;
  daily: {
    metaSpend?: Array<{ date: string; value: number }>;
    metaRoas?: Array<{ date: string; value: number }>;
    googleSpend?: Array<{ date: string; value: number }>;
    googleConversions?: Array<{ date: string; value: number }>;
  };
  funnel: { steps: Array<{ label: string; value: number }>; rates: Array<{ label: string; pct: number }> } | null;
  demographics: Array<{ age: string; gender: string; value: number }>;
  devices: Array<{ key: string; spend: number; clicks: number; conversions: number }>;
  countries: Array<{ key: string; spend: number; clicks: number; conversions: number }>;
  campaigns: {
    meta: Array<{ name: string; spend: number; clicks: number; conversions: number; roas: number }>;
    google: Array<{ name: string; spend: number; clicks: number; conversions: number; roas: number }>;
  };
  keywords: Array<{ name: string; matchType?: string; spend: number; clicks: number; conversions: number; ctr?: number }>;
  searchTerms: Array<{ name: string; spend: number; clicks: number; conversions: number }>;
  creatives: ReportCreative[];
  pacing: PacingResult | null;
  alerts: Array<{ metric: string; value: number; threshold: number; message: string; triggeredAt: string; acknowledged: boolean }>;
  previousReport: { id: string; periodSince: string; periodUntil: string; nextSteps: ReportNextStep[] } | null;
  crm?: ReportCrm;
  warnings: string[];
  generatedAt: string;
}

const KPI_LABELS: Record<string, string> = {
  spend: "Dépenses",
  revenue: "Revenu",
  roas: "ROAS",
  cpa: "CPA",
  purchases: "Conversions",
  ctr: "CTR",
  cpc: "CPC",
  cr: "Taux de conversion",
  clicks: "Clics",
  impressions: "Impressions",
};

type SyntheticWidget = { id: string; type: string; title: string | null; width: string; position: number; config: string };

function w(id: string, type: string, config: Record<string, unknown>): SyntheticWidget {
  return { id, type, title: null, width: "half", position: 0, config: JSON.stringify(config) };
}

const toNum = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
};

// ── Creative detail (Meta) ───────────────────────────────────────────────────

async function collectCreatives(
  metaAccountId: string,
  since: string,
  until: string,
  aov: number,
  limit = 12,
): Promise<ReportCreative[]> {
  const token = getMetaSystemToken();
  const { ads, insights } = await cached(
    `meta:report-creatives:${metaAccountId}:${since}_${until}`,
    async () => {
      const [ads, insights] = await Promise.all([
        getAds(token, metaAccountId, 200).catch(() => []),
        getAdInsights(token, metaAccountId, { since, until }, 200).catch(() => []),
      ]);
      return { ads, insights };
    },
  );
  const adsById = new Map(ads.map((a) => [a.id, a]));
  return [...insights]
    .sort((a, b) => toNum(b.spend) - toNum(a.spend))
    .slice(0, limit)
    .map((i) => {
      const ad = adsById.get(i.ad_id);
      const isVideo = !!ad?.creative?.video_id || (i.video_play_actions?.length ?? 0) > 0;
      const rev = computeRevenue(i, aov);
      const purchases = getActionValue(i.actions, "omni_purchase") || getActionValue(i.actions, "purchase");
      const drop = isVideo ? computeVideoDropoff(i) : null;
      return {
        adId: i.ad_id,
        name: i.ad_name,
        imageUrl: ad?.creative?.image_url ?? ad?.creative?.thumbnail_url ?? null,
        format: isVideo ? "video" : "image",
        spend: Math.round(toNum(i.spend)),
        impressions: Math.round(toNum(i.impressions)),
        ctr: Math.round(toNum(i.ctr) * 100) / 100,
        hookRate: isVideo ? computeHookRate(i) : null,
        holdRate: isVideo ? computeHoldRate(i) : null,
        dropoff: drop,
        roas: computeRoas(i, aov),
        cpa: computeCpa(i),
        purchases: Math.round(purchases * 10) / 10,
        estimated: rev.estimated,
      };
    });
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

export async function collectReportData(
  dashboard: { id: string; userId: string; name: string; metaAccountId: string | null; googleCustomerId: string | null },
  since: string,
  until: string,
  compare: CompareRange | null | undefined,
): Promise<ReportData> {
  const binding = await resolveBinding(dashboard.userId, dashboard);
  const hasMeta = !!binding.metaAccountId;
  const hasGoogle = !!binding.googleCustomerId;
  const warnings: string[] = [];
  if (!hasMeta && !hasGoogle) throw new Error("Aucun compte publicitaire lié à ce client");

  const effectiveCompare: CompareRange | null =
    compare === undefined ? { ...prevRange(since, until), kind: "prev" } : compare;
  const source = hasMeta && hasGoogle ? "combined" : hasGoogle ? "google" : "meta";

  const widgets: SyntheticWidget[] = [];
  for (const metric of ["spend", "revenue", "roas", "purchases", "cpa", "ctr", "cpc", "cr", "clicks", "impressions"]) {
    widgets.push(w(`kpi:${metric}`, "kpi", { metric, source }));
  }
  widgets.push(w("platforms", "platform_table", {}));
  widgets.push(w("funnel", "funnel", { source }));
  if (hasMeta) {
    widgets.push(w("daily:metaSpend", "timeseries", { metric: "spend", source: "meta" }));
    widgets.push(w("daily:metaRoas", "timeseries", { metric: "roas", source: "meta" }));
    widgets.push(w("demographics", "demographics", { metric: "spend" }));
    widgets.push(w("devices", "geo_device", { source: "meta", dimension: "device" }));
    widgets.push(w("countries", "geo_device", { source: "meta", dimension: "country" }));
    widgets.push(w("campaigns:meta", "table", { kind: "campaigns", source: "meta", limit: 15 }));
    widgets.push(w("pacing", "pacing", {}));
  }
  if (hasGoogle) {
    widgets.push(w("daily:googleSpend", "timeseries", { metric: "spend", source: "google" }));
    widgets.push(w("daily:googleConversions", "timeseries", { metric: "purchases", source: "google" }));
    widgets.push(w("campaigns:google", "table", { kind: "campaigns", source: "google", limit: 15 }));
    widgets.push(w("keywords", "table", { kind: "keywords", source: "google", limit: 15 }));
    widgets.push(w("searchTerms", "table", { kind: "search_terms", source: "google", limit: 15 }));
    if (!hasMeta) widgets.push(w("devices", "geo_device", { source: "google", dimension: "device" }));
  }
  widgets.push(w("alerts", "alerts", { limit: 10 }));
  // CRM (HubSpot) only when a source is connected — same loader as the widgets.
  const hasHubspot = !!(await findHubspotSourceDashboard([dashboard.id]).catch(() => null));
  if (hasHubspot) {
    widgets.push(w("crm:funnel", "crm_funnel", {}));
    widgets.push(w("crm:attribution", "crm_attribution", { limit: 10 }));
  }

  const [resolved, aov] = await Promise.all([
    resolveWidgets(dashboard, widgets, since, until, effectiveCompare),
    binding.metaAccountId ? getAccountAov("meta", binding.metaAccountId) : Promise.resolve(20),
  ]);
  const byId = new Map(resolved.map((r) => [r.id, r]));
  const dataOf = <T,>(id: string): T | null => {
    const r = byId.get(id);
    if (!r) return null;
    if (r.error) {
      // Pacing without a configured budget is expected, not a warning.
      if (id !== "pacing") warnings.push(`${id}: ${r.error}`);
      return null;
    }
    return (r.data as T) ?? null;
  };

  const kpis: ReportKpi[] = [];
  for (const wd of widgets) {
    if (!wd.id.startsWith("kpi:")) continue;
    const d = dataOf<{ metric: string; source: string; value: number; previous: number | null; deltaPct: number | null; estimated?: boolean }>(wd.id);
    if (!d) continue;
    kpis.push({
      metric: d.metric,
      label: KPI_LABELS[d.metric] ?? d.metric,
      source: d.source,
      value: d.value,
      previous: d.previous,
      deltaPct: d.deltaPct,
      estimated: d.estimated,
    });
  }

  const series = (id: string) => dataOf<{ points: Array<{ date: string; value: number }> }>(id)?.points;
  const tableRows = <T,>(id: string) => dataOf<{ rows: T[] }>(id)?.rows ?? [];

  let creatives: ReportCreative[] = [];
  if (binding.metaAccountId) {
    try {
      creatives = await collectCreatives(binding.metaAccountId, since, until, aov);
    } catch (e) {
      warnings.push(`creatives: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Pacing: the widget resolver is owner-scoped; fall back to any budget row
  // for the account so a consultant's budget still shows up.
  let pacing = dataOf<PacingResult>("pacing");
  if (!pacing && binding.metaAccountId) {
    const budget = await prisma.accountBudget.findFirst({
      where: { platform: "meta", OR: [{ accountId: binding.metaAccountId }, { accountId: `act_${binding.metaAccountId}` }] },
    });
    if (budget) pacing = await computePacing(budget.accountId, budget.monthlyTarget, budget.currency).catch(() => null);
  }

  const prev = await prisma.clientReport.findFirst({
    where: { dashboardId: dashboard.id, status: "ready", periodUntil: { lt: until } },
    orderBy: { createdAt: "desc" },
    select: { id: true, periodSince: true, periodUntil: true, nextStepsJson: true },
  });
  let previousReport: ReportData["previousReport"] = null;
  if (prev) {
    let steps: ReportNextStep[] = [];
    try { steps = JSON.parse(prev.nextStepsJson) as ReportNextStep[]; } catch { /* ignore */ }
    previousReport = { id: prev.id, periodSince: prev.periodSince, periodUntil: prev.periodUntil, nextSteps: steps };
  }

  const platforms: Array<"meta" | "google"> = [];
  if (hasMeta) platforms.push("meta");
  if (hasGoogle) platforms.push("google");

  let crm: ReportCrm | undefined;
  if (hasHubspot) {
    const funnel = dataOf<CrmFunnelData>("crm:funnel");
    const attribution = dataOf<CrmAttributionData>("crm:attribution");
    if (funnel && attribution) crm = buildReportCrm(funnel, attribution);
  }

  return {
    client: {
      dashboardId: dashboard.id,
      name: dashboard.name,
      metaAccountId: binding.metaAccountId,
      googleCustomerId: binding.googleCustomerId,
      platforms,
    },
    period: { since, until },
    compare: effectiveCompare ? { since: effectiveCompare.since, until: effectiveCompare.until, kind: effectiveCompare.kind } : null,
    kpis,
    platforms: dataOf("platforms"),
    daily: {
      metaSpend: series("daily:metaSpend"),
      metaRoas: series("daily:metaRoas"),
      googleSpend: series("daily:googleSpend"),
      googleConversions: series("daily:googleConversions"),
    },
    funnel: dataOf("funnel"),
    demographics: tableRows<{ age: string; gender: string; value: number }>("demographics").slice(0, 10),
    devices: tableRows<{ key: string; spend: number; clicks: number; conversions: number }>("devices"),
    countries: tableRows<{ key: string; spend: number; clicks: number; conversions: number }>("countries").slice(0, 8),
    campaigns: {
      meta: tableRows("campaigns:meta"),
      google: tableRows("campaigns:google"),
    },
    keywords: tableRows("keywords"),
    searchTerms: tableRows("searchTerms"),
    creatives,
    pacing,
    alerts: (dataOf<{ events: ReportData["alerts"] }>("alerts")?.events ?? []).map((e) => ({
      metric: e.metric, value: e.value, threshold: e.threshold, message: e.message,
      triggeredAt: e.triggeredAt, acknowledged: e.acknowledged,
    })),
    previousReport,
    ...(crm ? { crm } : {}),
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

/** Pure: widget payloads → report CRM section (top 10 campaigns, deduplicated warnings). */
export function buildReportCrm(funnel: CrmFunnelData, attribution: CrmAttributionData): ReportCrm {
  return {
    level: funnel.level,
    currency: funnel.currency,
    funnel: funnel.steps,
    ratios: funnel.ratios,
    bySource: attribution.bySource,
    topCampaigns: attribution.byCampaign.slice(0, 10),
    diagnostic: attribution.diagnostic,
    warnings: [...new Set([...funnel.warnings, ...attribution.warnings])],
  };
}

// ── Period helpers ───────────────────────────────────────────────────────────

/** Last full calendar month (UTC) — delegates to lib/date-ranges. */
export function lastMonthRange(now = new Date()): { since: string; until: string } {
  return lastCalendarMonth({ now });
}

/** Last 7 full days ending yesterday (UTC) — delegates to lib/date-ranges. */
export function lastWeekRange(now = new Date()): { since: string; until: string } {
  return lastFullDays(7, { now });
}

export function periodLabel(since: string, until: string): string {
  const f = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const s = new Date(since + "T00:00:00Z");
  const u = new Date(until + "T00:00:00Z");
  const isFullMonth =
    s.getUTCDate() === 1 &&
    u.getUTCMonth() === s.getUTCMonth() &&
    u.getUTCFullYear() === s.getUTCFullYear() &&
    new Date(Date.UTC(u.getUTCFullYear(), u.getUTCMonth() + 1, 0)).getUTCDate() === u.getUTCDate();
  if (isFullMonth) {
    const m = s.toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
    return m.charAt(0).toUpperCase() + m.slice(1);
  }
  return `${f(since)} → ${f(until)}`;
}
