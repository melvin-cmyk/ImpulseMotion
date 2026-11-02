/**
 * « Formats visuels » — Motion's visual format analysis (GetVisualFormatAnalysis:
 * topFormats / newlyTesting, each with a creative count and an example): the
 * client's creatives grouped by their AI tag « Format visuel » (ai:format).
 * Top formats = by spend over the period; « En test » = formats whose first
 * creative launched in the last 30 days.
 */

import { queryAds, type AdSample, type AdsGroupRow, type AdsQuery, type Metrics } from "./query";

export const FORMAT_TAG = "ai:format";

export interface FormatStat {
  name: string;
  creatives: number;
  spend: number;
  winners: number;
  hitRate: number;
  firstLaunch: string | null;
  example: AdSample | null;
}

const UNKNOWN = /^(indéterminé|aucune?|autre|n\/a|-)$/i;

function isWinner(m: Metrics, bench: Metrics, bar: number, goal: "roas" | "cpa" | "cvr"): boolean {
  if (m.spend < bar) return false;
  if (goal === "roas") return m.roas > 0 && m.roas >= bench.roas;
  if (goal === "cpa") return m.cpa > 0 && m.cpa <= bench.cpa;
  return m.cvr > 0 && m.cvr >= bench.cvr;
}

export async function listFormats(q: AdsQuery): Promise<{ top: FormatStat[]; testing: FormatStat[]; tagged: number; untagged: number; currency: string | null }> {
  const res = await queryAds({ ...q, groupBy: "creative", filters: {}, compare: null, sort: { key: "spend", dir: "desc" }, limit: 200 });
  const groups = new Map<string, AdsGroupRow[]>();
  let untagged = 0;
  for (const r of res.rows) {
    const raw = r.sample?.tags?.[FORMAT_TAG]?.trim();
    if (!raw) { if (r.sample?.platform !== "google" || r.sample.format !== "Text") untagged += 1; continue; }
    if (UNKNOWN.test(raw)) continue;
    for (const name of raw.split(/\s*\|\s*/).filter(Boolean)) groups.set(name, [...(groups.get(name) ?? []), r]);
  }
  const recent = Date.now() - 30 * 86_400_000;
  const stats: FormatStat[] = Array.from(groups.entries()).map(([name, rows]) => {
    const winners = rows.filter((r) => isWinner(r.metrics, res.benchmark, res.spendThreshold, res.goal)).length;
    const launches = rows.map((r) => r.launch).filter((d): d is string => !!d).sort();
    return {
      name, creatives: rows.length, spend: Math.round(rows.reduce((s, r) => s + r.metrics.spend, 0) * 100) / 100,
      winners, hitRate: rows.length ? winners / rows.length : 0, firstLaunch: launches[0] ?? null,
      example: (rows.find((r) => r.sample?.imageUrl || r.sample?.thumbnailUrl) ?? rows[0])?.sample ?? null,
    };
  });
  const testing = stats.filter((s) => s.firstLaunch && Date.parse(s.firstLaunch + "T00:00:00Z") >= recent).sort((a, b) => b.creatives - a.creatives || b.spend - a.spend);
  const testingNames = new Set(testing.map((s) => s.name));
  const top = stats.filter((s) => !testingNames.has(s.name)).sort((a, b) => b.spend - a.spend);
  return { top, testing, tagged: res.rows.length - untagged, untagged, currency: res.currency };
}
