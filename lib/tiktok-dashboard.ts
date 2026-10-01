/**
 * TikTok Ads on the dashboards: the advertisers attached to a client
 * (DashboardSource kind "tiktok") read as one account by the widgets, the
 * reports, the portfolio and the pacing.
 *
 * - every advertiser is read through lib/tiktok-data (relay direct call) and
 *   the KPI cache, then summed;
 * - only advertisers of ONE currency are summed: the first attached account
 *   gives it, an account in another currency is left out with a warning
 *   (adding USD to EUR would read as a real figure);
 * - metrics follow the other platforms: spend, impressions, clicks,
 *   conversions (TikTok's optimisation event), revenue = purchase value
 *   (total_purchase_value), derived CTR / CPC / CPA / CR / ROAS.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cached, ttlForRange } from "@/lib/kpi-cache";
import {
  addStats,
  emptyTikTokStats,
  fetchTikTokCampaigns,
  fetchTikTokDaily,
  fetchTikTokTotals,
  type TikTokCampaignRow,
  type TikTokDailyRow,
  type TikTokStats,
} from "@/lib/tiktok-data";
import { normalizeAdvertiserId } from "@/lib/tiktok-accounts";

export interface TikTokBoundAccount {
  id: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
}

/** Prisma `select` of the TikTok advertisers of a dashboard with their name and settings (superset of TIKTOK_SOURCES_SELECT). */
export const TIKTOK_ACCOUNT_SOURCES_SELECT = {
  where: { kind: "tiktok", status: { not: "disabled" } },
  orderBy: { createdAt: "asc" },
  select: { kind: true, externalId: true, status: true, label: true, config: true },
} satisfies Prisma.Dashboard$sourcesArgs;

type SourceRow = { kind: string; externalId: string; status?: string | null; label?: string | null; config?: string | null };

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Pure: TikTok accounts of loaded DashboardSource rows (in service, valid id, once each, order kept). */
export function tiktokAccountsFromSources(sources: SourceRow[] | null | undefined): TikTokBoundAccount[] {
  const out: TikTokBoundAccount[] = [];
  for (const s of sources ?? []) {
    if (s.kind !== "tiktok" || s.status === "disabled") continue;
    const id = normalizeAdvertiserId(s.externalId);
    if (!id || out.some((a) => a.id === id)) continue;
    let config: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(s.config || "{}");
      if (parsed && typeof parsed === "object") config = parsed as Record<string, unknown>;
    } catch { /* keep {} */ }
    out.push({ id, name: text(s.label), currency: text(config.currency)?.toUpperCase() ?? null, timezone: text(config.timezone) });
  }
  return out;
}

/** TikTok accounts attached to a dashboard and in service (oldest first). */
export async function getDashboardTikTokAccounts(dashboardId: string): Promise<TikTokBoundAccount[]> {
  const rows = await prisma.dashboardSource.findMany({
    where: { dashboardId, ...TIKTOK_ACCOUNT_SOURCES_SELECT.where },
    orderBy: TIKTOK_ACCOUNT_SOURCES_SELECT.orderBy,
    select: TIKTOK_ACCOUNT_SOURCES_SELECT.select,
  });
  return tiktokAccountsFromSources(rows);
}

/**
 * Pure: the accounts summed together. The first account with a known currency
 * gives the currency; an account whose currency is unknown is kept, one in
 * another currency is left out with a warning.
 */
export function sameCurrencyAccounts(accounts: TikTokBoundAccount[]): { accounts: TikTokBoundAccount[]; currency: string | null; warnings: string[] } {
  const currency = accounts.find((a) => a.currency)?.currency ?? null;
  const kept: TikTokBoundAccount[] = [];
  const warnings: string[] = [];
  for (const a of accounts) {
    if (currency && a.currency && a.currency !== currency) {
      warnings.push(`Devises différentes : compte TikTok ${a.name ?? a.id} (${a.currency}) écarté, les comptes TikTok additionnés sont en ${currency}`);
    } else {
      kept.push(a);
    }
  }
  return { accounts: kept, currency, warnings };
}

/** Pure: one widget metric out of TikTok stats (names of KPI_METRICS / SERIES_METRICS). */
export function tiktokMetric(s: TikTokStats, metric: string): number {
  switch (metric) {
    case "spend": return s.spend;
    case "revenue": return s.purchaseValue;
    case "roas": return s.spend > 0 ? s.purchaseValue / s.spend : 0;
    case "purchases": return s.conversions;
    case "clicks": return s.clicks;
    case "impressions": return s.impressions;
    case "ctr": return s.impressions > 0 ? (s.clicks / s.impressions) * 100 : 0;
    case "cpc": return s.clicks > 0 ? s.spend / s.clicks : 0;
    case "cpa": return s.conversions > 0 ? s.spend / s.conversions : 0;
    case "cr": return s.clicks > 0 ? (s.conversions / s.clicks) * 100 : 0;
    default: return 0;
  }
}

/** Pure: no purchase tracked at all — a revenue / ROAS of 0 would not be a result. */
export function tiktokRevenueUnavailable(s: TikTokStats): boolean {
  return s.purchaseValue === 0 && s.purchases === 0;
}

const ttl = (since: string, until: string) => ({ ttlMs: ttlForRange({ since, until }) });

/** Totals of the advertisers over the range, summed (cached per advertiser). */
export async function tiktokTotals(ids: string[], since: string, until: string): Promise<TikTokStats> {
  const all = await Promise.all(ids.map((id) =>
    cached(`tiktok:totals:${id}:${since}_${until}`, () => fetchTikTokTotals(id, since, until), ttl(since, until)),
  ));
  return all.reduce((acc, s) => addStats(acc, s), emptyTikTokStats());
}

/** One row per day of activity, the advertisers summed, oldest first. */
export async function tiktokDaily(ids: string[], since: string, until: string): Promise<TikTokDailyRow[]> {
  const all = await Promise.all(ids.map((id) =>
    cached(`tiktok:daily:${id}:${since}_${until}`, () => fetchTikTokDaily(id, since, until), ttl(since, until)),
  ));
  const byDay = new Map<string, TikTokStats>();
  for (const rows of all) {
    for (const { date, ...stats } of rows) byDay.set(date, addStats(byDay.get(date) ?? emptyTikTokStats(), stats));
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, s]) => ({ date, ...s }));
}

/** Campaigns of every advertiser, highest spend first. */
export async function tiktokCampaigns(ids: string[], since: string, until: string): Promise<TikTokCampaignRow[]> {
  const all = await Promise.all(ids.map((id) =>
    cached(`tiktok:campaigns:${id}:${since}_${until}`, () => fetchTikTokCampaigns(id, since, until), ttl(since, until)),
  ));
  return all.flat().sort((a, b) => b.spend - a.spend);
}
