"use client";

/**
 * Motion-style creative card: visual on top (format badge), name, "N annonces",
 * stacked metrics coloured against the account benchmark, period-over-period
 * deltas when a comparison is active, convention tags.
 */

import type { AdsGroupRow, MetricKey, Metrics } from "@/lib/ads-warehouse/query";
import { METRIC_BY_KEY, TONE_CLASS, deltaPct, deltaTone, fmtMetric, toneVs } from "@/lib/ads-warehouse/metrics-ui";
import { AdVisual, FormatBadge, StatusDot, TagChips, relativeDay } from "./shared";

interface Props {
  row: AdsGroupRow;
  metrics: MetricKey[];
  benchmark: Metrics;
  currency: string | null;
  compare: boolean;
  onOpen: (row: AdsGroupRow) => void;
}

export function AdCard({ row, metrics, benchmark, currency, compare, onOpen }: Props) {
  const ad = row.sample;
  return (
    <button type="button" onClick={() => onOpen(row)} className="text-left rounded-2xl border border-gray-800 bg-gray-900 hover:border-violet-500/50 transition-colors overflow-hidden flex flex-col">
      <div className="relative">
        <AdVisual ad={ad} ads={row.adCount > 1 ? row.ads : undefined} />
        <FormatBadge ad={ad} />
        {row.adCount > 1 && <span className="absolute right-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">{row.adCount} annonces</span>}
      </div>
      <div className="p-3 space-y-2">
        <div>
          <div className="flex items-center gap-1.5">
            <StatusDot status={ad?.status} />
            <div className="text-xs font-medium text-white truncate" title={row.label}>{row.label}</div>
          </div>
          <div className="text-[10px] text-gray-500 truncate">
            {ad?.campaignName ?? ""}{row.launch ? ` · lancée ${relativeDay(row.launch)}` : ""}
          </div>
        </div>
        <div className="space-y-1">
          {metrics.map((k) => {
            const def = METRIC_BY_KEY[k];
            if (!def) return null;
            if (def.video && ad && ad.format !== "Video" && row.metrics.videoPlays === 0) return null;
            const v = row.metrics[k];
            const d = compare && row.previous ? deltaPct(v, row.previous[k]) : null;
            return (
              <div key={k} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-gray-500" title={def.hint}>{def.label}</span>
                <span className="flex items-center gap-1.5">
                  {d !== null && <span className={`text-[10px] ${deltaTone(k, d) === "good" ? "text-emerald-400" : deltaTone(k, d) === "bad" ? "text-red-400" : "text-gray-500"}`}>{d > 0 ? "+" : ""}{d.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} %</span>}
                  <span className={`rounded-md px-1.5 py-0.5 font-semibold tabular-nums ${TONE_CLASS[toneVs(k, v, benchmark[k])]}`}>{fmtMetric(k, v, currency, row.metrics)}</span>
                </span>
              </div>
            );
          })}
        </div>
        {ad && <TagChips tags={ad.tags} />}
      </div>
    </button>
  );
}
