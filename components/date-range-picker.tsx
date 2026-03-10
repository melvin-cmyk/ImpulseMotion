"use client";

import { useCreativesContext, DatePreset } from "@/lib/creatives-context";
import { Calendar } from "lucide-react";

const PRESETS: { days: DatePreset; label: string }[] = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

export function DateRangePicker() {
  const { dateRange, datePreset, setDatePreset, setDateRange } = useCreativesContext();

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Preset buttons */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
        {PRESETS.map(({ days, label }) => (
          <button
            key={days}
            onClick={() => setDatePreset(days)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              datePreset === days
                ? "bg-violet-600 text-white"
                : "text-gray-400 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Custom date inputs */}
      <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-xl px-3 py-1.5">
        <Calendar className="w-4 h-4 text-gray-500 shrink-0" />
        <input
          type="date"
          value={dateRange.since}
          max={dateRange.until}
          onChange={(e) =>
            setDateRange({ since: e.target.value, until: dateRange.until })
          }
          className="bg-transparent text-gray-300 text-sm outline-none cursor-pointer w-32"
        />
        <span className="text-gray-600 text-sm">—</span>
        <input
          type="date"
          value={dateRange.until}
          min={dateRange.since}
          onChange={(e) =>
            setDateRange({ since: dateRange.since, until: e.target.value })
          }
          className="bg-transparent text-gray-300 text-sm outline-none cursor-pointer w-32"
        />
      </div>
    </div>
  );
}
