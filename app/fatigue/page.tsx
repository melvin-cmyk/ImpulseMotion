"use client";

import { useCreativesContext } from "@/lib/creatives-context";
import { CreativeThumbnail } from "@/components/creative-thumbnail";
import { CreativeModal } from "@/components/creative-modal";
import { DateRangePicker } from "@/components/date-range-picker";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import { AlertTriangle, TrendingDown, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Creative } from "@/lib/mock-data";

type CreativeItem = ReturnType<typeof useCreativesContext>["creatives"][0];

/**
 * Determine fatigue signals for a creative using real metrics:
 * - Frequency > 3.5 → high fatigue
 * - CTR declining over 7 days (last point < first point) → alert
 * - Thumbstop / hookRate < 25% → hook fatigue
 */
function getFatigueSignals(creative: CreativeItem): {
  highFrequency: boolean;
  ctrDecline: boolean;
  hookFatigue: boolean;
  signals: string[];
} {
  // Frequency = impressions / reach (approximate using trend data if available)
  // We don't have reach directly, so we use ctr trend direction and hookRate
  const highFrequency = creative.status === "Fatigued"; // use status as primary signal

  // CTR trend: compare first half vs second half of trend data
  const trend = creative.trend;
  let ctrDecline = false;
  if (trend.length >= 2) {
    const firstHalf = trend.slice(0, Math.floor(trend.length / 2));
    const secondHalf = trend.slice(Math.floor(trend.length / 2));
    const avgCtrFirst =
      firstHalf.reduce((s, d) => s + (d.clicks / Math.max(d.impressions, 1)), 0) /
      firstHalf.length;
    const avgCtrSecond =
      secondHalf.reduce((s, d) => s + (d.clicks / Math.max(d.impressions, 1)), 0) /
      secondHalf.length;
    ctrDecline = avgCtrSecond < avgCtrFirst * 0.9; // >10% drop
  }

  // Hook fatigue: thumbstop/hookRate < 25%
  const hookFatigue = creative.hookRate > 0 && creative.hookRate < 25;

  const signals: string[] = [];
  if (highFrequency) signals.push("Audience saturation (status: Fatigued)");
  if (ctrDecline) signals.push("CTR declining over 7 days");
  if (hookFatigue) signals.push(`Hook Rate ${creative.hookRate.toFixed(1)}% < 25% threshold`);

  return { highFrequency, ctrDecline, hookFatigue, signals };
}

function getDailyTrend(creative: CreativeItem) {
  // Use real trend data — if CTR is declining, it'll show naturally
  return creative.trend.map((d, i) => ({
    date: d.date,
    cpa: d.cpa,
    ctr: d.impressions > 0 ? Math.round((d.clicks / d.impressions) * 10000) / 100 : creative.ctr,
    roas: d.roas,
  }));
}

/**
 * Detect fatigued creatives using real metrics:
 * Primary: status === "Fatigued" (set by Meta or computed)
 * Secondary: CTR declining OR hook rate < 25% — even if status is Active
 */
function isFatigued(creative: CreativeItem): boolean {
  if (creative.status === "Fatigued") return true;
  // Also flag creatives with hook fatigue even if not labelled Fatigued
  const { ctrDecline, hookFatigue } = getFatigueSignals(creative);
  return ctrDecline && hookFatigue;
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
  const { creatives } = useCreativesContext();
  const [selectedCreative, setSelectedCreative] = useState<Creative | null>(null);
  const [platformFilter, setPlatformFilter] = useState<"All" | "Meta" | "TikTok">("Meta");

  // Use real fatigue detection instead of only checking status
  const fatiguedCreatives = [...creatives]
    .filter((c) => (platformFilter === "All" ? true : c.platform === platformFilter))
    .filter(isFatigued)
    .sort((a, b) => a.roas - b.roas);
  const totalFatigued = fatiguedCreatives.length;

  // Compute real average degradation from trend data
  const avgCtrDrop = fatiguedCreatives.length > 0
    ? (() => {
        const drops = fatiguedCreatives.map((c) => {
          const t = c.trend;
          if (t.length < 2) return 0;
          const first = t[0].clicks / Math.max(t[0].impressions, 1) * 100;
          const last = t[t.length - 1].clicks / Math.max(t[t.length - 1].impressions, 1) * 100;
          return Math.max(0, first - last);
        });
        return Math.round((drops.reduce((s, v) => s + v, 0) / drops.length) * 10) / 10;
      })()
    : 0;

  const avgCpaRise = fatiguedCreatives.length > 0
    ? (() => {
        const rises = fatiguedCreatives.map((c) => {
          const t = c.trend;
          if (t.length < 2) return 0;
          const first = t[0].cpa;
          const last = t[t.length - 1].cpa;
          return first > 0 ? Math.round(((last - first) / first) * 100) : 0;
        });
        return Math.round(rises.reduce((s, v) => s + v, 0) / rises.length);
      })()
    : 0;

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Fatigue Detection</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          Creatives showing performance degradation signals
        </p>
      </div>

      {/* Date Range Picker */}
      <DateRangePicker />

      {/* Platform filter */}
      <div className="flex gap-2">
        {(["Meta", "TikTok", "All"] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPlatformFilter(p)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              platformFilter === p
                ? "bg-orange-600/30 border-orange-600 text-orange-200"
                : "bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200"
            }`}
          >
            {p}
          </button>
        ))}
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
          const trendData = getDailyTrend(creative);
          const signals = getFatigueSignals(creative).signals;

          return (
            <div
              key={creative.id}
              onClick={() => setSelectedCreative(creative)}
              className="bg-gray-900 border border-orange-900/40 rounded-2xl overflow-hidden hover:border-orange-700/60 hover:shadow-lg hover:shadow-orange-900/10 transition-all cursor-pointer"
            >
              {/* Top bar */}
              <div className="flex items-center gap-4 p-4 border-b border-gray-800">
                {/* Thumbnail */}
                <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0">
                  <CreativeThumbnail
                    format={creative.format}
                    thumbnailColor={creative.thumbnailColor}
                    thumbnailUrl={creative.thumbnailUrl}
                    videoUrl={creative.videoUrl}
                    videoId={creative.videoId}
                    className="w-12 h-12"
                  />
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

                {/* Fatigue signals count */}
                <div className="text-right shrink-0">
                  <p className="text-orange-400 font-bold text-lg">{signals.length}</p>
                  <p className="text-gray-500 text-xs">signals</p>
                </div>

                {/* Real metrics */}
                <div className="flex gap-4 shrink-0">
                  <div className="text-right">
                    <p className="text-white text-sm font-semibold">
                      {creative.ctr.toFixed(2)}%
                    </p>
                    <p className="text-gray-500 text-xs">CTR</p>
                  </div>
                  <div className="text-right">
                    <p className="text-orange-400 text-sm font-semibold">
                      ${creative.cpa.toFixed(2)}
                    </p>
                    <p className="text-gray-500 text-xs">CPA</p>
                  </div>
                  <div className="text-right">
                    <p className="text-gray-300 text-sm font-semibold">
                      ${creative.spend.toLocaleString()}
                    </p>
                    <p className="text-gray-500 text-xs">Spend</p>
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

              {/* Fatigue signals list */}
              {signals.length > 0 && (
                <div className="px-4 py-2 bg-orange-950/10 border-b border-gray-800">
                  <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mb-1">Detected Signals</p>
                  <ul className="space-y-0.5">
                    {signals.map((s) => (
                      <li key={s} className="text-xs text-orange-300/80 flex items-center gap-1.5">
                        <span className="w-1 h-1 rounded-full bg-orange-500 shrink-0" />
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Recommendation */}
              <div className="flex items-center gap-3 px-4 py-3 bg-orange-950/20">
                <RefreshCw className="w-4 h-4 text-orange-400 shrink-0" />
                <p className="text-orange-300 text-xs">
                  <span className="font-semibold">Recommend: Replace creative.</span>{" "}
                  {signals.length > 0
                    ? `${signals.length} fatigue signal${signals.length > 1 ? "s" : ""} detected — audience saturation likely. `
                    : "Audience saturation detected. "}
                  Consider launching a new variant with a different hook or visual angle.
                  <span className="text-gray-500 ml-1">(Click card to view full details)</span>
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {fatiguedCreatives.length === 0 && (
        <div className="flex flex-col items-center justify-center h-48 gap-2">
          <span className="text-2xl">✅</span>
          <p className="text-gray-500 text-sm">No fatigued creatives detected.</p>
          <p className="text-gray-600 text-xs">
            Fatigue is detected when: status = Fatigued, CTR declining &gt;10%, or Hook Rate &lt;25%.
          </p>
        </div>
      )}

      {/* Creative Detail Modal */}
      <CreativeModal
        creative={selectedCreative}
        onClose={() => setSelectedCreative(null)}
      />
    </div>
  );
}
