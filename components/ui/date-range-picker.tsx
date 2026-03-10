"use client";

/**
 * DateRangePicker (components/ui)
 *
 * Global date range picker with preset buttons (7, 14, 30, 90 days).
 * State is synced to URL search params so the selection persists across
 * navigation and can be deep-linked.
 *
 * When no URL params are present the component falls back to the
 * CreativesContext date range (default: last 30 days).
 */

import { useEffect } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCreativesContext, DatePreset } from "@/lib/creatives-context";
import { Calendar } from "lucide-react";

const PRESETS: { days: DatePreset; label: string }[] = [
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

export function DateRangePicker() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { dateRange, datePreset, setDatePreset, setDateRange } =
    useCreativesContext();

  // On mount / URL change: sync URL params → context
  useEffect(() => {
    const urlSince = searchParams.get("since");
    const urlUntil = searchParams.get("until");
    const urlPreset = searchParams.get("preset");

    if (urlPreset) {
      const parsed = parseInt(urlPreset, 10);
      if (parsed === 7 || parsed === 14 || parsed === 30 || parsed === 90) {
        setDatePreset(parsed as DatePreset);
      }
    } else if (urlSince && urlUntil) {
      setDateRange({ since: urlSince, until: urlUntil });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateUrl(params: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    // Clear old params first
    next.delete("since");
    next.delete("until");
    next.delete("preset");
    for (const [k, v] of Object.entries(params)) {
      next.set(k, v);
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  function handlePreset(days: DatePreset) {
    setDatePreset(days);
    updateUrl({ preset: String(days) });
  }

  function handleSinceChange(since: string) {
    setDateRange({ since, until: dateRange.until });
    updateUrl({ since, until: dateRange.until });
  }

  function handleUntilChange(until: string) {
    setDateRange({ since: dateRange.since, until });
    updateUrl({ since: dateRange.since, until });
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Preset buttons */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
        {PRESETS.map(({ days, label }) => (
          <button
            key={days}
            onClick={() => handlePreset(days)}
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
          onChange={(e) => handleSinceChange(e.target.value)}
          className="bg-transparent text-gray-300 text-sm outline-none cursor-pointer w-32"
        />
        <span className="text-gray-600 text-sm">—</span>
        <input
          type="date"
          value={dateRange.until}
          min={dateRange.since}
          onChange={(e) => handleUntilChange(e.target.value)}
          className="bg-transparent text-gray-300 text-sm outline-none cursor-pointer w-32"
        />
      </div>
    </div>
  );
}
