/**
 * Shared, pure aggregation helpers for the Analyse Ads pages.
 *
 * Every ratio is recomputed from the raw sums (clicks / impressions,
 * spend / conversions, revenue / spend) so groups are weighted by volume and
 * never by an average-of-averages. When a ratio can't be computed from real
 * fields it is `null` — callers must render "—", never a made-up value.
 */

import type { Creative } from "./creative-types";
import { parseSegmentValue, type NamingConfig } from "./naming-config";

export interface AggregateStats {
  count: number;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  /** clicks / impressions × 100, null without impressions */
  ctr: number | null;
  /** spend / conversions, null without conversions */
  cpa: number | null;
  /** revenue / spend, null without spend */
  roas: number | null;
  /** conversions / clicks × 100, null without clicks */
  conversionRate: number | null;
  /** Impression-weighted 3s hook rate over Video creatives only, null without videos */
  hookRate: number | null;
  /** Number of Video creatives contributing to hookRate */
  videoCount: number;
  /** Σ impressions / Σ reach over creatives exposing reach, null otherwise */
  frequency: number | null;
  /** Creatives labelled "Winner" (derived status, not a Meta field) */
  winners: number;
  /** winners / count × 100 */
  hitRate: number;
  /** True when at least one contributing creative's ROAS was estimated from AOV */
  estimated: boolean;
  /** True when no creative with spend has a known revenue (roas is then null) */
  unavailable: boolean;
}

export interface Group<T = Record<string, never>> {
  key: string;
  label: string;
  creatives: Creative[];
  stats: AggregateStats;
  /** Group-specific extra fields (url, body, headline…) */
  meta: T;
}

export const EMPTY_STATS: AggregateStats = {
  count: 0,
  spend: 0,
  impressions: 0,
  clicks: 0,
  conversions: 0,
  revenue: 0,
  ctr: null,
  cpa: null,
  roas: null,
  conversionRate: null,
  hookRate: null,
  videoCount: 0,
  frequency: null,
  winners: 0,
  hitRate: 0,
  estimated: false,
  unavailable: false,
};

function num(v: number | undefined | null): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** True when the creative's revenue is unknown (no tracked value, no AOV) — its ROAS is null. */
export function revenueUnknown(c: Creative): boolean {
  if (c.roasUnavailable) return true;
  return !(typeof c.revenue === "number" && Number.isFinite(c.revenue)) && (c.roas === null || c.roas === undefined);
}

/** Revenue of a single creative: real `revenue` when present, else roas × spend (the definition); 0 when unknown. */
export function creativeRevenue(c: Creative): number {
  if (revenueUnknown(c)) return 0;
  if (typeof c.revenue === "number" && Number.isFinite(c.revenue)) return c.revenue;
  return num(c.roas) * num(c.spend);
}

export function aggregate(creatives: Creative[]): AggregateStats {
  if (creatives.length === 0) return EMPTY_STATS;

  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let conversions = 0;
  let revenue = 0;
  let hookWeighted = 0;
  let hookImpressions = 0;
  let videoCount = 0;
  let reachSum = 0;
  let reachImpressions = 0;
  let winners = 0;
  let estimated = false;
  // Spend of the creatives whose revenue is known — the ROAS denominator.
  let knownSpend = 0;

  for (const c of creatives) {
    spend += num(c.spend);
    impressions += num(c.impressions);
    clicks += num(c.clicks);
    conversions += num(c.conversions);
    if (!revenueUnknown(c)) {
      revenue += creativeRevenue(c);
      knownSpend += num(c.spend);
      if (c.roasEstimated) estimated = true;
    }
    if (c.status === "Winner") winners++;
    if (c.format === "Video") {
      videoCount++;
      const imp = num(c.impressions);
      if (imp > 0) {
        hookWeighted += num(c.hookRate) * imp;
        hookImpressions += imp;
      }
    }
    const reach = num(c.reach);
    if (reach > 0) {
      reachSum += reach;
      reachImpressions += num(c.impressions);
    }
  }

  const round2 = (v: number) => Math.round(v * 100) / 100;
  const count = creatives.length;

  return {
    count,
    spend: round2(spend),
    impressions,
    clicks,
    conversions,
    revenue: round2(revenue),
    ctr: impressions > 0 ? round2((clicks / impressions) * 100) : null,
    cpa: conversions > 0 ? round2(spend / conversions) : null,
    roas: knownSpend > 0 ? round2(revenue / knownSpend) : null,
    conversionRate: clicks > 0 ? round2((conversions / clicks) * 100) : null,
    hookRate: hookImpressions > 0 ? round2(hookWeighted / hookImpressions) : null,
    videoCount,
    frequency: reachSum > 0 ? round2(reachImpressions / reachSum) : null,
    winners,
    hitRate: count > 0 ? round2((winners / count) * 100) : 0,
    estimated,
    unavailable: spend > 0 && knownSpend === 0,
  };
}

export interface GroupKey<T = Record<string, never>> {
  key: string;
  label: string;
  meta?: T;
}

export interface GroupByOptions {
  /** Keys that must always be sorted last (e.g. "Sans texte", "URL non disponible"). */
  lastKeys?: string[];
}

/**
 * Generic grouping. Groups are sorted by spend desc; `lastKeys` are pinned to
 * the end regardless of spend. The first creative's `meta` wins for the group.
 */
export function groupBy<T = Record<string, never>>(
  creatives: Creative[],
  keyFn: (c: Creative) => GroupKey<T> | string,
  options: GroupByOptions = {},
): Group<T>[] {
  const map = new Map<string, { label: string; meta: T; creatives: Creative[] }>();

  for (const c of creatives) {
    const k = keyFn(c);
    const key = typeof k === "string" ? k : k.key;
    const label = typeof k === "string" ? k : k.label;
    const meta = (typeof k === "string" ? undefined : k.meta) ?? ({} as T);
    const existing = map.get(key);
    if (existing) existing.creatives.push(c);
    else map.set(key, { label, meta, creatives: [c] });
  }

  const last = new Set(options.lastKeys ?? []);
  const groups: Group<T>[] = Array.from(map.entries()).map(([key, g]) => ({
    key,
    label: g.label,
    creatives: g.creatives,
    stats: aggregate(g.creatives),
    meta: g.meta,
  }));

  return groups.sort((a, b) => {
    const aLast = last.has(a.key);
    const bLast = last.has(b.key);
    if (aLast !== bLast) return aLast ? 1 : -1;
    return b.stats.spend - a.stats.spend;
  });
}

// ── Dimension helpers ────────────────────────────────────────────────────────

export function byFormat(creatives: Creative[]): Group[] {
  return groupBy(creatives, (c) => c.format);
}

export function byStatus(creatives: Creative[]): Group[] {
  return groupBy(creatives, (c) => c.status);
}

export const NO_ADSET_KEY = "__no_adset__";
export const NO_CAMPAIGN_KEY = "__no_campaign__";

export function byAdset(creatives: Creative[]): Group[] {
  return groupBy(
    creatives,
    (c) => {
      const key = c.adsetId ?? c.adsetName;
      if (!key) return { key: NO_ADSET_KEY, label: "Adset inconnu" };
      return { key, label: c.adsetName ?? c.adsetId ?? "Adset inconnu" };
    },
    { lastKeys: [NO_ADSET_KEY] },
  );
}

export function byCampaign(creatives: Creative[]): Group[] {
  return groupBy(
    creatives,
    (c) => {
      const key = c.campaignId ?? c.campaignName;
      if (!key) return { key: NO_CAMPAIGN_KEY, label: "Campagne inconnue" };
      return { key, label: c.campaignName ?? c.campaignId ?? "Campagne inconnue" };
    },
    { lastKeys: [NO_CAMPAIGN_KEY] },
  );
}

// ── Landing pages ────────────────────────────────────────────────────────────

export const NO_URL_KEY = "__no_url__";
export const NO_URL_LABEL = "URL non disponible";

export interface LandingPageMeta {
  /** Canonical clickable URL (https://host/path) or null for the unknown bucket */
  url: string | null;
  host: string | null;
  path: string | null;
}

/**
 * Normalise a landing URL to a grouping key: lowercase host (www. stripped),
 * lowercase path without trailing slash, query/hash removed. Returns null for
 * empty or unparsable input.
 */
export function normalizeLandingUrl(raw: string | undefined | null): LandingPageMeta | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return null;
  let path = decodeURIComponent(parsed.pathname).toLowerCase();
  path = path.replace(/\/+$/, "");
  if (path === "") path = "/";
  return { url: `https://${host}${path === "/" ? "/" : path}`, host, path };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function landingLabel(meta: LandingPageMeta, max = 60): string {
  if (!meta.host) return NO_URL_LABEL;
  return truncate(`${meta.host}${meta.path === "/" ? "" : meta.path}`, max);
}

export function byLandingPage(creatives: Creative[]): Group<LandingPageMeta>[] {
  return groupBy<LandingPageMeta>(
    creatives,
    (c) => {
      const meta = normalizeLandingUrl(c.landingUrl);
      if (!meta) {
        return { key: NO_URL_KEY, label: NO_URL_LABEL, meta: { url: null, host: null, path: null } };
      }
      return { key: `${meta.host}${meta.path}`, label: landingLabel(meta), meta };
    },
    { lastKeys: [NO_URL_KEY] },
  );
}

// ── Copy (body / headline) ───────────────────────────────────────────────────

export const NO_COPY_KEY = "__no_copy__";
export const NO_COPY_LABEL = "Sans texte";
const COPY_KEY_MAX = 400;

export interface CopyMeta {
  /** Full primary text (first creative's original casing), null for the "Sans texte" bucket */
  body: string | null;
  /** Most frequent headline in the group, null when none */
  headline: string | null;
  /** True when the group is keyed on the headline (no body available) */
  headlineOnly: boolean;
}

export function normalizeCopy(text: string | undefined | null): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

export function copyKey(c: Creative): { key: string; source: "body" | "headline" | null } {
  const body = normalizeCopy(c.body);
  if (body) return { key: body.toLowerCase().slice(0, COPY_KEY_MAX), source: "body" };
  const headline = normalizeCopy(c.headline);
  if (headline) return { key: `h:${headline.toLowerCase()}`, source: "headline" };
  return { key: NO_COPY_KEY, source: null };
}

export function byCopy(creatives: Creative[]): Group<CopyMeta>[] {
  const groups = groupBy<CopyMeta>(
    creatives,
    (c) => {
      const { key, source } = copyKey(c);
      if (source === null) {
        return { key, label: NO_COPY_LABEL, meta: { body: null, headline: null, headlineOnly: false } };
      }
      if (source === "headline") {
        const headline = normalizeCopy(c.headline);
        return { key, label: truncate(headline, 80), meta: { body: null, headline, headlineOnly: true } };
      }
      const body = normalizeCopy(c.body);
      return { key, label: truncate(body, 80), meta: { body: c.body?.trim() ?? body, headline: null, headlineOnly: false } };
    },
    { lastKeys: [NO_COPY_KEY] },
  );

  // Resolve the dominant headline per group (creatives sharing a body may use several headlines).
  for (const g of groups) {
    if (g.key === NO_COPY_KEY || g.meta.headlineOnly) continue;
    const counts = new Map<string, number>();
    for (const c of g.creatives) {
      const h = normalizeCopy(c.headline);
      if (!h) continue;
      counts.set(h, (counts.get(h) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [h, n] of counts) {
      if (n > bestCount) {
        best = h;
        bestCount = n;
      }
    }
    g.meta = { ...g.meta, headline: best };
  }

  return groups;
}

// ── Naming segments ──────────────────────────────────────────────────────────

export const UNCATEGORIZED_KEY = "Unknown";
export const UNCATEGORIZED_LABEL = "Non catégorisé";

export function bySegment(creatives: Creative[], config: NamingConfig, segmentIndex: number): Group[] {
  const seg = config.segments[segmentIndex];
  if (!seg) return [];
  return groupBy(
    creatives,
    (c) => {
      const value = parseSegmentValue(c.name, seg.position, config.separator);
      if (value === UNCATEGORIZED_KEY) return { key: UNCATEGORIZED_KEY, label: UNCATEGORIZED_LABEL };
      return value;
    },
    { lastKeys: [UNCATEGORIZED_KEY] },
  );
}

/**
 * Index of the segment whose label matches `pattern`, else the last segment,
 * else -1 when the config has no segments.
 */
export function findSegmentIndex(config: NamingConfig, pattern: RegExp): number {
  const idx = config.segments.findIndex((s) => pattern.test(s.label));
  if (idx >= 0) return idx;
  return config.segments.length - 1;
}

// ── Ranking helpers ──────────────────────────────────────────────────────────

export type RankMetric = "spend" | "roas" | "ctr" | "cpa" | "conversions";

/** Best creative for a metric (lower CPA wins; CPA requires conversions > 0). */
export function bestCreative(creatives: Creative[], metric: RankMetric): Creative | null {
  const pool = metric === "cpa" ? creatives.filter((c) => c.conversions > 0 && c.cpa > 0) : creatives;
  if (pool.length === 0) return null;
  return pool.reduce((best, c) =>
    metric === "cpa" ? (c.cpa < best.cpa ? c : best) : num(c[metric]) > num(best[metric]) ? c : best,
  );
}

/** Worst creative for a metric (higher CPA loses; requires conversions for CPA). */
export function worstCreative(creatives: Creative[], metric: RankMetric): Creative | null {
  const pool = metric === "cpa" ? creatives.filter((c) => c.conversions > 0 && c.cpa > 0) : creatives;
  if (pool.length === 0) return null;
  return pool.reduce((worst, c) =>
    metric === "cpa" ? (c.cpa > worst.cpa ? c : worst) : num(c[metric]) < num(worst[metric]) ? c : worst,
  );
}

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid];
}

/**
 * Sort groups by a stat. Null stats always sort last; CPA ascending is "best first".
 */
export function sortGroups<T>(groups: Group<T>[], metric: RankMetric | "count", asc = false): Group<T>[] {
  const val = (g: Group<T>): number | null =>
    metric === "count" ? g.stats.count : g.stats[metric];
  return [...groups].sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return asc ? av - bv : bv - av;
  });
}

// ── Frequency ────────────────────────────────────────────────────────────────

/**
 * Frequency normalised per 7 days so a 90-day window is comparable to a
 * 7-day one: `frequency × 7 / rangeDays`. Null when either input is missing.
 */
export function weeklyFrequency(frequency: number | null | undefined, rangeDays: number): number | null {
  if (typeof frequency !== "number" || !Number.isFinite(frequency) || frequency <= 0) return null;
  if (!Number.isFinite(rangeDays) || rangeDays <= 0) return null;
  return Math.round(((frequency * 7) / rangeDays) * 100) / 100;
}

// ── Status (relative to the account) ─────────────────────────────────────────

/** Weekly frequency at/above which a creative is considered saturated. */
export const FATIGUE_FREQUENCY_WEEKLY = 3.5;
/** Video hook rate (plays / impressions, %) below which a video is considered fatigued. */
export const FATIGUE_HOOK_RATE = 20;

/** Minimal per-ad inputs for the status rules (a Creative satisfies it). */
export interface StatusInput {
  spend: number;
  conversions: number;
  cpa: number;
  roas: number | null;
  roasEstimated?: boolean;
  roasUnavailable?: boolean;
  format: string;
  hookRate: number;
  frequencyWeekly?: number | null;
}

/** Account-level reference used by `classifyStatus`. Built by `accountReference`. */
export interface AccountReference {
  spend: number;
  conversions: number;
  /** spend / conversions, null without conversions */
  cpa: number | null;
  /** Account ROAS from KNOWN (non-estimated) revenue only, null otherwise */
  roas: number | null;
  /** Median spend of the ads with spend > 0 */
  medianSpend: number;
  /** max(3 % of account spend, 5 × median spend) — "significant" spend */
  spendThreshold: number;
}

/**
 * Reference totals for the status rules. Σ then ratio (never average of
 * ratios). Only tracked (non-estimated, non-unavailable) revenue feeds the
 * account ROAS so an estimated ROAS can never create a Winner/Loser.
 */
export function accountReference(rows: StatusInput[]): AccountReference {
  let spend = 0;
  let conversions = 0;
  let trackedRevenue = 0;
  let trackedSpend = 0;
  const spends: number[] = [];
  for (const r of rows) {
    const s = num(r.spend);
    spend += s;
    conversions += num(r.conversions);
    if (s > 0) spends.push(s);
    if (r.roas !== null && r.roas !== undefined && !r.roasEstimated && !r.roasUnavailable && s > 0) {
      trackedRevenue += r.roas * s;
      trackedSpend += s;
    }
  }
  const medianSpend = median(spends) ?? 0;
  return {
    spend,
    conversions,
    cpa: conversions > 0 ? spend / conversions : null,
    roas: trackedSpend > 0 && trackedRevenue > 0 ? trackedRevenue / trackedSpend : null,
    medianSpend,
    spendThreshold: Math.max(0.03 * spend, 5 * medianSpend),
  };
}

/**
 * Winner / Loser / Fatigued / Active relative to the account:
 *   - significant spend = spend ≥ max(3 % of account spend, 5 × median spend)
 *   - Winner: significant AND (CPA ≤ 0.8 × account CPA OR ROAS ≥ 1.25 × account ROAS)
 *   - Loser:  significant AND (CPA ≥ 1.5 × account CPA OR no conversion with spend > 3 × account CPA)
 *   - no conversion on the whole account → never Winner/Loser
 *   - an estimated / unavailable ROAS never drives the status
 *   - Fatigued: video hook rate < 20 % or weekly frequency ≥ 3.5
 */
export function classifyStatus(c: StatusInput, ref: AccountReference): "Winner" | "Loser" | "Fatigued" | "Active" {
  const spend = num(c.spend);
  const conv = num(c.conversions);
  const cpa = num(c.cpa);
  const roasUsable = c.roas !== null && c.roas !== undefined && Number.isFinite(c.roas) && !c.roasEstimated && !c.roasUnavailable;
  const significant = spend > 0 && spend >= ref.spendThreshold;

  if (ref.conversions > 0 && ref.cpa !== null && significant) {
    const cpaWin = conv > 0 && cpa > 0 && cpa <= 0.8 * ref.cpa;
    const roasWin = roasUsable && ref.roas !== null && (c.roas as number) >= 1.25 * ref.roas;
    if (cpaWin || roasWin) return "Winner";
    const cpaLose = conv > 0 && cpa > 0 && cpa >= 1.5 * ref.cpa;
    const noConvLose = conv === 0 && spend > 3 * ref.cpa;
    if (cpaLose || noConvLose) return "Loser";
  }

  const isVideo = c.format === "Video";
  if (isVideo && c.hookRate > 0 && c.hookRate < FATIGUE_HOOK_RATE) return "Fatigued";
  if (typeof c.frequencyWeekly === "number" && c.frequencyWeekly >= FATIGUE_FREQUENCY_WEEKLY) return "Fatigued";
  return "Active";
}
