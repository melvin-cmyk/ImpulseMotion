/**
 * Google Ads data for alert rules — account, campaign, ad group and keyword
 * metrics over a window and its previous period, through the same relay GAQL
 * path the dashboards use (lib/dashboard-widgets: relayDirectTool + extractRows).
 * Costs are micros → units; CTR is turned into a percentage like Meta's;
 * ROAS is available only when Google reports a conversion value.
 */

import { relayDirectTool } from "@/lib/relay-tool";
import { cached, ttlForRange } from "@/lib/kpi-cache";
import { costFrom, extractRows } from "@/lib/dashboard-widgets";
import { prevRange, type DateRange } from "@/lib/date-ranges";
import { windowToRange, type ComputedMetrics } from "@/lib/alerts";
import type { EntityMetrics, AlertLevel } from "@/lib/alert-entities";

const num = (v: unknown): number => (typeof v === "number" ? v : parseFloat(String(v ?? "0"))) || 0;

/** ComputedMetrics from a GAQL row's `metrics` object (or a summed one). */
export function metricsFromGoogle(m: Record<string, unknown> | null | undefined): ComputedMetrics {
  if (!m) return { spend: 0, roas: 0, cpa: 0, ctr: 0, frequency: 0, roasAvailable: false, roasEstimated: false, conversions: 0 };
  const spend = costFrom(m);
  const conversions = num(m.conversions);
  const value = num(m.conversionsValue ?? m.conversions_value);
  const roasAvailable = value > 0;
  const roas = roasAvailable && spend > 0 ? Math.round((value / spend) * 100) / 100 : 0;
  const cpa = conversions > 0 ? Math.round((spend / conversions) * 100) / 100 : 0;
  const rawCtr = num(m.ctr);
  const ctr = Math.round((rawCtr <= 1 ? rawCtr * 100 : rawCtr) * 100) / 100;
  return { spend: Math.round(spend), roas, cpa, ctr, frequency: 0, roasAvailable, roasEstimated: false, conversions: Math.round(conversions * 100) / 100 };
}

async function gaql(customerId: string, query: string, range: DateRange, tag: string): Promise<Array<Record<string, unknown>>> {
  return cached(
    `google:alerts:${tag}:${customerId}:${range.since}_${range.until}`,
    async () => extractRows(await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", { input: JSON.stringify({ customer_id: customerId, gaql_query: query.replace(/\s+/g, " ") }) }, 25_000)),
    { ttlMs: ttlForRange(range) },
  );
}

const METRICS = "metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value, metrics.ctr";

export async function fetchGoogleAccountMetrics(customerId: string, window: string): Promise<{ current: ComputedMetrics; previous: ComputedMetrics; range: DateRange; compare: DateRange }> {
  const range = windowToRange(window);
  const compare = prevRange(range);
  const q = (r: DateRange) => `SELECT ${METRICS} FROM customer WHERE segments.date BETWEEN '${r.since}' AND '${r.until}'`;
  const [cur, prev] = await Promise.all([gaql(customerId, q(range), range, "account"), gaql(customerId, q(compare), compare, "account")]);
  const sum = (rows: Array<Record<string, unknown>>) => sumMetrics(rows.map((r) => (r.metrics as Record<string, unknown>) ?? {}));
  return { current: metricsFromGoogle(sum(cur)), previous: metricsFromGoogle(sum(prev)), range, compare };
}

/** Sums GAQL metrics objects (segment rows) into one; ctr is recomputed. */
export function sumMetrics(list: Array<Record<string, unknown>>): Record<string, unknown> | null {
  if (!list.length) return null;
  const acc = { costMicros: 0, clicks: 0, impressions: 0, conversions: 0, conversionsValue: 0 };
  for (const m of list) {
    acc.costMicros += num(m.costMicros ?? m.cost_micros);
    acc.clicks += num(m.clicks);
    acc.impressions += num(m.impressions);
    acc.conversions += num(m.conversions);
    acc.conversionsValue += num(m.conversionsValue ?? m.conversions_value);
  }
  return { ...acc, ctr: acc.impressions > 0 ? acc.clicks / acc.impressions : 0 };
}

type GoogleLevel = Extract<AlertLevel, "campaign" | "ad_group" | "keyword">;

const LEVEL_QUERY: Record<GoogleLevel, { select: string; from: string; id: (r: Record<string, unknown>) => string; name: (r: Record<string, unknown>) => string }> = {
  campaign: {
    select: "campaign.id, campaign.name",
    from: "campaign",
    id: (r) => String((r.campaign as Record<string, unknown>)?.id ?? ""),
    name: (r) => String((r.campaign as Record<string, unknown>)?.name ?? ""),
  },
  ad_group: {
    select: "ad_group.id, ad_group.name, campaign.name",
    from: "ad_group",
    id: (r) => String((r.adGroup as Record<string, unknown>)?.id ?? ""),
    name: (r) => String((r.adGroup as Record<string, unknown>)?.name ?? ""),
  },
  keyword: {
    select: "ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group.id, campaign.name",
    from: "keyword_view",
    id: (r) => `${(r.adGroup as Record<string, unknown>)?.id ?? ""}~${(r.adGroupCriterion as Record<string, unknown>)?.criterionId ?? ""}`,
    name: (r) => {
      const c = r.adGroupCriterion as Record<string, unknown> | undefined;
      const kw = c?.keyword as Record<string, unknown> | undefined;
      return String(kw?.text ?? "") + (kw?.matchType ? ` [${String(kw.matchType).toLowerCase()}]` : "");
    },
  },
};

export async function fetchGoogleEntityMetrics(customerId: string, level: GoogleLevel, window: string): Promise<{ entities: EntityMetrics[]; range: DateRange; compare: DateRange }> {
  const range = windowToRange(window);
  const compare = prevRange(range);
  const spec = LEVEL_QUERY[level];
  const q = (r: DateRange) => `SELECT ${spec.select}, ${METRICS} FROM ${spec.from} WHERE segments.date BETWEEN '${r.since}' AND '${r.until}' AND metrics.impressions > 0 ORDER BY metrics.cost_micros DESC LIMIT 500`;
  const [cur, prev] = await Promise.all([gaql(customerId, q(range), range, level), gaql(customerId, q(compare), compare, level)]);
  const prevById = new Map(prev.map((r) => [spec.id(r), (r.metrics as Record<string, unknown>) ?? {}]));
  const entities: EntityMetrics[] = cur
    .filter((r) => spec.id(r))
    .map((r) => ({
      id: spec.id(r),
      name: spec.name(r) || spec.id(r),
      level,
      current: metricsFromGoogle((r.metrics as Record<string, unknown>) ?? {}),
      previous: metricsFromGoogle(prevById.get(spec.id(r)) ?? null),
    }));
  return { entities, range, compare };
}
