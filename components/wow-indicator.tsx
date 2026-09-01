"use client";

/**
 * WoW (Week-over-Week) indicator components.
 *
 * WowChip — a compact inline chip showing ↑/↓ % change with colour coding.
 * WowBanner — a full-width summary banner showing aggregate WoW metrics.
 */

import type { WowMetrics } from "@/lib/creative-types";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Determine whether a change in this metric is "good" (green) or "bad" (red).
 *
 * Good directions:
 *   CTR up, ROAS up, Hook Rate up, Spend up  → green
 *   CPA down                                 → green (lower is better)
 *   CPA up                                   → red
 *   CTR down, ROAS down, Hook Rate down, Spend down → red
 */
function isGoodChange(metricKey: keyof WowMetrics, change: number): boolean {
  if (metricKey === "cpaChange") {
    return change < 0; // lower CPA is better
  }
  return change > 0; // all others: higher is better
}

function formatPct(n: number): string {
  const abs = Math.abs(n);
  const sign = n > 0 ? "+" : "-";
  return `${sign}${abs.toFixed(1)}%`;
}

// ── WowChip ───────────────────────────────────────────────────────────────────

interface WowChipProps {
  metricKey: keyof WowMetrics;
  change: number | null | undefined;
  label?: string;
  className?: string;
}

export function WowChip({ metricKey, change, label, className = "" }: WowChipProps) {
  if (change === null || change === undefined) {
    return (
      <span
        className={`inline-flex items-center gap-0.5 text-[10px] font-medium text-gray-600 ${className}`}
      >
        {label && <span className="text-gray-700">{label}</span>}
        <Minus className="w-2.5 h-2.5" />
        <span>N/A</span>
      </span>
    );
  }

  const good = isGoodChange(metricKey, change);
  const colorClass = good ? "text-emerald-400" : "text-red-400";
  const Icon = change > 0 ? TrendingUp : TrendingDown;

  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] font-semibold ${colorClass} ${className}`}
      title={`WoW ${label ?? metricKey}: ${formatPct(change)}`}
    >
      {label && <span className="text-gray-500 font-normal">{label}</span>}
      <Icon className="w-2.5 h-2.5 shrink-0" />
      <span>{formatPct(change)}</span>
    </span>
  );
}

// ── WowBanner ─────────────────────────────────────────────────────────────────

interface WowBannerProps {
  wow: WowMetrics;
  currentPeriod: { since: string; until: string };
  prevPeriod: { since: string; until: string };
}

interface WowBannerMetric {
  key: keyof WowMetrics;
  label: string;
  description: string;
}

const BANNER_METRICS: WowBannerMetric[] = [
  { key: "spendChange", label: "Spend", description: "Total ad spend" },
  { key: "roasChange", label: "ROAS", description: "Return on ad spend" },
  { key: "ctrChange", label: "CTR", description: "Click-through rate" },
  { key: "cpaChange", label: "CPA", description: "Cost per acquisition" },
  { key: "hookRateChange", label: "Hook", description: "Démarrages vidéo / impressions" },
];

export function WowBanner({ wow, currentPeriod, prevPeriod }: WowBannerProps) {
  // Determine overall sentiment: count good vs bad signals
  let goodCount = 0;
  let badCount = 0;
  for (const m of BANNER_METRICS) {
    const change = wow[m.key];
    if (change === null) continue;
    if (isGoodChange(m.key, change)) goodCount++;
    else badCount++;
  }

  const sentiment =
    goodCount > badCount
      ? "positive"
      : badCount > goodCount
      ? "negative"
      : "neutral";

  const borderColor =
    sentiment === "positive"
      ? "border-emerald-800/50"
      : sentiment === "negative"
      ? "border-red-800/50"
      : "border-gray-800";

  const headerBg =
    sentiment === "positive"
      ? "bg-emerald-500/10"
      : sentiment === "negative"
      ? "bg-red-500/10"
      : "bg-gray-800/40";

  const headerText =
    sentiment === "positive"
      ? "text-emerald-300"
      : sentiment === "negative"
      ? "text-red-300"
      : "text-gray-400";

  const sentimentLabel =
    sentiment === "positive"
      ? "Trending Up"
      : sentiment === "negative"
      ? "Trending Down"
      : "Mixed Signals";

  return (
    <div
      className={`bg-gray-900 border ${borderColor} rounded-2xl overflow-hidden`}
    >
      {/* Header */}
      <div className={`${headerBg} px-5 py-3.5 flex items-center justify-between`}>
        <div className="flex items-center gap-3">
          <div>
            <h2 className={`text-sm font-semibold ${headerText}`}>
              Week over Week — {sentimentLabel}
            </h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {currentPeriod.since} → {currentPeriod.until}
              <span className="mx-1.5 text-gray-700">vs</span>
              {prevPeriod.since} → {prevPeriod.until}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
          <span>{goodCount} up</span>
          <span className="w-2 h-2 rounded-full bg-red-500 inline-block ml-2" />
          <span>{badCount} down</span>
        </div>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-y divide-gray-800/60">
        {BANNER_METRICS.map((m) => {
          const change = wow[m.key];
          const hasData = change !== null;
          const good = hasData ? isGoodChange(m.key, change!) : null;
          const valueColor = !hasData
            ? "text-gray-600"
            : good
            ? "text-emerald-400"
            : "text-red-400";
          const Icon =
            !hasData
              ? Minus
              : (change ?? 0) > 0
              ? TrendingUp
              : TrendingDown;

          return (
            <div key={m.key} className="px-5 py-4 flex flex-col gap-1">
              <span className="text-[10px] text-gray-500 uppercase tracking-wide">
                {m.label}
              </span>
              <div className={`flex items-center gap-1.5 ${valueColor}`}>
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="text-lg font-bold">
                  {hasData ? formatPct(change!) : "N/A"}
                </span>
              </div>
              <span className="text-[10px] text-gray-600">{m.description}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
