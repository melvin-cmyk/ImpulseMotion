"use client";

import { useState } from "react";
import { mockCreatives, Platform, Status } from "@/lib/mock-data";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { TrendingUp, DollarSign, MousePointerClick, AlertTriangle } from "lucide-react";

type Tab = "spend" | "roas" | "ctr" | "fatigued";

function PlatformBadge({ platform }: { platform: Platform }) {
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
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 ${map[status]}`}>
      {icons[status]} {status}
    </span>
  );
}

function Sparkline({
  data,
  dataKey,
  color,
}: {
  data: { date: string; roas: number; cpa?: number }[];
  dataKey: string;
  color: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={32}>
      <LineChart data={data}>
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color}
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
          labelFormatter={(l) => l}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function RankRow({
  rank,
  creative,
  metricLabel,
  metricValue,
  metricColor,
  barWidth,
  trendDataKey,
  trendColor,
}: {
  rank: number;
  creative: (typeof mockCreatives)[0];
  metricLabel: string;
  metricValue: string;
  metricColor: string;
  barWidth: number;
  trendDataKey: string;
  trendColor: string;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 hover:border-gray-700 transition-all">
      <div className="flex items-center gap-4">
        {/* Rank */}
        <div className="w-8 h-8 rounded-xl bg-gray-800 flex items-center justify-center shrink-0">
          <span className="text-xs font-bold text-gray-400">#{rank}</span>
        </div>

        {/* Thumbnail */}
        <div
          className={`w-14 h-14 rounded-xl bg-gradient-to-br ${creative.thumbnailColor} flex items-center justify-center shrink-0`}
        >
          <span className="text-white/30 text-xl font-black">
            {creative.format === "Video" ? "▶" : creative.format === "Image" ? "◼" : "⊞"}
          </span>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-mono text-gray-200 truncate">{creative.name}</p>
          <div className="flex items-center gap-2 mt-1.5">
            <PlatformBadge platform={creative.platform} />
            <StatusBadge status={creative.status} />
            <span className="text-[10px] text-gray-500 uppercase tracking-wide">
              {creative.format}
            </span>
          </div>
          {/* Progress bar */}
          <div className="mt-2 h-1 bg-gray-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${trendColor === "#10b981" ? "bg-emerald-500" : trendColor === "#f59e0b" ? "bg-amber-500" : trendColor === "#3b82f6" ? "bg-blue-500" : "bg-violet-500"}`}
              style={{ width: `${barWidth}%` }}
            />
          </div>
        </div>

        {/* Sparkline */}
        <div className="w-24 shrink-0">
          <Sparkline
            data={creative.trend}
            dataKey={trendDataKey}
            color={trendColor}
          />
        </div>

        {/* Main Metric */}
        <div className="text-right shrink-0 w-20">
          <p className={`text-lg font-bold ${metricColor}`}>{metricValue}</p>
          <p className="text-[10px] text-gray-500 uppercase tracking-wide">{metricLabel}</p>
        </div>

        {/* Secondary metrics */}
        <div className="text-right shrink-0 w-28 hidden lg:block">
          <p className="text-xs text-gray-400">
            <span className="text-gray-500">Spend</span>{" "}
            <span className="text-gray-200">${(creative.spend / 1000).toFixed(1)}k</span>
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            <span className="text-gray-500">CPA</span>{" "}
            <span className="text-gray-200">${creative.cpa}</span>
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            <span className="text-gray-500">CTR</span>{" "}
            <span className="text-gray-200">{creative.ctr}%</span>
          </p>
        </div>
      </div>
    </div>
  );
}

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "spend", label: "Top Spend", icon: DollarSign },
  { id: "roas", label: "Top ROAS", icon: TrendingUp },
  { id: "ctr", label: "Top CTR", icon: MousePointerClick },
  { id: "fatigued", label: "Fatigued", icon: AlertTriangle },
];

export default function TopChartsPage() {
  const [tab, setTab] = useState<Tab>("roas");

  const sorted = (() => {
    switch (tab) {
      case "spend":
        return [...mockCreatives].sort((a, b) => b.spend - a.spend);
      case "roas":
        return [...mockCreatives].sort((a, b) => b.roas - a.roas);
      case "ctr":
        return [...mockCreatives].sort((a, b) => b.ctr - a.ctr);
      case "fatigued":
        return [...mockCreatives]
          .filter((c) => c.status === "Fatigued")
          .sort((a, b) => a.roas - b.roas);
    }
  })();

  const maxSpend = Math.max(...mockCreatives.map((c) => c.spend));
  const maxRoas = Math.max(...mockCreatives.map((c) => c.roas));
  const maxCtr = Math.max(...mockCreatives.map((c) => c.ctr));

  function getBarWidth(c: (typeof mockCreatives)[0]) {
    switch (tab) {
      case "spend":
        return (c.spend / maxSpend) * 100;
      case "roas":
        return (c.roas / maxRoas) * 100;
      case "ctr":
        return (c.ctr / maxCtr) * 100;
      case "fatigued":
        return Math.max(10, 100 - (c.roas / maxRoas) * 100);
    }
  }

  function getMetricDisplay(c: (typeof mockCreatives)[0]): {
    label: string;
    value: string;
    color: string;
  } {
    switch (tab) {
      case "spend":
        return {
          label: "Spend",
          value: `$${(c.spend / 1000).toFixed(1)}k`,
          color: "text-violet-400",
        };
      case "roas":
        return {
          label: "ROAS",
          value: `${c.roas}x`,
          color: "text-emerald-400",
        };
      case "ctr":
        return { label: "CTR", value: `${c.ctr}%`, color: "text-blue-400" };
      case "fatigued":
        return {
          label: "ROAS",
          value: `${c.roas}x`,
          color: "text-orange-400",
        };
    }
  }

  function getTrendConfig(tab: Tab): { dataKey: string; color: string } {
    switch (tab) {
      case "spend":
        return { dataKey: "spend", color: "#8b5cf6" };
      case "roas":
        return { dataKey: "roas", color: "#10b981" };
      case "ctr":
        return { dataKey: "roas", color: "#3b82f6" };
      case "fatigued":
        return { dataKey: "roas", color: "#f59e0b" };
    }
  }

  const trendConfig = getTrendConfig(tab);

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Top Charts</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          Ranked creatives across key performance metrics
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === id
                ? "bg-violet-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-800"
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Alert for fatigued tab */}
      {tab === "fatigued" && sorted.length > 0 && (
        <div className="flex items-start gap-3 bg-orange-950/40 border border-orange-800/60 rounded-xl p-4">
          <AlertTriangle className="w-5 h-5 text-orange-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-orange-300 font-semibold text-sm">
              {sorted.length} fatigued creative{sorted.length > 1 ? "s" : ""} detected
            </p>
            <p className="text-orange-400/80 text-xs mt-0.5">
              These creatives show declining ROAS and rising CPA over the last 7 days.
              Consider replacing or refreshing them.
            </p>
          </div>
        </div>
      )}

      {/* List */}
      <div className="space-y-3">
        {sorted.map((creative, i) => {
          const metric = getMetricDisplay(creative);
          return (
            <RankRow
              key={creative.id}
              rank={i + 1}
              creative={creative}
              metricLabel={metric.label}
              metricValue={metric.value}
              metricColor={metric.color}
              barWidth={getBarWidth(creative)}
              trendDataKey={trendConfig.dataKey}
              trendColor={trendConfig.color}
            />
          );
        })}
        {sorted.length === 0 && (
          <div className="flex items-center justify-center h-48 text-gray-600">
            No creatives in this category.
          </div>
        )}
      </div>
    </div>
  );
}
