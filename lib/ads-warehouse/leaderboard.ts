/**
 * Motion's Leaderboard ("Track performance shifts and top creatives"),
 * rebuilt from its CreativeHighlights query: for the week ending at `until`
 * - overview: account KPIs vs the previous week + creatives launched;
 * - leaderboard: top creatives by spend, with their rank change vs last week
 *   and the number of consecutive weeks they have been in the top;
 * - trends: creatives scaling / declining / new / paused (counts + examples).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { groupKeyExpr, queryAds, type AdsGroupRow, type AdsQuery, type Metrics } from "./query";
import type { SpendState } from "./trends";

export const LEADERBOARD_SIZE = 10;
const HISTORY_WEEKS = 8;

export interface LeaderRow extends AdsGroupRow {
  rank: number;
  /** Positions gained since last week (+2 = climbed two places); null = not in last week's top. */
  rankChange: number | null;
  /** Consecutive weeks in the top, this one included. */
  weeks: number;
}

export interface LeaderboardResult {
  period: { since: string; until: string; previousSince: string; previousUntil: string };
  overview: { current: Metrics; previous: Metrics | null; launched: number; currency: string | null };
  leaderboard: LeaderRow[];
  trends: { counts: Record<"scaling" | "declining" | "new" | "paused", number>; rows: Record<"scaling" | "declining" | "new" | "paused", AdsGroupRow[]> };
  spendThreshold: number;
}

const day = (iso: string, delta: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10); };

/** Rank of each creative by spend for the last HISTORY_WEEKS weeks (week 0 = the current one). */
async function weeklyRanks(q: AdsQuery, until: string): Promise<Array<Map<string, number>>> {
  const keyExpr = groupKeyExpr("creative");
  const since = day(until, -(HISTORY_WEEKS * 7 - 1));
  const rows = await prisma.$queryRaw<Array<{ key: string; w: number; spend: number }>>(Prisma.sql`
    SELECT ${keyExpr} AS key, ((${until}::date - d.date) / 7)::int AS w, SUM(d.spend)::float8 AS spend
    FROM "AdDaily" d JOIN "AdCatalog" c ON c.id = d.platform || ':' || d."adId"
    WHERE d.platform IN (${Prisma.join(q.platforms)}) AND d."accountId" IN (${Prisma.join(q.accountIds)})
      AND d.date >= ${since}::date AND d.date <= ${until}::date
    GROUP BY 1, 2
    HAVING SUM(d.spend) > 0`);
  const weeks: Array<Array<{ key: string; spend: number }>> = Array.from({ length: HISTORY_WEEKS }, () => []);
  for (const r of rows) if (r.w >= 0 && r.w < HISTORY_WEEKS) weeks[r.w].push({ key: String(r.key), spend: Number(r.spend) });
  return weeks.map((list) => new Map(list.sort((a, b) => b.spend - a.spend).map((x, i) => [x.key, i + 1])));
}

async function launchedCount(q: AdsQuery, since: string, until: string): Promise<number> {
  const keyExpr = groupKeyExpr("creative");
  const rows = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT COUNT(DISTINCT ${keyExpr})::int AS n
    FROM "AdCatalog" c
    WHERE c.platform IN (${Prisma.join(q.platforms)}) AND c."accountId" IN (${Prisma.join(q.accountIds)})
      AND c."createdTime" >= ${since}::date AND c."createdTime" < (${until}::date + INTERVAL '1 day')`);
  return Number(rows[0]?.n ?? 0);
}

export async function queryLeaderboard(base: AdsQuery): Promise<LeaderboardResult> {
  const until = base.range.until;
  const since = day(until, -6);
  const previousUntil = day(since, -1);
  const previousSince = day(previousUntil, -6);
  const q: AdsQuery = { ...base, groupBy: "creative", filters: {}, range: { since, until }, compare: { since: previousSince, until: previousUntil }, sort: { key: "spend", dir: "desc" } };

  const [week, fortnight, ranks, launched] = await Promise.all([
    queryAds({ ...q, limit: LEADERBOARD_SIZE }),
    // Two weeks so that paused creatives (no spend this week) are still listed.
    queryAds({ ...q, range: { since: previousSince, until }, compare: null, limit: 200 }),
    q.accountIds.length ? weeklyRanks(q, until) : Promise.resolve([] as Array<Map<string, number>>),
    q.accountIds.length ? launchedCount(q, since, until) : Promise.resolve(0),
  ]);

  const leaderboard: LeaderRow[] = week.rows.map((r, i) => {
    const last = ranks[1]?.get(r.key) ?? null;
    let weeks = 0;
    for (const w of ranks) { const p = w.get(r.key); if (p && p <= LEADERBOARD_SIZE) weeks += 1; else break; }
    return { ...r, rank: i + 1, rankChange: last && last <= LEADERBOARD_SIZE ? last - (i + 1) : null, weeks: Math.max(1, weeks) };
  });

  const states = ["scaling", "declining", "new", "paused"] as const;
  const counts = { scaling: 0, declining: 0, new: 0, paused: 0 };
  const rows = { scaling: [] as AdsGroupRow[], declining: [] as AdsGroupRow[], new: [] as AdsGroupRow[], paused: [] as AdsGroupRow[] };
  for (const r of fortnight.rows) {
    const s = r.trend?.state as SpendState | undefined;
    if (!s || !(states as readonly string[]).includes(s)) continue;
    const k = s as (typeof states)[number];
    counts[k] += 1;
    if (rows[k].length < 4) rows[k].push(r);
  }
  // Scaling / declining: biggest movers first.
  rows.scaling.sort((a, b) => (b.trend!.last7 - b.trend!.prev7) - (a.trend!.last7 - a.trend!.prev7));
  rows.declining.sort((a, b) => (a.trend!.last7 - a.trend!.prev7) - (b.trend!.last7 - b.trend!.prev7));

  return {
    period: { since, until, previousSince, previousUntil },
    overview: { current: week.benchmark, previous: week.benchmarkPrevious, launched, currency: week.currency },
    leaderboard,
    trends: { counts, rows },
    spendThreshold: week.spendThreshold,
  };
}
