"use client";

/**
 * Motion-style table: thumbnail + name + "N annonces" + launch date, one
 * column per metric with green / red colouring against the account average,
 * which sits in the LAST row ("Moyenne du compte"). Checkboxes feed the chart view.
 */

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { AdsGroupRow, MetricKey, Metrics } from "@/lib/ads-warehouse/query";
import { METRIC_BY_KEY, TONE_CLASS, deltaPct, deltaTone, fmtMetric, toneVs } from "@/lib/ads-warehouse/metrics-ui";
import { upgradeImageUrl } from "@/lib/image-upgrade";
import { StatusDot, TagChips, colorFor } from "./shared";
import { launchSignals, SIGNAL_CLASS } from "@/lib/ads-warehouse/signals";

interface Props {
  rows: AdsGroupRow[];
  metrics: MetricKey[];
  benchmark: Metrics;
  benchmarkPrevious: Metrics | null;
  currency: string | null;
  compare: boolean;
  sort: { key: MetricKey | "name" | "adCount" | "launch"; dir: "asc" | "desc" };
  onSort: (key: MetricKey | "name" | "adCount" | "launch") => void;
  checked: Set<string>;
  onCheck: (key: string, on: boolean) => void;
  onOpen: (row: AdsGroupRow) => void;
  signals?: boolean;
}

export function AdsTable({ rows, metrics, benchmark, benchmarkPrevious, currency, compare, sort, onSort, checked, onCheck, onOpen, signals }: Props) {
  const th = (key: Props["sort"]["key"], label: string, align = "text-right", hint?: string) => (
    <th key={String(key)} className={`${align} px-2 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap`}>
      <button type="button" onClick={() => onSort(key)} title={hint ?? "Trier"} className={`inline-flex items-center gap-1 hover:text-white ${sort.key === key ? "text-violet-300" : ""}`}>
        {label} {sort.key === key ? (sort.dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-50" />}
      </button>
    </th>
  );
  const cell = (m: Metrics, prev: Metrics | null, k: MetricKey, bench: boolean) => {
    const v = m[k];
    const d = compare && prev ? deltaPct(v, prev[k]) : null;
    return (
      <td key={k} className="px-2 py-1.5 text-right">
        <span className={`inline-block rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums ${bench ? "bg-gray-800 text-gray-100" : TONE_CLASS[toneVs(k, v, benchmark[k])]}`}>{fmtMetric(k, v, currency, m)}</span>
        {d !== null && <div className={`text-[10px] ${deltaTone(k, d) === "good" ? "text-emerald-400" : deltaTone(k, d) === "bad" ? "text-red-400" : "text-gray-500"}`}>{d > 0 ? "+" : ""}{d.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} %</div>}
      </td>
    );
  };
  return (
    <div className="overflow-x-auto rounded-2xl border border-gray-800 bg-gray-900">
      <table className="w-full text-sm">
        <thead className="bg-gray-950/50">
          <tr>
            <th className="w-8 px-2" />
            {th("name", "Créa", "text-left")}
            {th("adCount", "Ann.", "text-right", "Nombre d'annonces regroupées")}
            {th("launch", "Lancée", "text-left")}
            <th className="text-left px-2 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Tags</th>
            {metrics.map((k, i) => th(k, `${i + 1} ${METRIC_BY_KEY[k]?.short ?? k}`, "text-right", METRIC_BY_KEY[k]?.hint))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ad = r.sample;
            const img = upgradeImageUrl(ad?.thumbnailUrl ?? ad?.imageUrl ?? undefined);
            return (
              <tr key={r.key} className="border-t border-gray-800 hover:bg-gray-800/30">
                <td className="px-2 py-1.5"><input type="checkbox" checked={checked.has(r.key)} onChange={(e) => onCheck(r.key, e.target.checked)} className="accent-violet-500" title="Tracer dans la courbe" /></td>
                <td className="px-2 py-1.5">
                  <button type="button" onClick={() => onOpen(r)} className="flex items-center gap-2 text-left min-w-[220px] max-w-[360px]">
                    {/* eslint-disable-next-line @next/next/no-img-element -- Meta CDN thumbnails, many hosts, no optimisation wanted */}
                    {img ? <img src={img} alt="" className="w-9 h-9 rounded-md object-cover bg-gray-800 shrink-0" /> : <div className={`w-9 h-9 rounded-md bg-gradient-to-br ${colorFor(r.key)} shrink-0`} />}
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5"><StatusDot status={ad?.status} /><span className="text-xs font-medium text-white truncate block" title={r.label}>{r.label}</span></span>
                      <span className="text-[10px] text-gray-500 truncate block">{ad?.campaignName ?? ""}</span>
                    </span>
                  </button>
                </td>
                <td className="px-2 py-1.5 text-right text-xs text-gray-400 tabular-nums">{r.adCount}</td>
                <td className="px-2 py-1.5 text-left text-[11px] text-gray-400 whitespace-nowrap">{r.launch ? new Date(r.launch + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }) : "—"}</td>
                <td className="px-2 py-1.5 max-w-[220px]">
                  {signals && <div className="flex flex-wrap gap-1 mb-0.5">{launchSignals(r.metrics, benchmark, { video: ad?.format === "Video" }).map((x) => <span key={x.id} title={x.hint} className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${SIGNAL_CLASS[x.tone]}`}>{x.label}</span>)}</div>}
                  {ad ? <TagChips tags={ad.tags} max={3} /> : null}
                </td>
                {metrics.map((k) => cell(r.metrics, r.previous, k, false))}
              </tr>
            );
          })}
          <tr className="border-t-2 border-gray-700 bg-gray-950/60">
            <td />
            <td className="px-2 py-2 text-xs font-semibold text-gray-300">Résultat net<div className="text-[10px] font-normal text-gray-500">total du compte · moy. par ligne</div></td>
            <td className="px-2 py-2 text-right text-xs text-gray-500">{rows.reduce((s, r) => s + r.adCount, 0)}</td>
            <td /><td />
            {metrics.map((k) => {
              const def = METRIC_BY_KEY[k];
              const additive = def?.higherBetter === null && def.format !== "ratio";
              const avg = rows.length ? rows.reduce((s, r) => s + r.metrics[k], 0) / rows.length : 0;
              return (
                <td key={k} className="px-2 py-1.5 text-right">
                  <span className="inline-block rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums bg-gray-800 text-gray-100">{fmtMetric(k, benchmark[k], currency, benchmark)}</span>
                  <div className="text-[10px] text-gray-500">{additive ? `moy. ${fmtMetric(k, avg, currency)}` : "moy. compte"}</div>
                  {compare && benchmarkPrevious && (() => { const d = deltaPct(benchmark[k], benchmarkPrevious[k]); return d === null ? null : <div className={`text-[10px] ${deltaTone(k, d) === "good" ? "text-emerald-400" : deltaTone(k, d) === "bad" ? "text-red-400" : "text-gray-500"}`}>{d > 0 ? "+" : ""}{d.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} %</div>; })()}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
