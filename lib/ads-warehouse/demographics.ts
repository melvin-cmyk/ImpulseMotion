/**
 * Age × gender breakdown of a creative (Motion's get_demographic_breakdown):
 * Meta insights of the creative's ads over the period, broken down by age and
 * gender, with the account's conversion event (same rule as the warehouse:
 * an account that converts in leads more than in purchases counts leads).
 * Cached 6 h.
 */

import { prisma } from "@/lib/prisma";
import { cached } from "@/lib/kpi-cache";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { getActionValue, getMetaSystemToken, metaGraphGet, purchasesFor } from "@/lib/meta-api";

export interface DemoCell { age: string; gender: "female" | "male" | "unknown"; spend: number; impressions: number; linkClicks: number; conversions: number; value: number }
export interface DemoResult { cells: DemoCell[]; conversionLabel: string }

type Row = { age?: string; gender?: string; spend?: string; impressions?: string; inline_link_clicks?: string; actions?: Array<{ action_type: string; value: string }>; action_values?: Array<{ action_type: string; value: string }> };

export async function getDemographics(accountId: string, adIds: string[], range: { since: string; until: string }): Promise<DemoResult> {
  const ids = Array.from(new Set(adIds)).sort().slice(0, 50);
  return cached(`ads:demo:meta:${accountId}:${range.since}:${range.until}:${ids.join(",")}`, async () => {
    const settings = await getAccountProfileSettings("meta", accountId);
    let event = settings.conversionEvent;
    if (event === "purchase") {
      const hist = await prisma.adDaily.aggregate({ where: { platform: "meta", accountId }, _sum: { purchases: true, leads: true } });
      if ((hist._sum.leads ?? 0) > (hist._sum.purchases ?? 0)) event = "lead";
    }
    const res = await metaGraphGet<{ data?: Row[] }>(`/act_${accountId}/insights`, getMetaSystemToken(), {
      level: "account", breakdowns: "age,gender", limit: "200",
      fields: "spend,impressions,inline_link_clicks,actions,action_values",
      time_range: JSON.stringify(range),
      filtering: JSON.stringify([{ field: "ad.id", operator: "IN", value: ids }]),
    });
    const cells: DemoCell[] = (res.data ?? []).map((r) => {
      const conversions = purchasesFor(r, event);
      const value = event === "purchase" ? getActionValue(r.action_values, "offsite_conversion.fb_pixel_purchase") || getActionValue(r.action_values, "purchase") : 0;
      const g = r.gender === "female" || r.gender === "male" ? r.gender : "unknown";
      return { age: r.age ?? "?", gender: g, spend: Number(r.spend ?? 0), impressions: Number(r.impressions ?? 0), linkClicks: Number(r.inline_link_clicks ?? 0), conversions, value };
    });
    return { cells, conversionLabel: event === "lead" ? "leads" : event === "purchase" ? "achats" : "conversions" };
  }, { ttlMs: 6 * 3600_000 });
}
