"use client";

/**
 * Motion's Launch analysis ("sprints"): of the creatives launched in the
 * window, which ones got budget (Scaled: spend ≥ threshold) and which ones
 * reached the goal once scaled (Winners). The goal and threshold default to
 * the account (CPA ≤ account CPA, or ROAS ≥ account ROAS; threshold = two
 * conversions' worth) and can be edited inline; the tabs filter the rows.
 */

import { Flag, Rocket, Trophy, TrendingUp } from "lucide-react";
import { opportunitiesOf } from "@/lib/ads-warehouse/opportunities";
import type { AdsGroupRow, Metrics } from "@/lib/ads-warehouse/query";
import { fmtMetric } from "@/lib/ads-warehouse/metrics-ui";

export type FunnelStage = "launched" | "scaled" | "winners" | "opportunities";
export interface FunnelGoal { metric: "cpa" | "roas"; value: number; spend: number }

/**
 * Account default: the goal the scores use (ROAS only when the account tracks
 * a value on enough creatives, else CPA) at the account's level, and the
 * significance threshold capped at 5 % of the period's spend (a 14-day window
 * would otherwise leave nothing "scaled").
 */
export function defaultGoal(bench: Metrics, threshold: number, goal: "roas" | "cpa" | "cvr"): FunnelGoal {
  const metric = goal === "roas" ? "roas" : "cpa";
  const value = metric === "roas" ? bench.roas : bench.cpa;
  const spend = Math.round(Math.min(threshold, Math.max(10, bench.spend * 0.05)));
  return { metric, value: Math.round(value * 100) / 100, spend };
}

export function meetsGoal(m: Metrics, goal: FunnelGoal): boolean {
  if (goal.metric === "roas") return m.roas > 0 && m.roas >= goal.value;
  return m.cpa > 0 && (goal.value <= 0 || m.cpa <= goal.value);
}

export function funnelRows(rows: AdsGroupRow[], goal: FunnelGoal, stage: FunnelStage): AdsGroupRow[] {
  if (stage === "launched") return rows;
  const scaled = rows.filter((r) => r.metrics.spend >= goal.spend);
  if (stage === "opportunities") { const o = opportunitiesOf(scaled, goal.spend); return scaled.filter((r) => o.has(r.key)); }
  return stage === "scaled" ? scaled : scaled.filter((r) => meetsGoal(r.metrics, goal));
}

interface Props {
  rows: AdsGroupRow[];
  goal: FunnelGoal;
  onGoal: (g: FunnelGoal) => void;
  stage: FunnelStage;
  onStage: (s: FunnelStage) => void;
  launchedSince: string | null;
  currency: string | null;
}

export function LaunchFunnel({ rows, goal, onGoal, stage, onStage, launchedSince, currency }: Props) {
  const launched = rows.length;
  const scaled = funnelRows(rows, goal, "scaled").length;
  const winners = funnelRows(rows, goal, "winners").length;
  const opportunities = funnelRows(rows, goal, "opportunities").length;
  const since = launchedSince ? new Date(launchedSince + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" }) : null;
  const goalLabel = goal.metric === "roas" ? `ROAS ≥ ${goal.value.toLocaleString("fr-FR")}` : `CPA ≤ ${fmtMetric("cpa", goal.value, currency)}`;
  const tabs: Array<{ id: FunnelStage; icon: typeof Rocket; count: number; title: string; sub: string }> = [
    { id: "launched", icon: Rocket, count: launched, title: "Lancées", sub: since ? `depuis le ${since}` : "sur la période" },
    { id: "scaled", icon: TrendingUp, count: scaled, title: "Scalées", sub: `dépense ≥ ${fmtMetric("spend", goal.spend, currency)}` },
    { id: "winners", icon: Trophy, count: winners, title: "Gagnantes", sub: `scalées et ${goalLabel}` },
    { id: "opportunities", icon: Flag, count: opportunities, title: "Opportunités", sub: "itérations suggérées" },
  ];
  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-gray-800 text-xs">
        <span className="text-gray-500">Objectif</span>
        <select value={goal.metric} onChange={(e) => onGoal({ ...goal, metric: e.target.value as FunnelGoal["metric"] })} className="rounded-md border border-gray-800 bg-gray-950 px-1.5 py-1 text-gray-200">
          <option value="cpa">CPA ≤</option>
          <option value="roas">ROAS ≥</option>
        </select>
        <input type="number" min={0} step="0.1" value={goal.value} onChange={(e) => onGoal({ ...goal, value: Number(e.target.value) || 0 })} className="w-20 rounded-md border border-gray-800 bg-gray-950 px-1.5 py-1 text-gray-200 tabular-nums" />
        <span className="text-gray-500 ml-2">Scalée à partir de</span>
        <input type="number" min={0} step="10" value={goal.spend} onChange={(e) => onGoal({ ...goal, spend: Number(e.target.value) || 0 })} className="w-24 rounded-md border border-gray-800 bg-gray-950 px-1.5 py-1 text-gray-200 tabular-nums" />
        <span className="text-gray-500">{currency ?? "€"} dépensés</span>
        <span className="ml-auto text-gray-600">Taux de réussite : {launched ? Math.round((winners / launched) * 100) : 0} %</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => onStage(t.id)} className={`flex items-center gap-3 px-4 py-3 text-left border-b-2 ${stage === t.id ? "border-violet-500 bg-gray-900" : "border-transparent bg-gray-950/40 hover:bg-gray-900"}`}>
            <span className={`w-8 h-8 rounded-full flex items-center justify-center ${stage === t.id ? "bg-violet-500/20 text-violet-200" : "bg-gray-800 text-gray-400"}`}><t.icon className="w-4 h-4" /></span>
            <span>
              <span className="block text-sm text-white"><span className="font-semibold tabular-nums">{t.count}</span> {t.title}</span>
              <span className="block text-xs text-gray-500">{t.sub}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
