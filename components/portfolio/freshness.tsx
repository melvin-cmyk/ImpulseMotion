"use client";

import Link from "next/link";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { errorKindLabel, fmtTime } from "@/components/portfolio/format";

/** "1 – 30 août 2026 · 30 j · données au 14:32 · [Actualiser]" */
export function Freshness({
  rangeLabel,
  fetchedAt,
  onRefresh,
  refreshing,
  timedOut,
  className,
}: {
  rangeLabel?: string | null;
  fetchedAt?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  timedOut?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2 flex-wrap text-xs text-gray-400 ${className ?? ""}`}>
      {rangeLabel && <span className="text-gray-300">{rangeLabel}</span>}
      {fetchedAt && <span className="text-gray-500">· données au {fmtTime(fetchedAt)}</span>}
      {timedOut && (
        <span className="inline-flex items-center gap-1 text-amber-400" title="Le budget de temps a été atteint : certains clients n'ont pas été résolus.">
          <AlertTriangle className="w-3 h-3" /> résultats partiels
        </span>
      )}
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-gray-800 bg-gray-900 text-gray-300 hover:text-white hover:border-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
          title="Recharger depuis Meta / Google (ignore le cache)"
        >
          {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          {refreshing ? "Actualisation…" : "Actualiser"}
        </button>
      )}
    </div>
  );
}

export interface WithoutDataItem {
  id: string;
  name: string;
  error: { kind: string; message: string } | null;
}

/** "N clients sans données Meta (détail)" with the error kind in plain French. */
export function WithoutDataBanner({ items, unlinked }: { items: WithoutDataItem[]; unlinked?: Array<{ id: string; name: string }> }) {
  const hasUnlinked = !!unlinked && unlinked.length > 0;
  if (items.length === 0 && !hasUnlinked) return null;
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200 space-y-2">
      {items.length > 0 && (
        <details>
          <summary className="cursor-pointer inline-flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            {items.length} client{items.length > 1 ? "s" : ""} sans données Meta
            <span className="text-xs text-amber-400/80">(détail)</span>
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-amber-100/90">
            {items.map((c) => (
              <li key={c.id} className="flex items-start gap-2">
                <Link href={`/portfolio/${c.id}`} className="font-medium text-white hover:text-violet-300 shrink-0">{c.name}</Link>
                <span>— {errorKindLabel(c.error?.kind)}</span>
                {c.error?.message && <span className="text-amber-400/60 truncate" title={c.error.message}>· {c.error.message}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {hasUnlinked && (
        <details>
          <summary className="cursor-pointer text-xs text-amber-300/90">
            {unlinked!.length} dashboard{unlinked!.length > 1 ? "s" : ""} sans compte publicitaire (exclu{unlinked!.length > 1 ? "s" : ""} du portefeuille)
          </summary>
          <ul className="mt-1 space-y-0.5 text-xs text-amber-100/80">
            {unlinked!.map((d) => (
              <li key={d.id}><Link href={`/d/${d.id}`} className="hover:text-white">{d.name}</Link> — liez un compte Meta ou Google dans ses réglages</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Grey "n/d" KPI card for a metric that could not be resolved. */
export function KpiUnavailable({ label, reason, compact }: { label: string; reason?: string; compact?: boolean }) {
  return (
    <div className={`bg-gray-900/60 border border-dashed border-gray-800 rounded-xl ${compact ? "px-3 py-2" : "px-3 py-2.5"}`} title={reason}>
      <div className="text-[10px] uppercase tracking-wider text-gray-600 font-semibold">{label}</div>
      <div className="text-lg font-bold text-gray-600 tabular-nums mt-0.5">n/d</div>
      {reason && !compact && <div className="text-[11px] text-gray-600 truncate">{reason}</div>}
    </div>
  );
}
