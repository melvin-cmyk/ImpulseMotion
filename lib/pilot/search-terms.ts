/**
 * Pilotage — the search terms of a Google Ads customer over the last days:
 * what people typed, what it cost, what it brought, in which campaign and ad
 * group. Read through the relay (GAQL), the same door as the dashboards. The
 * page offers, per term, « ajouter en négatif » on its campaign and « ajouter
 * en mot-clé » in its ad group: two ordinary Pilotage changes.
 */

import { relayDirectTool } from "@/lib/relay-tool";
import { extractRows } from "@/lib/dashboard-widgets";
import { googleCustomerDigits } from "@/lib/pilot/google";
import { parisDayOf } from "@/lib/pilot/ops";

export interface SearchTermRow {
  term: string;
  /** NONE | ADDED | EXCLUDED | ADDED_EXCLUDED — whether the term is already a keyword or a negative. */
  status: string;
  campaignId: string;
  campaignName: string;
  adGroupId: string;
  adGroupName: string;
  impressions: number;
  clicks: number;
  /** Units of the currency. */
  spend: number;
  conversions: number;
  conversionsValue: number;
}

const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "0"))) || 0;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

export async function readSearchTerms(customerId: string, days = 30, limit = 300, now: Date = new Date()): Promise<{ since: string; until: string; rows: SearchTermRow[] }> {
  const customer = googleCustomerDigits(customerId);
  if (!customer) throw new Error("Compte Google Ads invalide");
  const until = parisDayOf(new Date(now.getTime() - 86_400_000));
  const since = parisDayOf(new Date(now.getTime() - days * 86_400_000));
  const query = `SELECT search_term_view.search_term, search_term_view.status, campaign.id, campaign.name, ad_group.id, ad_group.name,
      metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
    FROM search_term_view WHERE segments.date BETWEEN '${since}' AND '${until}' AND metrics.impressions > 0
    ORDER BY metrics.cost_micros DESC LIMIT ${Math.min(Math.max(limit, 1), 1000)}`.replace(/\s+/g, " ");
  const raw = await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", { input: JSON.stringify({ customer_id: customer, gaql_query: query }) }, 40_000);
  const rows = extractRows(raw).map((r): SearchTermRow => {
    const v = obj(r.searchTermView ?? r.search_term_view);
    const c = obj(r.campaign);
    const g = obj(r.adGroup ?? r.ad_group);
    const m = obj(r.metrics);
    return {
      term: str(v.searchTerm ?? v.search_term), status: str(v.status) || "NONE",
      campaignId: str(c.id), campaignName: str(c.name), adGroupId: str(g.id), adGroupName: str(g.name),
      impressions: num(m.impressions), clicks: num(m.clicks), spend: num(m.costMicros ?? m.cost_micros) / 1_000_000,
      conversions: num(m.conversions), conversionsValue: num(m.conversionsValue ?? m.conversions_value),
    };
  }).filter((r) => r.term && r.campaignId);
  return { since, until, rows };
}
