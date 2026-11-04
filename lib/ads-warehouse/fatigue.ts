/**
 * Creative fatigue (Motion's "Creative fatigue" report, made explicit): a
 * creative that still takes real budget while its efficiency wears off, last
 * 7 days vs the 7 before. Pure function over the warehouse rows (query.ts with
 * `compare` = the previous week); used by the Monday Slack recap.
 *
 * Signals (each one needs enough volume on both weeks to mean something):
 *  - CTR down ≥ 20 %            (people stop clicking)
 *  - hook rate down ≥ 20 %      (video: people stop stopping)
 *  - CPA up ≥ 25 %              (≥ 5 conversions the week before)
 *  - repetition up ≥ 15 %      (impressions per person and per day, from the
 *    daily reach summed by the warehouse — not Meta's period frequency)
 * Fatigue is creative wear, so an attention signal (CTR or hook) is required:
 * attention + one more signal, or a severe attention drop (≥ 35 %) on a
 * creative spending at least 3× the bar. A CPA move alone is performance, not
 * fatigue. Visual creatives only (search text ads depend on the queries).
 * Ranked by budget at stake: last week's spend × severity.
 */

import type { AdsGroupRow, Metrics } from "./query";

export interface FatigueSignal { id: "ctr" | "hook" | "cpa" | "frequency"; text: string; severe: boolean }
export interface FatigueHit { row: AdsGroupRow; signals: FatigueSignal[]; verdict: "replace" | "watch"; score: number }

export const FATIGUE_VERDICT_LABEL: Record<FatigueHit["verdict"], string> = { replace: "À remplacer", watch: "À surveiller" };

const MIN_IMPRESSIONS = 2000;
const fr1 = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
const fr2 = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const change = (cur: number, prev: number) => (prev > 0 ? (cur - prev) / prev : 0);

export function fatigueSignals(cur: Metrics, prev: Metrics, opts: { money: (v: number) => string }): FatigueSignal[] {
  const out: FatigueSignal[] = [];
  if (cur.impressions < MIN_IMPRESSIONS || prev.impressions < MIN_IMPRESSIONS) return out;
  const ctr = change(cur.ctr, prev.ctr);
  if (prev.ctr > 0 && cur.linkClicks + prev.linkClicks >= 40 && ctr <= -0.2) {
    out.push({ id: "ctr", text: `CTR ${fr2(cur.ctr)} % (${Math.round(ctr * 100)} %)`, severe: ctr <= -0.35 });
  }
  const hook = change(cur.hookRate, prev.hookRate);
  if (prev.hookRate > 0 && cur.video3s > 0 && hook <= -0.2) {
    out.push({ id: "hook", text: `hook ${fr1(cur.hookRate)} % (${Math.round(hook * 100)} %)`, severe: hook <= -0.35 });
  }
  const cpa = change(cur.cpa, prev.cpa);
  if (prev.conversions >= 5 && cur.conversions >= 2 && prev.cpa > 0 && cur.cpa > 0 && cpa >= 0.25) {
    out.push({ id: "cpa", text: `CPA ${opts.money(cur.cpa)} (+${Math.round(cpa * 100)} %)`, severe: cpa >= 0.5 });
  }
  // Spend with no conversion at all after a converting week counts as a CPA blow-up.
  if (prev.conversions >= 5 && prev.cpa > 0 && cur.conversions === 0 && cur.spend >= prev.cpa * 2) {
    out.push({ id: "cpa", text: `plus aucune conversion (CPA ${opts.money(prev.cpa)} la semaine d'avant)`, severe: true });
  }
  const freq = change(cur.frequency, prev.frequency);
  if (cur.frequency >= 1.3 && prev.frequency > 0 && freq >= 0.15) {
    out.push({ id: "frequency", text: `répétition en hausse (+${Math.round(freq * 100)} %)`, severe: false });
  }
  return out;
}

/** Fatigued creatives of the week, worst budget at stake first. */
export function detectFatigue(rows: AdsGroupRow[], opts: { minSpend: number; money: (v: number) => string; limit?: number }): FatigueHit[] {
  const hits: FatigueHit[] = [];
  for (const row of rows) {
    if (!row.previous || row.metrics.spend < opts.minSpend || row.previous.spend < opts.minSpend / 2) continue;
    // Paused this week: nothing left to replace.
    if (row.trend?.state === "paused") continue;
    if (row.sample && (row.sample.format === "Text" || row.sample.format === "Unknown")) continue;
    const signals = fatigueSignals(row.metrics, row.previous, opts);
    const severe = signals.filter((s) => s.severe).length;
    const attention = signals.filter((s) => s.id === "ctr" || s.id === "hook");
    if (!attention.length) continue;
    const severeAttention = attention.some((s) => s.severe) && row.metrics.spend >= opts.minSpend * 3;
    if (signals.length < 2 && !severeAttention) continue;
    const verdict = signals.length >= 3 || (signals.length >= 2 && severe >= 1) ? "replace" : "watch";
    hits.push({ row, signals, verdict, score: row.metrics.spend * (signals.length + severe) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 3);
}
