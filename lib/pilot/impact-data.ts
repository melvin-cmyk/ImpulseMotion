/**
 * Pilotage — the figures of an object (or of the account) over a period, for
 * the impact analysis (lib/pilot/impact.ts). Meta: Graph insights of the
 * object with the account's conversion event (the same reading as the
 * dashboards); Google Ads: GAQL through the relay. No AI.
 */

import { computeRevenue, getAccountInsights, getMetaSystemToken, metaGraphGetOnce, purchasesFor } from "@/lib/meta-api";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { relayDirectTool } from "@/lib/relay-tool";
import { extractRows } from "@/lib/dashboard-widgets";
import type { Metrics, Range } from "@/lib/pilot/impact";

type Insight = {
  spend?: string; impressions?: string; clicks?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
  purchase_roas?: Array<{ action_type: string; value: string }>;
};

const n = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "0"))) || 0;

async function metaMetrics(accountId: string, insight: Insight | null): Promise<Metrics> {
  const settings = await getAccountProfileSettings("meta", accountId);
  if (!insight) return { spend: 0, conversions: 0, revenue: null, clicks: 0, impressions: 0 };
  const rev = computeRevenue({ spend: insight.spend ?? "0", actions: insight.actions, action_values: insight.action_values, purchase_roas: insight.purchase_roas } as Parameters<typeof computeRevenue>[0], settings.aov, settings.conversionEvent);
  return {
    spend: n(insight.spend),
    conversions: purchasesFor(insight, settings.conversionEvent),
    revenue: rev.unavailable ? null : rev.revenue,
    clicks: n(insight.clicks),
    impressions: n(insight.impressions),
  };
}

const META_FIELDS = "spend,impressions,clicks,actions,action_values,purchase_roas";

export async function metaObjectMetrics(accountId: string, objectId: string, range: Range): Promise<Metrics> {
  if (!/^\d{5,25}$/.test(objectId)) throw new Error("Objet Meta invalide");
  const res = await metaGraphGetOnce<{ data?: Insight[] }>(`/${objectId}/insights`, getMetaSystemToken(), {
    fields: META_FIELDS, time_range: JSON.stringify(range), limit: "1",
  });
  return metaMetrics(accountId, res.data?.[0] ?? null);
}

export async function metaAccountMetrics(accountId: string, range: Range): Promise<Metrics> {
  const insight = await getAccountInsights(getMetaSystemToken(), accountId, range);
  return metaMetrics(accountId, insight.hasData === false ? null : insight);
}

async function gaql(customer: string, query: string) {
  return extractRows(await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", { input: JSON.stringify({ customer_id: customer, gaql_query: query }) }, 30_000));
}

function googleSum(rows: Array<Record<string, unknown>>): Metrics {
  let spend = 0, conversions = 0, value = 0, clicks = 0, impressions = 0;
  for (const r of rows) {
    const m = (r.metrics ?? {}) as Record<string, unknown>;
    spend += n(m.costMicros ?? m.cost_micros) / 1_000_000;
    conversions += n(m.conversions);
    value += n(m.conversionsValue ?? m.conversions_value);
    clicks += n(m.clicks);
    impressions += n(m.impressions);
  }
  return { spend, conversions, revenue: value > 0 ? value : null, clicks, impressions };
}

const G_METRICS = "metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.clicks, metrics.impressions";
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

export async function googleObjectMetrics(customer: string, objectId: string, objectType: string, range: Range): Promise<Metrics> {
  if (!/^\d{1,25}$/.test(objectId) || !dateRe.test(range.since) || !dateRe.test(range.until)) throw new Error("Objet Google Ads invalide");
  const from = objectType === "campaign" ? "campaign" : objectType === "adset" ? "ad_group" : null;
  if (!from) throw new Error("Niveau non lu sur Google Ads");
  const rows = await gaql(customer, `SELECT ${from}.id, ${G_METRICS} FROM ${from} WHERE ${from}.id = ${objectId} AND segments.date BETWEEN '${range.since}' AND '${range.until}'`);
  return googleSum(rows);
}

export async function googleAccountMetrics(customer: string, range: Range): Promise<Metrics> {
  if (!dateRe.test(range.since) || !dateRe.test(range.until)) throw new Error("Période invalide");
  return googleSum(await gaql(customer, `SELECT ${G_METRICS} FROM customer WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'`));
}
