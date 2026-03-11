import { Creative } from "./mock-data";

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
 *   Hook    → 15% hook rate (3s view rate)
 *   Watch   → 50% video_p75 watch rate
 *   Click   → 3% CTR
 *   Convert → ROAS 4
 */
export function calculateFunnelScores(creative: Creative): FunnelScores {
  const clamp = (v: number) => Math.min(100, Math.max(0, Math.round(v)));

  const hook =
    creative.hookRate > 0
      ? clamp((creative.hookRate / 15) * 100)
      : null;

  const watch =
    creative.format === "Video" && creative.videoP75Rate != null
      ? clamp((creative.videoP75Rate / 50) * 100)
      : null;

  const click =
    creative.ctr > 0
      ? clamp((creative.ctr / 3) * 100)
      : null;

  const convert =
    creative.roas > 0
      ? clamp((creative.roas / 4) * 100)
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
