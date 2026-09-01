import type { Creative } from "./creative-types";

export interface FunnelScores {
  hook: number | null;   // 0–100, null if no data
  watch: number | null;  // 0–100, null if no video data
  click: number | null;  // 0–100
  convert: number | null; // 0–100
}

/**
 * Calculate Motion-style funnel scores (0–100) for a creative.
 *
 * Benchmarks (= 100):
 *   Hook    → 15 % hook rate (video plays / impressions)
 *   Watch   → 40 % hold rate (ThruPlay / impressions) — same definition as
 *             `holdRate` everywhere (modal, tables)
 *   Click   → 3 % CTR
 *   Convert → ROAS 4 (null when ROAS is unknown / unavailable)
 */
export const FUNNEL_BENCHMARKS = { hook: 15, watch: 40, click: 3, convert: 4 } as const;
export function calculateFunnelScores(creative: Creative): FunnelScores {
  const clamp = (v: number) => Math.min(100, Math.max(0, Math.round(v)));

  const hook =
    creative.format === "Video" && creative.hookRate > 0
      ? clamp((creative.hookRate / FUNNEL_BENCHMARKS.hook) * 100)
      : null;

  const watch =
    creative.format === "Video" && creative.holdRate > 0
      ? clamp((creative.holdRate / FUNNEL_BENCHMARKS.watch) * 100)
      : null;

  const click =
    creative.ctr > 0
      ? clamp((creative.ctr / FUNNEL_BENCHMARKS.click) * 100)
      : null;

  const convert =
    creative.roas !== null && creative.roas !== undefined && !creative.roasUnavailable && creative.roas > 0
      ? clamp((creative.roas / FUNNEL_BENCHMARKS.convert) * 100)
      : null;

  return { hook, watch, click, convert };
}

export function scoreColor(score: number | null): string {
  if (score === null) return "bg-gray-700";
  if (score >= 67) return "bg-emerald-500";
  if (score >= 34) return "bg-amber-400";
  return "bg-red-500";
}

export function scoreTextColor(score: number | null): string {
  if (score === null) return "text-gray-500";
  if (score >= 67) return "text-emerald-400";
  if (score >= 34) return "text-amber-400";
  return "text-red-400";
}
