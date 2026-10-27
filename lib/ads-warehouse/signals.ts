/**
 * Launch signals (Motion's "Launch analysis" badges): what a creative shows
 * in its first days, judged against the account average on the same period.
 * Pure function over the row metrics and the benchmark; thresholds are
 * deliberately simple and explained in the badge hint.
 */

import type { Metrics } from "./query";

export interface Signal { id: "winning" | "top_hook" | "top_click" | "converts" | "watch" | "underfunded"; label: string; tone: "good" | "warn" | "neutral"; hint: string }

export function launchSignals(m: Metrics, bench: Metrics, opts: { video: boolean; minSpend?: number }): Signal[] {
  const out: Signal[] = [];
  const minSpend = opts.minSpend ?? Math.max(20, bench.spend > 0 ? 0 : 20);
  if (m.spend < minSpend) { out.push({ id: "underfunded", label: "Peu de dépense", tone: "neutral", hint: `Moins de ${minSpend} dépensés : trop tôt pour juger` }); return out; }
  const hook = opts.video && bench.hookRate > 0 && m.hookRate >= bench.hookRate * 1.2;
  const click = bench.ctr > 0 && m.ctr >= bench.ctr * 1.2;
  const converts = m.conversions >= 3 && bench.cpa > 0 && m.cpa > 0 && m.cpa <= bench.cpa * 0.8;
  if ((hook || click) && converts) out.push({ id: "winning", label: "Gagnante", tone: "good", hint: "Attire (hook ou CTR ≥ 1,2× la moyenne) ET convertit (CPA ≤ 0,8× la moyenne, 3 conversions ou plus)" });
  if (hook) out.push({ id: "top_hook", label: "Top hook", tone: "good", hint: `Hook rate ${m.hookRate} % vs ${bench.hookRate} % en moyenne` });
  if (click) out.push({ id: "top_click", label: "Top clic", tone: "good", hint: `CTR ${m.ctr} % vs ${bench.ctr} % en moyenne` });
  if (converts && !out.some((s) => s.id === "winning")) out.push({ id: "converts", label: "Convertit", tone: "good", hint: `CPA ${m.cpa} vs ${bench.cpa} en moyenne` });
  if (!out.length && bench.ctr > 0 && m.ctr < bench.ctr * 0.6 && m.spend >= minSpend * 3) out.push({ id: "watch", label: "À surveiller", tone: "warn", hint: `CTR ${m.ctr} % bien sous la moyenne (${bench.ctr} %) malgré la dépense` });
  return out;
}

export const SIGNAL_CLASS: Record<Signal["tone"], string> = {
  good: "bg-emerald-500/15 text-emerald-200 border-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-200 border-amber-500/30",
  neutral: "bg-gray-800 text-gray-400 border-gray-700",
};
