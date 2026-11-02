"use client";

/**
 * Motion's report table (second card under the chart):
 * - a checkbox per row = what the chart above shows (« N groupes sélectionnés »);
 * - a checkbox in each metric header = the metric is one of the chart's
 *   numbered metrics (max 6, colour = rank), sort on the label;
 * - row: 40 px thumbnail, name, « N annonce(s) » under it, launch date, tags;
 * - cells filled green when better than the account average;
 * - « Résultat net » footer: total (or « - » for ratios) over « Moy. … ».
 */

import { ArrowDown, ArrowUp, ArrowUpDown, Info } from "lucide-react";
import type { AdsGroupRow, MetricKey, Metrics } from "@/lib/ads-warehouse/query";
import { METRIC_BY_KEY, deltaPct, deltaTone, fmtMetric, toneVs } from "@/lib/ads-warehouse/metrics-ui";
import { StatusDot, TagChips, colorFor, adImageSrc, ScoreGauge, TrendText } from "./shared";
import { launchSignals, SIGNAL_CLASS } from "@/lib/ads-warehouse/signals";

/** Rank colours of the chart metrics (Motion: violet, coral, green, amber, blue, magenta). */
export const RANK_SWATCH = ["bg-violet-500 text-white", "bg-rose-500 text-white", "bg-emerald-500 text-white", "bg-amber-500 text-gray-900", "bg-sky-500 text-white", "bg-fuchsia-500 text-white"];

type SortKey = MetricKey | "name" | "adCount" | "launch";

interface Props {
  rows: AdsGroupRow[];
  /** Table columns (Motion's column preset). */
  columns: MetricKey[];
  /** The chart's numbered metrics (max 6). */
  chartMetrics: MetricKey[];
  onToggleChartMetric: (k: MetricKey) => void;
  benchmark: Metrics;
  benchmarkPrevious: Metrics | null;
  currency: string | null;
  compare: boolean;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (key: SortKey) => void;
  selected: Set<string>;
  onSelect: (key: string, on: boolean) => void;
  onSelectAll: (on: boolean) => void;
  onOpen: (row: AdsGroupRow) => void;
  signals?: boolean;
  groupNoun: { one: string; many: string };
}

const fmtLaunch = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const DELTA = { good: "text-emerald-400", bad: "text-red-400", neutral: "text-gray-500" } as const;

export function AdsTable({ rows, columns, chartMetrics, onToggleChartMetric, benchmark, benchmarkPrevious, currency, compare, sort, onSort, selected, onSelect, onSelectAll, onOpen, signals, groupNoun }: Props) {
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.key));
  const sortIcon = (k: SortKey) => (sort.key === k ? (sort.dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />);

  const cell = (m: Metrics, prev: Metrics | null, k: MetricKey) => {
    const v = m[k];
    if (METRIC_BY_KEY[k]?.format === "score") return <td key={k} className="border-b border-gray-800 px-3 text-left text-sm whitespace-nowrap"><ScoreGauge value={v} /></td>;
    const good = toneVs(k, v, benchmark[k]) === "good";
    const d = compare && prev ? deltaPct(v, prev[k]) : null;
    return (
      <td key={k} className={`border-b border-gray-800 px-3 text-left text-sm tabular-nums whitespace-nowrap ${good ? "bg-emerald-500/15 text-emerald-200" : "text-gray-200"}`}>
        {fmtMetric(k, v, currency, m)}
        {d !== null && <div className={`text-[11px] ${DELTA[deltaTone(k, d)]}`}>{d > 0 ? "+" : ""}{d.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} %</div>}
      </td>
    );
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-separate border-spacing-0">
        <thead>
          <tr className="h-10 text-xs text-gray-400">
            <th className="sticky left-0 z-10 bg-gray-900 border-b border-gray-800 pl-4 pr-3 text-left font-normal min-w-[340px]">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={allOn} onChange={(e) => onSelectAll(e.target.checked)} className="accent-violet-500 w-3.5 h-3.5" />
                {selected.size} {selected.size > 1 ? groupNoun.many : groupNoun.one} sélectionné{selected.size > 1 ? "s" : ""}
              </label>
            </th>
            <th className="border-b border-gray-800 px-3 text-left font-normal whitespace-nowrap"><button type="button" onClick={() => onSort("launch")} className="inline-flex items-center gap-1 hover:text-white">Lancement {sortIcon("launch")}</button></th>
            <th className="border-b border-gray-800 px-3 text-left font-normal min-w-[140px]">Tags</th>
            {columns.map((k) => {
              const rank = chartMetrics.indexOf(k);
              return (
                <th key={k} className="border-b border-gray-800 px-3 text-left font-normal whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    <button type="button" onClick={() => onToggleChartMetric(k)} title={rank >= 0 ? "Retirer du graphique" : chartMetrics.length >= 6 ? "6 métriques au maximum dans le graphique" : "Ajouter au graphique"} className="shrink-0">
                      {rank >= 0
                        ? <span className={`w-4 h-4 rounded-[4px] text-[10px] font-semibold flex items-center justify-center ${RANK_SWATCH[rank]}`}>{rank + 1}</span>
                        : <span className="block w-3.5 h-3.5 rounded-[4px] border border-gray-600 hover:border-gray-400" />}
                    </button>
                    <button type="button" onClick={() => onSort(k)} title={METRIC_BY_KEY[k]?.hint} className={`inline-flex items-center gap-1 hover:text-white ${sort.key === k ? "text-white" : ""}`}>{METRIC_BY_KEY[k]?.label ?? k} {sortIcon(k)}</button>
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ad = r.sample;
            const img = adImageSrc(ad);
            return (
              <tr key={r.key} className="group h-14">
                <td className="sticky left-0 z-10 bg-gray-900 group-hover:bg-gray-800 border-b border-gray-800 pl-4 pr-3">
                  <div className="flex items-center gap-3">
                    <input type="checkbox" checked={selected.has(r.key)} onChange={(e) => onSelect(r.key, e.target.checked)} className="accent-violet-500 w-3.5 h-3.5 shrink-0" />
                    <button type="button" onClick={() => onOpen(r)} className="flex items-center gap-3 min-w-0 text-left">
                      {/* eslint-disable-next-line @next/next/no-img-element -- platform CDNs */}
                      {img ? <img src={img} alt="" className="w-10 h-10 rounded-md object-cover bg-gray-800 shrink-0" /> : <span className={`w-10 h-10 rounded-md bg-gradient-to-br ${colorFor(r.key)} shrink-0`} />}
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5"><StatusDot status={ad?.status} /><span className="text-sm text-white truncate max-w-[240px] block" title={r.label}>{r.label}</span></span>
                        <span className="flex items-center gap-1.5 text-xs text-gray-500">
                          {r.adCount} {r.adCount > 1 ? "annonces" : "annonce"}
                          {r.trend && r.trend.state !== "stable" && r.trend.state !== "testing" && <>· <TrendText trend={r.trend} /></>}
                        </span>
                      </span>
                    </button>
                  </div>
                </td>
                <td className="border-b border-gray-800 px-3 text-sm text-gray-300 whitespace-nowrap">{r.launch ? fmtLaunch(r.launch) : "—"}</td>
                <td className="border-b border-gray-800 px-3 max-w-[220px]">
                  {signals && <div className="flex flex-wrap gap-1 mb-0.5">{launchSignals(r.metrics, benchmark, { video: ad?.format === "Video" }).map((x) => <span key={x.id} title={x.hint} className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${SIGNAL_CLASS[x.tone]}`}>{x.label}</span>)}</div>}
                  {ad ? <TagChips tags={ad.tags} max={2} /> : null}
                </td>
                {columns.map((k) => cell(r.metrics, r.previous, k))}
              </tr>
            );
          })}
          <tr className="h-14">
            <td className="sticky left-0 z-10 bg-gray-900 pl-4 pr-3 text-sm font-medium text-white"><span className="inline-flex items-center gap-1.5" title="Total du compte sur la période ; moyenne par ligne pour les sommes, du compte entier pour les taux">Résultat net <Info className="w-3.5 h-3.5 text-gray-500" /></span></td>
            <td /><td />
            {columns.map((k) => {
              const def = METRIC_BY_KEY[k];
              const additive = def?.higherBetter === null && def.format !== "ratio";
              const avg = rows.length ? rows.reduce((s, r) => s + r.metrics[k], 0) / rows.length : 0;
              const d = compare && benchmarkPrevious ? deltaPct(benchmark[k], benchmarkPrevious[k]) : null;
              return (
                <td key={k} className="px-3 text-left text-xs tabular-nums whitespace-nowrap">
                  <div className="text-gray-100">{additive ? fmtMetric(k, benchmark[k], currency, benchmark) : "-"}</div>
                  <div className="text-gray-500">Moy. {additive ? fmtMetric(k, avg, currency) : def?.format === "score" ? "50" : fmtMetric(k, benchmark[k], currency, benchmark)}</div>
                  {d !== null && <div className={DELTA[deltaTone(k, d)]}>{d > 0 ? "+" : ""}{d.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} %</div>}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
