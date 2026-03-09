"use client";

import { mockCreatives } from "@/lib/mock-data";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import { AlertTriangle, TrendingDown, RefreshCw } from "lucide-react";

// Derive fatigued creatives and compute days-since-fatigue (mocked: based on how quickly ROAS drops)
const fatiguedCreatives = [...mockCreatives]
  .filter((c) => c.status === "Fatigued")
  .sort((a, b) => a.roas - b.roas);

function getFatigueDays(id: string): number {
  const map: Record<string, number> = {
    c8: 5,
    c9: 3,
    c10: 7,
    c17: 4,
  };
  return map[id] ?? 4;
}

function getDailyTrend(creative: (typeof mockCreatives)[0]) {
  // Build a 7-day series showing CPA rising and CTR falling
  return creative.trend.map((d, i) => ({
    date: d.date,
    cpa: Math.round(d.cpa * (1 + i * 0.08)),
    ctr: Math.max(0.5, creative.ctr - i * 0.2),
    roas: d.roas,
  }));
}

function CTRTrend({ data }: { data: ReturnType<typeof getDailyTrend> }) {
  return (
    <div>
      <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">CTR (7d)</p>
      <ResponsiveContainer width="100%" height={48}>
        <LineChart data={data}>
          <XAxis dataKey="date" hide />
          <Line
            type="monotone"
            dataKey="ctr"
            stroke="#f87171"
            strokeWidth={2}
            dot={false}
          />
          <Tooltip
            contentStyle={{
              background: "#1f2937",
              border: "1px solid #374151",
              borderRadius: "6px",
              fontSize: "11px",
              color: "#e5e7eb",
            }}
            formatter={(v: unknown) => [`${(v as number).toFixed(2)}%`, "CTR"]}
            labelFormatter={(l) => l}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function CPATrend({ data }: { data: ReturnType<typeof getDailyTrend> }) {
  return (
    <div>
      <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">CPA (7d)</p>
      <ResponsiveContainer width="100%" height={48}>
        <LineChart data={data}>
          <XAxis dataKey="date" hide />
          <Line
            type="monotone"
            dataKey="cpa"
            stroke="#fb923c"
            strokeWidth={2}
            dot={false}
          />
          <Tooltip
            contentStyle={{
              background: "#1f2937",
              border: "1px solid #374151",
              borderRadius: "6px",
              fontSize: "11px",
              color: "#e5e7eb",
            }}
            formatter={(v: unknown) => [`$${(v as number).toFixed(2)}`, "CPA"]}
            labelFormatter={(l) => l}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ROASTrend({ data }: { data: ReturnType<typeof getDailyTrend> }) {
  return (
    <div>
      <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">ROAS (7d)</p>
      <ResponsiveContainer width="100%" height={48}>
        <LineChart data={data}>
          <XAxis dataKey="date" hide />
          <Line
            type="monotone"
            dataKey="roas"
            stroke="#fbbf24"
            strokeWidth={2}
            dot={false}
          />
          <Tooltip
            contentStyle={{
              background: "#1f2937",
              border: "1px solid #374151",
              borderRadius: "6px",
              fontSize: "11px",
              color: "#e5e7eb",
            }}
            formatter={(v: unknown) => [`${(v as number).toFixed(2)}x`, "ROAS"]}
            labelFormatter={(l) => l}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function PlatformBadge({ platform }: { platform: string }) {
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 ${
        platform === "Meta"
          ? "bg-blue-900/70 text-blue-300 border border-blue-800"
          : "bg-pink-900/70 text-pink-300 border border-pink-800"
      }`}
    >
      {platform}
    </span>
  );
}

export default function FatiguePage() {
  const totalFatigued = fatiguedCreatives.length;

  // Compute average degradation
  const avgCtrDrop = 1.4; // percentage points over 7 days (mock)
  const avgCpaRise = 32; // percent increase (mock)

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Fatigue Detection</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          Creatives showing performance degradation signals
        </p>
      </div>

      {/* Alert Banner */}
      {totalFatigued > 0 && (
        <div className="flex items-start gap-4 bg-orange-950/50 border border-orange-700/60 rounded-2xl p-5">
          <div className="w-10 h-10 rounded-xl bg-orange-600/30 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-orange-400" />
          </div>
          <div className="flex-1">
            <p className="text-orange-200 font-semibold">
              {totalFatigued} creative{totalFatigued > 1 ? "s are" : " is"} showing fatigue signals
            </p>
            <p className="text-orange-400/80 text-sm mt-1">
              Average CTR dropped <span className="text-orange-300 font-medium">{avgCtrDrop}pp</span> and
              CPA increased <span className="text-orange-300 font-medium">{avgCpaRise}%</span> over the
              last 7 days across fatigued creatives. Immediate creative refresh is recommended.
            </p>
          </div>
          <div className="flex gap-3 shrink-0">
            <div className="text-center">
              <p className="text-orange-300 font-bold text-lg">
                <TrendingDown className="w-5 h-5 inline" /> CTR
              </p>
              <p className="text-orange-400/70 text-xs">Trending down</p>
            </div>
            <div className="text-center">
              <p className="text-orange-300 font-bold text-lg">
                CPA <TrendingDown className="w-5 h-5 inline rotate-180" />
              </p>
              <p className="text-orange-400/70 text-xs">Trending up</p>
            </div>
          </div>
        </div>
      )}

      {/* Fatigued Creative Cards */}
      <div className="space-y-4">
        {fatiguedCreatives.map((creative) => {
          const days = getFatigueDays(creative.id);
          const trendData = getDailyTrend(creative);
          const latestCpa = trendData[trendData.length - 1].cpa;
          const latestCtr = trendData[trendData.length - 1].ctr;
          const cpaChange = Math.round(
            ((latestCpa - trendData[0].cpa) / trendData[0].cpa) * 100
          );
          const ctrChange = (latestCtr - trendData[0].ctr).toFixed(1);

          return (
            <div
              key={creative.id}
              className="bg-gray-900 border border-orange-900/40 rounded-2xl overflow-hidden"
            >
              {/* Top bar */}
              <div className="flex items-center gap-4 p-4 border-b border-gray-800">
                {/* Thumbnail */}
                <div
                  className={`w-12 h-12 rounded-xl bg-gradient-to-br ${creative.thumbnailColor} flex items-center justify-center shrink-0`}
                >
                  <span className="text-white/30 text-lg font-black">
                    {creative.format === "Video" ? "▶" : creative.format === "Image" ? "◼" : "⊞"}
                  </span>
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-gray-100 truncate">{creative.name}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <PlatformBadge platform={creative.platform} />
                    <span className="text-[10px] text-gray-500 uppercase tracking-wide">
                      {creative.format}
                    </span>
                    <span className="text-[10px] bg-orange-900/50 text-orange-300 border border-orange-800/60 rounded-full px-2 py-0.5 font-semibold">
                      ⚠️ Fatigued
                    </span>
                  </div>
                </div>

                {/* Fatigue duration */}
                <div className="text-right shrink-0">
                  <p className="text-orange-400 font-bold text-lg">{days}d</p>
                  <p className="text-gray-500 text-xs">since fatigue</p>
                </div>

                {/* Change indicators */}
                <div className="flex gap-4 shrink-0">
                  <div className="text-right">
                    <p className="text-red-400 text-sm font-semibold">
                      {ctrChange}pp
                    </p>
                    <p className="text-gray-500 text-xs">CTR change</p>
                  </div>
                  <div className="text-right">
                    <p className="text-orange-400 text-sm font-semibold">
                      +{cpaChange}%
                    </p>
                    <p className="text-gray-500 text-xs">CPA change</p>
                  </div>
                </div>
              </div>

              {/* Sparklines */}
              <div className="grid grid-cols-3 gap-px bg-gray-800 border-b border-gray-800">
                <div className="bg-gray-900 px-4 py-3">
                  <CTRTrend data={trendData} />
                </div>
                <div className="bg-gray-900 px-4 py-3">
                  <CPATrend data={trendData} />
                </div>
                <div className="bg-gray-900 px-4 py-3">
                  <ROASTrend data={trendData} />
                </div>
              </div>

              {/* Recommendation */}
              <div className="flex items-center gap-3 px-4 py-3 bg-orange-950/20">
                <RefreshCw className="w-4 h-4 text-orange-400 shrink-0" />
                <p className="text-orange-300 text-xs">
                  <span className="font-semibold">Recommend: Replace creative.</span>{" "}
                  This ad has been fatiguing for {days} day{days > 1 ? "s" : ""} — audience
                  saturation detected. Consider launching a new variant with a different hook
                  or visual angle.
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {fatiguedCreatives.length === 0 && (
        <div className="flex items-center justify-center h-48 text-gray-600">
          No fatigued creatives detected.
        </div>
      )}
    </div>
  );
}
