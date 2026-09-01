/**
 * CRM view — pure derivation of the HubSpot snapshot + ad spend into the
 * shapes consumed by the `crm_funnel` / `crm_attribution` widgets, the AI
 * report (ReportData.crm) and the portfolio (PortfolioClient.crm).
 *
 * Rules:
 * - every ratio is `null` (never 0) when its denominator is missing or zero,
 *   or when the spend it needs is unavailable;
 * - spend per source: PAID_SOCIAL ⇔ Meta, PAID_SEARCH ⇔ Google, others null;
 * - spend per campaign: only for rows matched to a known Meta / Google campaign;
 * - currencies: ad spend and CRM amounts may differ (deal currency vs account
 *   currency). When both are known and differ, every "real ROAS" is null and a
 *   warning explains why — we never divide EUR by ZAR silently.
 */

import { SOURCE_LABELS_FR } from "@/lib/hubspot/aggregate";
import type { CrmAttributionDiagnostic, CrmBucket, CrmSnapshot, CrmSource } from "@/lib/hubspot/types";

// ── Contract shapes (C1 ⇄ C2) ────────────────────────────────────────────────

export type CrmLevel = 0 | 1 | 2;

export interface CrmFunnelStep {
  key: "spend" | "leads" | "qualified" | "deals" | "won";
  label: string;
  value: number;
  unit: "currency" | "count";
}

export interface CrmRatios {
  /** spend / contacts */
  cpl: number | null;
  /** spend / qualified contacts */
  cplQualified: number | null;
  /** spend / deals created */
  costPerDeal: number | null;
  /** spend / deals won */
  costPerWon: number | null;
  /** won amount / spend */
  realRoas: number | null;
  /** deals won / deals created, in percent (0-100) */
  winRate: number | null;
}

export interface CrmFunnelData {
  level: CrmLevel;
  currency: string | null;
  fetchedAt: string;
  partial: boolean;
  warnings: string[];
  /** `spend` step is absent when ad spend is unavailable. */
  steps: CrmFunnelStep[];
  ratios: CrmRatios;
}

export interface CrmSourceRow {
  source: CrmSource;
  label: string;
  contacts: number;
  qualified: number;
  dealsWon: number;
  wonAmount: number;
  /** Only PAID_SOCIAL (Meta) and PAID_SEARCH (Google); null otherwise / when unavailable. */
  spend: number | null;
  cpl: number | null;
  realRoas: number | null;
}

export interface CrmCampaignView {
  campaign: string;
  source: CrmSource;
  matched: { platform: "meta" | "google"; campaignName: string } | null;
  contacts: number;
  qualified: number;
  dealsWon: number;
  wonAmount: number;
  /** Spend of the matched ad campaign; null when unmatched / unknown. */
  spend: number | null;
  cpl: number | null;
  realRoas: number | null;
}

export interface CrmAttributionData {
  level: CrmLevel;
  currency: string | null;
  fetchedAt: string;
  partial: boolean;
  warnings: string[];
  bySource: CrmSourceRow[];
  byCampaign: CrmCampaignView[];
  diagnostic: CrmAttributionDiagnostic;
}

/** Compact summary for the portfolio row (PortfolioClient.crm minus `error`). */
export interface CrmSummary {
  level: CrmLevel;
  contacts: number;
  qualified: number;
  won: number;
  wonAmount: number;
  currency: string | null;
  cplQualified: number | null;
  realRoas: number | null;
  fetchedAt: string;
  partial: boolean;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface CrmSpendByPlatform {
  /** Meta spend over the period; null when the platform is not bound or its fetch failed. */
  meta: number | null;
  /** Google Ads spend over the period; null when not bound / failed. */
  google: number | null;
  /** ISO 4217 of the ad spend (Meta account currency, else Google), null when unknown. */
  currency: string | null;
}

export interface CrmSpendByCampaign {
  platform: "meta" | "google";
  /** Campaign name as reported by the ad platform (matched by exact name). */
  name: string;
  spend: number;
}

export interface CrmView {
  funnel: CrmFunnelData;
  attribution: CrmAttributionData;
  summary: CrmSummary;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

/** numerator / denominator rounded to 2 decimals; null when either side is unusable. */
export function ratio(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (numerator === null || numerator === undefined || denominator === null || denominator === undefined) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return round2(numerator / denominator);
}

/** Sum of the available platform spends; null when none is available. */
export function totalSpend(spend: CrmSpendByPlatform): number | null {
  if (spend.meta === null && spend.google === null) return null;
  return round2((spend.meta ?? 0) + (spend.google ?? 0));
}

export function spendForSource(source: CrmSource, spend: CrmSpendByPlatform): number | null {
  if (source === "PAID_SOCIAL") return spend.meta;
  if (source === "PAID_SEARCH") return spend.google;
  return null;
}

/** Same normalisation family as the aggregator: case / accent / punctuation insensitive. */
function campaignKey(platform: string, name: string): string {
  return `${platform}:${name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")}`;
}

export function sourceLabel(source: CrmSource): string {
  return SOURCE_LABELS_FR[source] ?? source;
}

const STEP_LABELS: Record<CrmFunnelStep["key"], string> = {
  spend: "Dépense pub",
  leads: "Leads",
  qualified: "Leads qualifiés",
  deals: "Deals créés",
  won: "Deals gagnés",
};

function bucketRatios(b: CrmBucket, spend: number | null, roasAllowed: boolean): CrmRatios {
  return {
    cpl: ratio(spend, b.contacts),
    cplQualified: ratio(spend, b.qualified),
    costPerDeal: ratio(spend, b.dealsCreated),
    costPerWon: ratio(spend, b.dealsWon),
    realRoas: roasAllowed ? ratio(b.wonAmount, spend) : null,
    winRate: b.dealsCreated > 0 ? round2((b.dealsWon / b.dealsCreated) * 100) : null,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

export interface BuildCrmViewOptions {
  /** Max campaign rows in `attribution.byCampaign` (default 10). */
  limit?: number;
}

/**
 * Pure: snapshot + ad spend → widgets / report / portfolio shapes.
 * Never throws on data (only on a non-object snapshot, which is a bug).
 */
export function buildCrmView(
  snapshot: CrmSnapshot,
  spendByPlatform: CrmSpendByPlatform,
  spendByCampaign: CrmSpendByCampaign[] = [],
  opts: BuildCrmViewOptions = {},
): CrmView {
  const limit = Math.max(1, Math.floor(opts.limit ?? 10));
  const warnings = [...(snapshot.warnings ?? [])];
  const level = snapshot.diagnostic.level;
  const spend = totalSpend(spendByPlatform);

  // Currency: ratios are spend-based → the ad currency leads; CRM amounts fall back.
  const adCurrency = spendByPlatform.currency;
  const crmCurrency = snapshot.currency;
  const currency = adCurrency ?? crmCurrency ?? null;
  const currencyMismatch = !!adCurrency && !!crmCurrency && adCurrency !== crmCurrency;
  if (currencyMismatch) {
    warnings.push(`Devises différentes : CRM ${crmCurrency} / publicité ${adCurrency} — ROAS réel non calculé.`);
  }
  if (spend === null) {
    warnings.push("Dépense publicitaire indisponible sur la période : CPL et ROAS réel non calculés.");
  }
  const roasAllowed = !currencyMismatch;

  const t = snapshot.totals;
  const steps: CrmFunnelStep[] = [];
  if (spend !== null) steps.push({ key: "spend", label: STEP_LABELS.spend, value: spend, unit: "currency" });
  steps.push({ key: "leads", label: STEP_LABELS.leads, value: t.contacts, unit: "count" });
  steps.push({ key: "qualified", label: STEP_LABELS.qualified, value: t.qualified, unit: "count" });
  steps.push({ key: "deals", label: STEP_LABELS.deals, value: t.dealsCreated, unit: "count" });
  steps.push({ key: "won", label: STEP_LABELS.won, value: t.dealsWon, unit: "count" });
  const ratios = bucketRatios(t, spend, roasAllowed);

  const funnel: CrmFunnelData = {
    level,
    currency,
    fetchedAt: snapshot.fetchedAt,
    partial: snapshot.partial,
    warnings,
    steps,
    ratios,
  };

  // By source: only sources present in the snapshot, contacts desc then won amount.
  const bySource: CrmSourceRow[] = (Object.entries(snapshot.bySource) as Array<[CrmSource, CrmBucket | undefined]>)
    .filter((e): e is [CrmSource, CrmBucket] => !!e[1])
    .map(([source, b]) => {
      const s = spendForSource(source, spendByPlatform);
      return {
        source,
        label: sourceLabel(source),
        contacts: b.contacts,
        qualified: b.qualified,
        dealsWon: b.dealsWon,
        wonAmount: round2(b.wonAmount),
        spend: s === null ? null : round2(s),
        cpl: ratio(s, b.contacts),
        realRoas: roasAllowed ? ratio(b.wonAmount, s) : null,
      };
    })
    .sort((a, b) => b.contacts - a.contacts || b.wonAmount - a.wonAmount || a.source.localeCompare(b.source));

  // By campaign: spend only for matched rows (exact platform + normalised name).
  const spendIndex = new Map<string, number>();
  for (const c of spendByCampaign) {
    const k = campaignKey(c.platform, c.name);
    spendIndex.set(k, (spendIndex.get(k) ?? 0) + c.spend);
  }
  const byCampaign: CrmCampaignView[] = snapshot.byCampaign
    .map((row) => {
      const s = row.matched ? spendIndex.get(campaignKey(row.matched.platform, row.matched.campaignName)) ?? null : null;
      return {
        campaign: row.campaign,
        source: row.source,
        matched: row.matched,
        contacts: row.contacts,
        qualified: row.qualified,
        dealsWon: row.dealsWon,
        wonAmount: round2(row.wonAmount),
        spend: s === null ? null : round2(s),
        cpl: ratio(s, row.contacts),
        realRoas: roasAllowed ? ratio(row.wonAmount, s) : null,
      };
    })
    .sort((a, b) => b.contacts - a.contacts || b.wonAmount - a.wonAmount || a.campaign.localeCompare(b.campaign))
    .slice(0, limit);

  const attribution: CrmAttributionData = {
    level,
    currency,
    fetchedAt: snapshot.fetchedAt,
    partial: snapshot.partial,
    warnings,
    bySource,
    byCampaign,
    diagnostic: snapshot.diagnostic,
  };

  const summary: CrmSummary = {
    level,
    contacts: t.contacts,
    qualified: t.qualified,
    won: t.dealsWon,
    wonAmount: round2(t.wonAmount),
    currency,
    cplQualified: ratios.cplQualified,
    realRoas: ratios.realRoas,
    fetchedAt: snapshot.fetchedAt,
    partial: snapshot.partial,
  };

  return { funnel, attribution, summary };
}
