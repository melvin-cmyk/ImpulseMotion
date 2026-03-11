"use client";

import { FunnelScores, scoreColor, scoreTextColor } from "@/lib/funnel-scores";

interface FunnelScoresBarProps {
  scores: FunnelScores;
  compact?: boolean;
}

const LABELS = [
  { key: "hook" as const, label: "Hook" },
  { key: "watch" as const, label: "Watch" },
  { key: "click" as const, label: "Click" },
  { key: "convert" as const, label: "Convert" },
];

export function FunnelScoresBar({ scores, compact = false }: FunnelScoresBarProps) {
  if (compact) {
    return (
      <div className="flex gap-1.5 items-center">
        {LABELS.map(({ key, label }) => {
          const score = scores[key];
          return (
            <div key={key} className="flex flex-col items-center gap-0.5">
              <span className={`text-[10px] font-bold ${scoreTextColor(score)}`}>
                {score !== null ? score : "—"}
              </span>
              <div className="w-8 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${scoreColor(score)}`}
                  style={{ width: score !== null ? `${score}%` : "0%" }}
                />
              </div>
              <span className="text-[8px] text-gray-600 uppercase tracking-wide">{label}</span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {LABELS.map(({ key, label }) => {
        const score = scores[key];
        return (
          <div key={key} className="flex items-center gap-3">
            <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold w-14 shrink-0">
              {label}
            </span>
            <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${scoreColor(score)}`}
                style={{ width: score !== null ? `${score}%` : "0%" }}
              />
            </div>
            <span className={`text-xs font-bold w-6 text-right ${scoreTextColor(score)}`}>
              {score !== null ? score : "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
