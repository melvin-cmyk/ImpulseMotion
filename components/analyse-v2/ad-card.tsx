"use client";

/**
 * Motion-style creative card (layout taken from Motion's DOM): uncropped media
 * frame with the format or "N annonces" caption bottom-left (inline video for
 * Meta), one-line name, then up to 6 "label | value pill" rows coloured
 * against the account benchmark, with period-over-period deltas when a
 * comparison is active. Campaign, tags and copy live in the drawer.
 */

import type { AdsGroupRow, MetricKey, Metrics } from "@/lib/ads-warehouse/query";
import { METRIC_BY_KEY, TONE_CLASS, deltaPct, deltaTone, fmtMetric, toneVs } from "@/lib/ads-warehouse/metrics-ui";
import { FORMAT_LABEL, ScoreGauge, StatusDot, TrendBadge } from "./shared";
import { AdMedia, MediaCaption, type MediaRatio } from "./ad-media";
import { launchSignals, SIGNAL_CLASS } from "@/lib/ads-warehouse/signals";

interface Props {
  row: AdsGroupRow;
  metrics: MetricKey[];
  benchmark: Metrics;
  currency: string | null;
  compare: boolean;
  /** Launch report: show the launch signals (Gagnante, Top hook, Top clic…). */
  signals?: boolean;
  ratio?: MediaRatio;
  /** Opportunity label (Motion's 🚩 suggested iteration), shown under the name. */
  flag?: string | null;
  onOpen: (row: AdsGroupRow) => void;
}

export function AdCard({ row, metrics, benchmark, currency, compare, signals, ratio, flag, onOpen }: Props) {
  const ad = row.sample;
  const sig = signals ? launchSignals(row.metrics, benchmark, { video: ad?.format === "Video" }) : [];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(row)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(row); } }}
      className="text-left rounded-2xl border border-gray-800 bg-gray-900 hover:border-violet-500/50 transition-colors overflow-hidden flex flex-col cursor-pointer min-w-0"
    >
      <AdMedia
        ad={ad}
        ads={row.adCount > 1 ? row.ads : undefined}
        ratio={ratio}
        onOpen={() => onOpen(row)}
        badge={<TrendBadge trend={row.trend} />}
        caption={<>
          <MediaCaption>{row.adCount > 1 ? `${row.adCount} annonces` : FORMAT_LABEL[ad?.format ?? "Unknown"] ?? ad?.format}</MediaCaption>
          {ad?.dynamic && <MediaCaption tone="accent">Dynamic</MediaCaption>}
        </>}
      />
      <div className="px-3 pt-2 pb-3 space-y-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <StatusDot status={ad?.status} />
          <div className="text-sm font-medium text-white truncate" title={row.label}>{row.label}</div>
        </div>
        {flag && <div><span className="rounded-md bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-200">🚩 {flag}</span></div>}
        {sig.length > 0 && <div className="flex flex-wrap gap-1">{sig.map((x) => <span key={x.id} title={x.hint} className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${SIGNAL_CLASS[x.tone]}`}>{x.label}</span>)}</div>}
        <div className="space-y-1">
          {metrics.map((k) => {
            const def = METRIC_BY_KEY[k];
            if (!def) return null;
            if (def.video && ad && ad.format !== "Video" && row.metrics.videoPlays === 0) return null;
            const v = row.metrics[k];
            const d = compare && row.previous ? deltaPct(v, row.previous[k]) : null;
            return (
              <div key={k} className="flex items-center justify-between gap-3 text-[13px]">
                <span className="text-gray-500" title={def.hint}>{def.label}</span>
                <span className="flex items-center gap-1.5">
                  {d !== null && <span className={`text-[10px] ${deltaTone(k, d) === "good" ? "text-emerald-400" : deltaTone(k, d) === "bad" ? "text-red-400" : "text-gray-500"}`}>{d > 0 ? "+" : ""}{d.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} %</span>}
                  {def.format === "score"
                    ? <span className="p-1"><ScoreGauge value={v} /></span>
                    : <span className={`rounded-md p-1 tabular-nums ${TONE_CLASS[toneVs(k, v, benchmark[k])]}`}>{fmtMetric(k, v, currency, row.metrics)}</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
