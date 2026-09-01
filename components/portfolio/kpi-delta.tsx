"use client";

import { cn } from "@/lib/utils";
import { fmtMoney, PACING_STATUS_LABEL } from "@/components/portfolio/format";

export { fmtMoney, fmtMetric, fmtRoas, fmtNumber, fmtPct, fmtTime, errorKindLabel } from "@/components/portfolio/format";

/** Metrics where a decrease is good. */
const INVERTED = new Set(["cpa", "cpc", "cpm"]);

export function deltaTone(metric: string, deltaPct: number | null): "good" | "bad" | "neutral" {
  if (deltaPct === null || Math.abs(deltaPct) < 0.5 || metric === "spend") return "neutral";
  const up = deltaPct > 0;
  return INVERTED.has(metric) ? (up ? "bad" : "good") : up ? "good" : "bad";
}

export function DeltaBadge({ metric, deltaPct, className }: { metric: string; deltaPct: number | null | undefined; className?: string }) {
  if (deltaPct === null || deltaPct === undefined) return <span className={cn("text-[11px] text-gray-600", className)}>—</span>;
  const tone = deltaTone(metric, deltaPct);
  return (
    <span
      className={cn(
        "text-[11px] font-semibold tabular-nums",
        tone === "good" && "text-emerald-400",
        tone === "bad" && "text-red-400",
        tone === "neutral" && "text-gray-500",
        className,
      )}
    >
      {deltaPct > 0 ? "+" : ""}{deltaPct.toFixed(1)} %
    </span>
  );
}

export interface PacingLike {
  pacingPct: number;
  status: string;
  daysElapsed: number;
  daysInMonth: number;
  mtdSpend: number;
  projectedSpend: number;
  monthlyTarget: number;
  currency?: string;
  reason?: string;
  source?: string;
}

export function PacingBar({ pacing, compact }: { pacing: PacingLike; compact?: boolean }) {
  const unknown = pacing.status === "unknown";
  const critical = pacing.status.startsWith("critical");
  const color = unknown ? "text-gray-500" : pacing.status === "on_track" ? "text-emerald-400" : critical ? "text-red-400" : "text-amber-400";
  const bar = unknown ? "bg-gray-700" : pacing.status === "on_track" ? "bg-emerald-500" : critical ? "bg-red-500" : "bg-amber-500";
  const elapsedPct = Math.round((pacing.daysElapsed / pacing.daysInMonth) * 100);
  const day = Math.floor(pacing.daysElapsed);
  return (
    <div className={compact ? "min-w-[120px]" : ""} title={unknown ? `Pacing inconnu : ${pacing.reason ?? "données Meta indisponibles"}` : PACING_STATUS_LABEL[pacing.status]}>
      <div className="flex items-center justify-between text-[11px] mb-1">
        <span className="text-gray-500">J{day}/{pacing.daysInMonth}</span>
        <span className={`font-bold tabular-nums ${color}`}>{unknown ? "n/d" : `${pacing.pacingPct} %`}</span>
      </div>
      <div className="relative h-1.5 rounded-full bg-gray-800 overflow-hidden">
        <div className={`absolute top-0 bottom-0 ${bar}`} style={{ width: `${unknown ? 0 : Math.min(pacing.pacingPct, 100)}%` }} />
        <div className="absolute top-0 bottom-0 w-px bg-white/30" style={{ left: `${Math.min(elapsedPct, 100)}%` }} />
      </div>
      {!compact && (
        <div className="flex items-center justify-between text-[11px] text-gray-500 mt-1">
          <span>MTD {fmtMoney(pacing.mtdSpend, pacing.currency)}</span>
          <span>Projeté {unknown ? "n/d" : fmtMoney(pacing.projectedSpend, pacing.currency)} / {fmtMoney(pacing.monthlyTarget, pacing.currency)}</span>
        </div>
      )}
      {!compact && unknown && pacing.reason && (
        <div className="text-[11px] text-amber-500/80 mt-1">{pacing.reason}</div>
      )}
    </div>
  );
}
