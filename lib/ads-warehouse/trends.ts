/**
 * Motion's creative-level signals, computed from the warehouse:
 * - spend state (Motion `spendState` / leaderboard trends SCALING, DESCALING,
 *   NEW, PAUSED): last 7 days of spend vs the 7 before, at the end of the range;
 * - creative scores 0-100 (Motion's Hook / Watch / Click / Convert score):
 *   percentile rank of the creative inside the account, among creatives that
 *   spent at least the significance threshold (Motion's `spendThreshold`).
 * Pure functions; the SQL lives in query.ts.
 */

import type { Metrics } from "./query";

export type SpendState = "new" | "scaling" | "declining" | "paused" | "stable" | "testing";

export interface CreativeTrend {
  state: SpendState;
  last7: number;
  prev7: number;
  /** % change of spend, last 7 days vs the 7 before (null when the previous week is 0). */
  wow: number | null;
}

export const SPEND_STATE_LABEL: Record<SpendState, string> = {
  new: "Nouvelle",
  scaling: "En hausse",
  declining: "En baisse",
  paused: "En pause",
  stable: "Stable",
  testing: "En test",
};

export const SPEND_STATE_HINT: Record<SpendState, string> = {
  new: "Première dépense dans les 7 derniers jours",
  scaling: "Dépense des 7 derniers jours au moins +30 % vs les 7 précédents",
  declining: "Dépense des 7 derniers jours au moins -30 % vs les 7 précédents",
  paused: "Plus aucune dépense sur les 7 derniers jours",
  stable: "Dépense stable d'une semaine sur l'autre",
  testing: "Dépense encore sous le seuil de significativité",
};

/**
 * Spend from which a creative's numbers mean something (Motion: per-workspace
 * spend threshold). Two conversions' worth when the account converts, else
 * 1 % of the period's spend; bounded to 30–1 500.
 */
export function spendThreshold(bench: Metrics): number {
  const raw = bench.cpa > 0 ? bench.cpa * 2 : bench.spend * 0.01;
  return Math.round(Math.min(1500, Math.max(30, raw)));
}

/** Spend state of a creative at the end of the range (`until`, YYYY-MM-DD). */
export function classifyTrend(last7: number, prev7: number, launch: string | null, until: string, threshold: number): CreativeTrend {
  const wow = prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 1000) / 10 : null;
  const base = { last7: Math.round(last7 * 100) / 100, prev7: Math.round(prev7 * 100) / 100, wow };
  const end = Date.parse(until + "T00:00:00Z");
  const launched = launch ? Date.parse(launch + "T00:00:00Z") : NaN;
  // Two weeks of spend are judged against a quarter of the significance threshold.
  const bar = Math.max(20, threshold / 4);
  if (last7 <= 0 && prev7 > 0) return { state: "paused", ...base };
  if (prev7 <= 0 && last7 > 0 && (!Number.isFinite(launched) || end - launched < 7 * 86_400_000)) return { state: "new", ...base };
  if (last7 >= bar / 2 && last7 >= prev7 * 1.3) return { state: "scaling", ...base };
  if (prev7 >= bar / 2 && last7 <= prev7 * 0.7) return { state: "declining", ...base };
  if (last7 + prev7 < bar) return { state: "testing", ...base };
  return { state: "stable", ...base };
}

export interface ScoreInput { key: string; metrics: Metrics }
export interface CreativeScores { hookScore: number; watchScore: number; clickScore: number; convertScore: number }

/** Goal of the Convert score: ROAS when the account has a value, else CPA, else conversion rate. */
export function convertGoal(bench: Metrics): "roas" | "cpa" | "cvr" {
  // An AOV-estimated ROAS is conversions × a constant: rank on CPA instead.
  if (!bench.roasUnavailable && !bench.estimated && bench.roas > 0) return "roas";
  if (bench.cpa > 0) return "cpa";
  return "cvr";
}

/**
 * Percentile scores (1–100, 0 = not scored) inside the given population. A
 * creative is scored when it spent at least the threshold and has the metric;
 * fewer than 3 such creatives = no score (nothing to compare with). A
 * creative without conversions is ranked last on Convert when the goal is CPA.
 */
export function computeScores(entries: ScoreInput[], threshold: number, bench: Metrics): { scores: Map<string, CreativeScores>; goal: "roas" | "cpa" | "cvr" } {
  let goal = convertGoal(bench);
  // On short periods (a week) the threshold would leave nobody: cap it at 5 % of the period's spend.
  const bar = Math.min(threshold, Math.max(10, bench.spend * 0.05));
  const eligible = entries.filter((e) => e.metrics.spend >= bar);
  // A value tracked on a handful of ads only: ROAS cannot rank the creatives.
  if (goal === "roas" && eligible.filter((e) => e.metrics.roas > 0).length < 3) goal = bench.cpa > 0 ? "cpa" : "cvr";
  const isVideo = (m: Metrics) => m.video3s > 0 || m.videoPlays > 0;
  const metricsFor: Array<{ score: keyof CreativeScores; value: (m: Metrics) => number; lowerBetter?: boolean; video?: boolean }> = [
    { score: "hookScore", value: (m) => m.hookRate, video: true },
    { score: "watchScore", value: (m) => m.holdRate, video: true },
    { score: "clickScore", value: (m) => m.ctr },
    // No conversion at all = the worst CPA of the population (spend with nothing back).
    { score: "convertScore", value: (m) => (goal === "roas" ? m.roas : goal === "cpa" ? (m.cpa > 0 ? m.cpa : m.spend * 1e6) : m.cvr), lowerBetter: goal === "cpa" },
  ];
  const out = new Map<string, CreativeScores>();
  for (const e of entries) out.set(e.key, { hookScore: 0, watchScore: 0, clickScore: 0, convertScore: 0 });
  for (const def of metricsFor) {
    const pop = eligible.filter((e) => (!def.video || isVideo(e.metrics)) && def.value(e.metrics) > 0);
    if (pop.length < 3) continue;
    const values = pop.map((e) => def.value(e.metrics));
    for (const e of pop) {
      const v = def.value(e.metrics);
      let below = 0, equal = 0;
      for (const x of values) { if (def.lowerBetter ? x > v : x < v) below += 1; else if (x === v) equal += 1; }
      const p = (below + (equal - 1) / 2) / Math.max(1, values.length - 1);
      out.get(e.key)![def.score] = Math.max(1, Math.min(100, Math.round(p * 99) + 1));
    }
  }
  return { scores: out, goal };
}
