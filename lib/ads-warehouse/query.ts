/**
 * Creative warehouse — query layer (Motion's "Top performing" engine).
 *
 * One SQL aggregate over AdDaily ⋈ AdCatalog for a period, grouped by the
 * chosen axis (ad, creative, campaign, ad set, format, landing page, copy,
 * headline, naming tag, launch week), optionally compared with a second
 * period; the account benchmark (the same aggregate without grouping) is
 * returned alongside so the UI can colour every cell against the average.
 * Derived metrics are computed from the sums here (never averaged ratios).
 * The caller is responsible for the account scope (lib/scope.ts).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAovMap } from "@/lib/account-settings";
import type { AdFormat, WarehousePlatform } from "./types";

export type GroupBy = "ad" | "creative" | "campaign" | "adset" | "format" | "landing" | "copy" | "title" | "launch_week" | `tag:${string}`;

export interface AdsFilters {
  formats?: AdFormat[];
  /** true = dynamic creatives only, false = exclude them. */
  dynamic?: boolean;
  minSpend?: number;
  launchedAfter?: string;
  launchedBefore?: string;
  nameContains?: string;
  campaignContains?: string;
  /** active = delivering status (Meta ACTIVE / TikTok ENABLE / Google ENABLED). */
  status?: "active" | "inactive";
  tags?: Record<string, string>;
}

export type MetricKey =
  | "spend" | "impressions" | "reach" | "frequency" | "clicks" | "linkClicks" | "ctr" | "ctrAll" | "cpc" | "cpm"
  | "conversions" | "cpa" | "cvr" | "conversionValue" | "roas" | "aov" | "purchases" | "leads"
  | "videoPlays" | "hookRate" | "holdRate" | "p25Rate" | "p50Rate" | "p75Rate" | "p100Rate" | "thruPlays";

export interface Metrics {
  spend: number; impressions: number; reach: number; frequency: number; clicks: number; linkClicks: number;
  ctr: number; ctrAll: number; cpc: number; cpm: number;
  conversions: number; cpa: number; cvr: number; conversionValue: number; roas: number; aov: number; purchases: number; leads: number;
  videoPlays: number; video3s: number; thruPlays: number; hookRate: number; holdRate: number; p25Rate: number; p50Rate: number; p75Rate: number; p100Rate: number;
  /** ROAS / value computed from conversions × configured AOV (no tracked value on the account). */
  estimated: boolean;
  /** Neither tracked value nor AOV: roas / conversionValue are meaningless (0). */
  roasUnavailable: boolean;
}

export interface AdsQuery {
  platforms: WarehousePlatform[];
  /** Normalised account ids (already scope-filtered). */
  accountIds: string[];
  range: { since: string; until: string };
  compare?: { since: string; until: string } | null;
  groupBy: GroupBy;
  filters?: AdsFilters;
  sort?: { key: MetricKey | "name" | "adCount" | "launch"; dir: "asc" | "desc" };
  limit?: number;
  offset?: number;
}

export interface AdSample {
  platform: string; accountId: string; adId: string; name: string; status: string | null; format: AdFormat; dynamic: boolean;
  thumbnailUrl: string | null; imageUrl: string | null; videoId: string | null; previewUrl: string | null;
  title: string | null; body: string | null; landingUrl: string | null; createdTime: string | null;
  campaignName: string | null; adsetName: string | null; tags: Record<string, string>;
  spend: number;
}

export interface AdsGroupRow {
  key: string;
  label: string;
  adCount: number;
  /** Top-spend ad of the group (what the card shows). */
  sample: AdSample | null;
  /** Ads of the group by spend (desc), for the "N annonces" breakdown. */
  ads: AdSample[];
  /** Earliest launch date in the group. */
  launch: string | null;
  metrics: Metrics;
  previous: Metrics | null;
}

export interface AdsQueryResult {
  rows: AdsGroupRow[];
  total: number;
  benchmark: Metrics;
  benchmarkPrevious: Metrics | null;
  currency: string | null;
  coverage: { since: string | null; until: string | null; accounts: number; complete: boolean };
}

type Sums = {
  spend: number; impressions: number; reach: number; clicks: number; linkClicks: number; conversions: number; conversionValue: number;
  purchases: number; purchaseValue: number; leads: number; videoPlays: number; video3s: number; thruPlays: number; p25: number; p50: number; p75: number; p100: number;
};

const ZERO: Sums = { spend: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, conversions: 0, conversionValue: 0, purchases: 0, purchaseValue: 0, leads: 0, videoPlays: 0, video3s: 0, thruPlays: 0, p25: 0, p50: 0, p75: 0, p100: 0 };
const n = (v: unknown) => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : parseFloat(String(v ?? 0)) || 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (a: number, b: number) => (b > 0 ? r2((a / b) * 100) : 0);
const div = (a: number, b: number) => (b > 0 ? r2(a / b) : 0);

/** Derived metrics from sums under the account value policy (tracked value > AOV estimate > unavailable). */
export function deriveMetrics(s: Sums, aov: number | null): Metrics {
  const trackedValue = s.conversionValue > 0 ? s.conversionValue : s.purchaseValue;
  let value = trackedValue;
  let estimated = false;
  let roasUnavailable = false;
  if (value <= 0 && s.conversions > 0 && aov && aov > 0) { value = s.conversions * aov; estimated = true; }
  if (value <= 0 && !(aov && aov > 0) && trackedValue <= 0) roasUnavailable = s.conversions > 0 || s.spend > 0;
  return {
    spend: r2(s.spend), impressions: s.impressions, reach: s.reach, frequency: div(s.impressions, s.reach), clicks: s.clicks, linkClicks: s.linkClicks,
    ctr: pct(s.linkClicks, s.impressions), ctrAll: pct(s.clicks, s.impressions), cpc: div(s.spend, s.linkClicks), cpm: div(s.spend * 1000, s.impressions),
    conversions: r2(s.conversions), cpa: div(s.spend, s.conversions), cvr: pct(s.conversions, s.linkClicks), conversionValue: r2(value), roas: div(value, s.spend), aov: div(value, s.conversions),
    purchases: r2(s.purchases), leads: r2(s.leads),
    videoPlays: s.videoPlays, video3s: s.video3s, thruPlays: s.thruPlays,
    hookRate: pct(s.video3s, s.impressions), holdRate: pct(s.thruPlays, s.impressions),
    p25Rate: pct(s.p25, s.impressions), p50Rate: pct(s.p50, s.impressions), p75Rate: pct(s.p75, s.impressions), p100Rate: pct(s.p100, s.impressions),
    estimated, roasUnavailable,
  };
}

const SUM_COLS = Prisma.sql`
  SUM(d.spend)::float8 AS spend, SUM(d.impressions)::bigint AS impressions, SUM(d.reach)::bigint AS reach,
  SUM(d.clicks)::bigint AS clicks, SUM(d."linkClicks")::bigint AS "linkClicks",
  SUM(d.conversions)::float8 AS conversions, SUM(d."conversionValue")::float8 AS "conversionValue",
  SUM(d.purchases)::float8 AS purchases, SUM(d."purchaseValue")::float8 AS "purchaseValue", SUM(d.leads)::float8 AS leads,
  SUM(d."videoPlays")::bigint AS "videoPlays", SUM(d.video3s)::bigint AS video3s, SUM(d."thruPlays")::bigint AS "thruPlays",
  SUM(d."videoP25")::bigint AS p25, SUM(d."videoP50")::bigint AS p50, SUM(d."videoP75")::bigint AS p75, SUM(d."videoP100")::bigint AS p100`;

function sumsOf(row: Record<string, unknown>): Sums {
  return {
    spend: n(row.spend), impressions: n(row.impressions), reach: n(row.reach), clicks: n(row.clicks), linkClicks: n(row.linkClicks),
    conversions: n(row.conversions), conversionValue: n(row.conversionValue), purchases: n(row.purchases), purchaseValue: n(row.purchaseValue), leads: n(row.leads),
    videoPlays: n(row.videoPlays), video3s: n(row.video3s), thruPlays: n(row.thruPlays), p25: n(row.p25), p50: n(row.p50), p75: n(row.p75), p100: n(row.p100),
  };
}

/** SQL expression of the group key for a catalogue alias `c`. */
export function groupKeyExpr(groupBy: GroupBy): Prisma.Sql {
  switch (groupBy) {
    case "ad": return Prisma.sql`c."adId"`;
    case "creative": return Prisma.sql`COALESCE(c."creativeKey", 'a:' || c."adId")`;
    case "campaign": return Prisma.sql`COALESCE(c."campaignId", '—')`;
    case "adset": return Prisma.sql`COALESCE(c."adsetId", '—')`;
    case "format": return Prisma.sql`c.format`;
    case "landing": return Prisma.sql`COALESCE(NULLIF(split_part(c."landingUrl", '?', 1), ''), '—')`;
    case "copy": return Prisma.sql`COALESCE(NULLIF(left(c.body, 300), ''), '—')`;
    case "title": return Prisma.sql`COALESCE(NULLIF(c.title, ''), '—')`;
    case "launch_week": return Prisma.sql`COALESCE(to_char(date_trunc('week', c."createdTime"), 'YYYY-MM-DD'), '—')`;
    default: {
      if (groupBy.startsWith("tag:")) {
        const key = groupBy.slice(4).slice(0, 40);
        return Prisma.sql`COALESCE(NULLIF(c."tagsJson"::jsonb ->> ${key}, ''), '—')`;
      }
      return Prisma.sql`c."adId"`;
    }
  }
}

function whereOf(q: AdsQuery, range: { since: string; until: string }): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`d.platform IN (${Prisma.join(q.platforms)})`,
    Prisma.sql`d."accountId" IN (${Prisma.join(q.accountIds)})`,
    Prisma.sql`d.date >= ${range.since}::date AND d.date <= ${range.until}::date`,
  ];
  const f = q.filters ?? {};
  if (f.formats?.length) parts.push(Prisma.sql`c.format IN (${Prisma.join(f.formats)})`);
  if (typeof f.dynamic === "boolean") parts.push(Prisma.sql`c.dynamic = ${f.dynamic}`);
  if (f.launchedAfter) parts.push(Prisma.sql`c."createdTime" >= ${f.launchedAfter}::date`);
  if (f.launchedBefore) parts.push(Prisma.sql`c."createdTime" < (${f.launchedBefore}::date + INTERVAL '1 day')`);
  if (f.nameContains) parts.push(Prisma.sql`c.name ILIKE ${"%" + f.nameContains + "%"}`);
  if (f.campaignContains) parts.push(Prisma.sql`(c."campaignName" ILIKE ${"%" + f.campaignContains + "%"} OR c."adsetName" ILIKE ${"%" + f.campaignContains + "%"})`);
  if (f.status === "active") parts.push(Prisma.sql`c.status IN ('ACTIVE','ENABLE','ENABLED')`);
  if (f.status === "inactive") parts.push(Prisma.sql`(c.status IS NULL OR c.status NOT IN ('ACTIVE','ENABLE','ENABLED'))`);
  for (const [k, v] of Object.entries(f.tags ?? {})) parts.push(Prisma.sql`c."tagsJson"::jsonb ->> ${k.slice(0, 40)} = ${v}`);
  return Prisma.join(parts, " AND ");
}

const JOIN = Prisma.sql`"AdDaily" d JOIN "AdCatalog" c ON c.id = d.platform || ':' || d."adId"`;

async function aggregate(q: AdsQuery, range: { since: string; until: string }, keyExpr: Prisma.Sql): Promise<Map<string, { sums: Sums; adCount: number; launch: string | null }>> {
  const minSpend = q.filters?.minSpend ?? 0;
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT ${keyExpr} AS key, COUNT(DISTINCT d."adId")::int AS "adCount", to_char(MIN(c."createdTime"), 'YYYY-MM-DD') AS launch, ${SUM_COLS}
    FROM ${JOIN}
    WHERE ${whereOf(q, range)}
    GROUP BY 1
    HAVING SUM(d.spend) >= ${minSpend}`);
  const out = new Map<string, { sums: Sums; adCount: number; launch: string | null }>();
  for (const r of rows) out.set(String(r.key), { sums: sumsOf(r), adCount: n(r.adCount), launch: (r.launch as string | null) ?? null });
  return out;
}

async function benchmark(q: AdsQuery, range: { since: string; until: string }): Promise<{ sums: Sums; currency: string | null }> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT MAX(d.currency) AS currency, ${SUM_COLS}
    FROM ${JOIN}
    WHERE ${whereOf({ ...q, filters: { ...q.filters, minSpend: 0 } }, range)}`);
  const r = rows[0] ?? {};
  return { sums: rows.length ? sumsOf(r) : ZERO, currency: (r.currency as string | null) ?? null };
}

function sampleOf(row: Record<string, unknown>): AdSample {
  let tags: Record<string, string> = {};
  try { tags = JSON.parse(String(row.tagsJson ?? "{}")); } catch { tags = {}; }
  return {
    platform: String(row.platform), accountId: String(row.accountId), adId: String(row.adId), name: String(row.name ?? row.adId), status: (row.status as string | null) ?? null,
    format: (row.format as AdFormat) ?? "Unknown", dynamic: !!row.dynamic, thumbnailUrl: (row.thumbnailUrl as string | null) ?? null, imageUrl: (row.imageUrl as string | null) ?? null,
    videoId: (row.videoId as string | null) ?? null, previewUrl: (row.previewUrl as string | null) ?? null, title: (row.title as string | null) ?? null,
    body: (row.body as string | null) ?? null, landingUrl: (row.landingUrl as string | null) ?? null,
    createdTime: row.createdTime ? new Date(row.createdTime as string).toISOString().slice(0, 10) : null,
    campaignName: (row.campaignName as string | null) ?? null, adsetName: (row.adsetName as string | null) ?? null, tags, spend: r2(n(row.spend)),
  };
}

/** Ads of the given groups with their spend over the range (desc), capped. */
async function adsOfGroups(q: AdsQuery, keyExpr: Prisma.Sql, keys: string[]): Promise<Map<string, AdSample[]>> {
  const out = new Map<string, AdSample[]>();
  if (!keys.length) return out;
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT ${keyExpr} AS key, c.platform, c."accountId", c."adId", c.name, c.status, c.format, c.dynamic, c."thumbnailUrl", c."imageUrl", c."videoId", c."previewUrl",
           c.title, c.body, c."landingUrl", c."createdTime", c."campaignName", c."adsetName", c."tagsJson", SUM(d.spend)::float8 AS spend
    FROM ${JOIN}
    WHERE ${whereOf(q, q.range)} AND ${keyExpr} IN (${Prisma.join(keys)})
    GROUP BY 1, c.id
    ORDER BY spend DESC
    LIMIT 4000`);
  for (const r of rows) {
    const k = String(r.key);
    const list = out.get(k) ?? [];
    if (list.length < 50) list.push(sampleOf(r));
    out.set(k, list);
  }
  return out;
}

function labelOf(groupBy: GroupBy, key: string, sample: AdSample | null): string {
  if (key === "—") return "Sans valeur";
  switch (groupBy) {
    case "ad": return sample?.name ?? key;
    case "creative": return sample?.name ?? key;
    case "campaign": return sample?.campaignName ?? key;
    case "adset": return sample?.adsetName ?? key;
    case "launch_week": return `Semaine du ${key}`;
    default: return key;
  }
}

export async function queryAds(q: AdsQuery): Promise<AdsQueryResult> {
  if (!q.accountIds.length || !q.platforms.length) {
    return { rows: [], total: 0, benchmark: deriveMetrics(ZERO, null), benchmarkPrevious: null, currency: null, coverage: { since: null, until: null, accounts: 0, complete: false } };
  }
  const keyExpr = groupKeyExpr(q.groupBy);
  const aovMap = await getAovMap("meta", q.accountIds);
  const aov = q.accountIds.length === 1 ? (aovMap.get(q.accountIds[0]) ?? null) || null : null;

  const [cur, prev, bench, benchPrev, states] = await Promise.all([
    aggregate(q, q.range, keyExpr),
    q.compare ? aggregate(q, q.compare, keyExpr) : Promise.resolve(null),
    benchmark(q, q.range),
    q.compare ? benchmark(q, q.compare) : Promise.resolve(null),
    prisma.adSyncState.findMany({ where: { platform: { in: q.platforms }, accountId: { in: q.accountIds } }, select: { syncedFrom: true, syncedTo: true, lastError: true } }),
  ]);

  let entries = Array.from(cur.entries()).map(([key, v]) => ({ key, ...v, metrics: deriveMetrics(v.sums, aov), previous: prev?.get(key) ? deriveMetrics(prev.get(key)!.sums, aov) : null }));
  const sort = q.sort ?? { key: "spend", dir: "desc" };
  const sign = sort.dir === "asc" ? 1 : -1;
  entries.sort((a, b) => {
    if (sort.key === "name") return a.key.localeCompare(b.key) * sign;
    if (sort.key === "adCount") return (a.adCount - b.adCount) * sign || b.metrics.spend - a.metrics.spend;
    if (sort.key === "launch") return ((a.launch ?? "").localeCompare(b.launch ?? "")) * sign || b.metrics.spend - a.metrics.spend;
    const va = a.metrics[sort.key as MetricKey] ?? 0;
    const vb = b.metrics[sort.key as MetricKey] ?? 0;
    // Zero ratios (no data) always last whatever the direction.
    if (va === 0 && vb !== 0) return 1;
    if (vb === 0 && va !== 0) return -1;
    return (va - vb) * sign || b.metrics.spend - a.metrics.spend;
  });
  const total = entries.length;
  const offset = q.offset ?? 0;
  const limit = Math.min(q.limit ?? 60, 200);
  entries = entries.slice(offset, offset + limit);

  const ads = await adsOfGroups(q, keyExpr, entries.map((e) => e.key));
  const rows: AdsGroupRow[] = entries.map((e) => {
    const list = ads.get(e.key) ?? [];
    const sample = list[0] ?? null;
    return { key: e.key, label: labelOf(q.groupBy, e.key, sample), adCount: e.adCount, sample, ads: list, launch: e.launch, metrics: e.metrics, previous: e.previous };
  });

  const since = states.map((s) => s.syncedFrom).filter(Boolean).sort((a, b) => a!.getTime() - b!.getTime())[0] ?? null;
  const until = states.map((s) => s.syncedTo).filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null;
  return {
    rows, total,
    benchmark: deriveMetrics(bench.sums, aov),
    benchmarkPrevious: benchPrev ? deriveMetrics(benchPrev.sums, aov) : null,
    currency: bench.currency,
    coverage: { since: since ? since.toISOString().slice(0, 10) : null, until: until ? until.toISOString().slice(0, 10) : null, accounts: states.length, complete: states.length === q.accountIds.length * q.platforms.length && states.every((s) => !s.lastError) },
  };
}

export interface DailyPoint { date: string; metrics: Metrics }

/** Day-by-day series of one group (or of the whole selection when `key` is omitted) — the line chart and the drawer trend. */
export async function queryDaily(q: AdsQuery, key?: string | null): Promise<DailyPoint[]> {
  if (!q.accountIds.length || !q.platforms.length) return [];
  const keyExpr = groupKeyExpr(q.groupBy);
  const aovMap = await getAovMap("meta", q.accountIds);
  const aov = q.accountIds.length === 1 ? (aovMap.get(q.accountIds[0]) ?? null) || null : null;
  const keyCond = key ? Prisma.sql`AND ${keyExpr} = ${key}` : Prisma.empty;
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT to_char(d.date, 'YYYY-MM-DD') AS date, ${SUM_COLS}
    FROM ${JOIN}
    WHERE ${whereOf({ ...q, filters: { ...q.filters, minSpend: 0 } }, q.range)} ${keyCond}
    GROUP BY 1 ORDER BY 1`);
  return rows.map((r) => ({ date: String(r.date), metrics: deriveMetrics(sumsOf(r), aov) }));
}

/** Naming-convention keys present in the catalogue of these accounts (for the "Group by tag" menu), most frequent first. */
export async function tagKeys(platforms: WarehousePlatform[], accountIds: string[]): Promise<Array<{ key: string; count: number }>> {
  if (!accountIds.length) return [];
  const rows = await prisma.$queryRaw<Array<{ key: string; count: number }>>(Prisma.sql`
    SELECT k.key, COUNT(*)::int AS count
    FROM "AdCatalog" c, LATERAL jsonb_object_keys(c."tagsJson"::jsonb) AS k(key)
    WHERE c.platform IN (${Prisma.join(platforms)}) AND c."accountId" IN (${Prisma.join(accountIds)})
    GROUP BY 1 ORDER BY 2 DESC LIMIT 30`);
  return rows.filter((r) => !/^(s|t)\d+$/.test(r.key)).map((r) => ({ key: r.key, count: n(r.count) }));
}
