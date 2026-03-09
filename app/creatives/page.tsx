"use client";

import { useState, useMemo } from "react";
import { Platform, Format, Status } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import { LineChart, Line, ResponsiveContainer, Tooltip } from "recharts";
import { ArrowUpDown, Database, Wifi } from "lucide-react";

type SortKey = "roas" | "cpa" | "spend" | "ctr" | "hookRate";

function PlatformBadge({ platform }: { platform: Platform }) {
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
        platform === "Meta"
          ? "bg-blue-900/70 text-blue-300 border border-blue-800"
          : "bg-pink-900/70 text-pink-300 border border-pink-800"
      }`}
    >
      {platform}
    </span>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const map: Record<Status, string> = {
    Winner: "bg-green-900/60 text-green-300 border border-green-800",
    Loser: "bg-red-900/60 text-red-300 border border-red-800",
    Fatigued: "bg-orange-900/60 text-orange-300 border border-orange-800",
    Active: "bg-blue-900/60 text-blue-300 border border-blue-800",
  };
  const icons: Record<Status, string> = {
    Winner: "🏆",
    Loser: "❌",
    Fatigued: "⚠️",
    Active: "●",
  };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${map[status]}`}>
      {icons[status]} {status}
    </span>
  );
}

function Sparkline({ data }: { data: { date: string; roas: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={36}>
      <LineChart data={data}>
        <Line
          type="monotone"
          dataKey="roas"
          stroke="#8b5cf6"
          strokeWidth={1.5}
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
          formatter={(v: unknown) => [`${v}x`, "ROAS"]}
          labelFormatter={(l) => l}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</span>
      <span className="text-xs font-semibold text-gray-200">{value}</span>
    </div>
  );
}

export default function CreativesPage() {
  const [platform, setPlatform] = useState<"All" | Platform>("All");
  const [status, setStatus] = useState<"All" | Status>("All");
  const [format, setFormat] = useState<"All" | Format>("All");
  const [sortBy, setSortBy] = useState<SortKey>("roas");

  const { creatives, isLoading: loading, error, isRealData } = useCreativesContext();

  const filtered = useMemo(() => {
    let list = [...creatives];
    if (platform !== "All") list = list.filter((c) => c.platform === platform);
    if (status !== "All") list = list.filter((c) => c.status === status);
    if (format !== "All") list = list.filter((c) => c.format === format);
    list.sort((a, b) => {
      if (sortBy === "cpa") return a.cpa - b.cpa;
      return (b[sortBy] as number) - (a[sortBy] as number);
    });
    return list;
  }, [creatives, platform, status, format, sortBy]);

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Creative Feed</h1>
          <p className="text-gray-400 text-sm mt-0.5">{filtered.length} creatives</p>
        </div>
        <div className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border border-gray-800 bg-gray-900">
          {isRealData ? (
            <><Wifi className="w-3 h-3 text-green-400" /><span className="text-green-400">Live data</span></>
          ) : (
            <><Database className="w-3 h-3 text-gray-500" /><span className="text-gray-500">Demo data</span></>
          )}
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-900/20 border border-red-800/40 rounded-xl text-xs text-red-300">
          {error}
        </div>
      )}

      {loading && (
        <div className="text-center py-12 text-gray-500 text-sm">Loading creatives...</div>
      )}

      {/* Filter Bar */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Platform */}
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
          {(["All", "Meta", "TikTok"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                platform === p
                  ? "bg-violet-600 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Status */}
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
          {(["All", "Winner", "Active", "Fatigued", "Loser"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                status === s
                  ? "bg-violet-600 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Format */}
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
          {(["All", "Video", "Image", "Carousel"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFormat(f)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                format === f
                  ? "bg-violet-600 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-2 ml-auto bg-gray-900 border border-gray-800 rounded-xl px-3 py-2">
          <ArrowUpDown className="w-4 h-4 text-gray-500" />
          <span className="text-gray-500 text-sm">Sort:</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            className="bg-transparent text-gray-300 text-sm outline-none cursor-pointer"
          >
            <option value="roas">ROAS</option>
            <option value="cpa">CPA (low→high)</option>
            <option value="spend">Spend</option>
            <option value="ctr">CTR</option>
            <option value="hookRate">Hook Rate</option>
          </select>
        </div>
      </div>

      {/* Grid */}
      {!loading && (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filtered.map((creative) => (
          <div
            key={creative.id}
            className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden hover:border-gray-700 hover:shadow-xl hover:shadow-black/30 transition-all duration-200 group"
          >
            {/* Thumbnail */}
            <div
              className={`h-36 bg-gradient-to-br ${creative.thumbnailColor} relative flex items-center justify-center`}
            >
              <div className="text-white/20 text-5xl font-black">
                {creative.format === "Video" ? "▶" : creative.format === "Image" ? "◼" : "⊞"}
              </div>
              <div className="absolute top-2 left-2">
                <PlatformBadge platform={creative.platform} />
              </div>
              <div className="absolute top-2 right-2">
                <StatusBadge status={creative.status} />
              </div>
              <div className="absolute bottom-2 left-2 text-[10px] font-medium text-white/60 uppercase tracking-wide">
                {creative.format}
              </div>
            </div>

            {/* Body */}
            <div className="p-3 space-y-3">
              <p className="text-xs font-mono text-gray-300 truncate" title={creative.name}>
                {creative.name}
              </p>

              {/* Sparkline */}
              <div className="h-9">
                <Sparkline data={creative.trend} />
              </div>

              {/* Metrics */}
              <div className="grid grid-cols-3 gap-1 pt-1 border-t border-gray-800">
                <MetricPill label="Spend" value={`$${(creative.spend / 1000).toFixed(1)}k`} />
                <MetricPill label="ROAS" value={`${creative.roas}x`} />
                <MetricPill label="CPA" value={`$${creative.cpa}`} />
              </div>
              <div className="grid grid-cols-3 gap-1">
                <MetricPill label="CTR" value={`${creative.ctr}%`} />
                <MetricPill
                  label="Hook"
                  value={creative.hookRate > 0 ? `${creative.hookRate}%` : "—"}
                />
                <MetricPill
                  label="Hold"
                  value={creative.holdRate > 0 ? `${creative.holdRate}%` : "—"}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="flex items-center justify-center h-48 text-gray-600">
          No creatives match the selected filters.
        </div>
      )}
    </div>
  );
}
