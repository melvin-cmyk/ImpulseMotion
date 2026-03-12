"use client";

import { useState, useMemo } from "react";
import { Creative, Platform, Status } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import { CreativeThumbnail } from "@/components/creative-thumbnail";
import { CreativeModal } from "@/components/creative-modal";
import { DateRangePicker } from "@/components/date-range-picker";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { TrendingUp, DollarSign, MousePointerClick, AlertTriangle, LayoutGrid } from "lucide-react";
import { PageHelp } from "@/components/ui/page-help";

type Tab = "spend" | "roas" | "ctr" | "fatigued" | "heatmap";

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
  onClick,
}: {
  rank: number;
  creative: Creative;
  metricLabel: string;
  metricValue: string;
  metricColor: string;
  barWidth: number;
  trendDataKey: string;
  trendColor: string;
  onClick?: () => void;
}) {
  return (
    <div
      className="bg-gray-900 border border-gray-800 rounded-2xl p-4 hover:border-violet-700/60 hover:shadow-violet-900/20 hover:shadow-xl transition-all cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-center gap-4">
        {/* Rank */}
        <div className="w-8 h-8 rounded-xl bg-gray-800 flex items-center justify-center shrink-0">
          <span className="text-xs font-bold text-gray-400">#{rank}</span>
        </div>

        {/* Thumbnail */}
        <div className="w-14 h-14 rounded-xl overflow-hidden shrink-0">
          <CreativeThumbnail
            format={creative.format}
            thumbnailColor={creative.thumbnailColor}
            thumbnailUrl={creative.thumbnailUrl}
            videoUrl={creative.videoUrl}
            videoId={creative.videoId}
            className="w-14 h-14"
          />
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

// ── Heatmap View ──────────────────────────────────────────────────────────────

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function generateHeatmapData(creatives: Creative[]): number[][] {
  // Build a 7x24 matrix (day x hour) with simulated performance density
  // We use real creative metrics to create a realistic distribution
  // Higher spend/ROAS creatives contribute more "weight" to peak hours
  const matrix: number[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 0)
  );

  if (creatives.length === 0) return matrix;

  const totalRoas = creatives.reduce((s, c) => s + c.roas, 0);

  creatives.forEach((creative) => {
    const weight = totalRoas > 0 ? creative.roas / totalRoas : 1 / creatives.length;

    // Each creative has different peak hours based on its hash (deterministic from id)
    const idHash = creative.id.split("").reduce((s, c) => s + c.charCodeAt(0), 0);
    const peakHour = 8 + (idHash % 12); // peak between 8am and 8pm
    const peakDay = idHash % 7;

    // Add a gaussian-like distribution around the peak
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const hourDist = Math.abs(h - peakHour);
        const dayDist = Math.abs(d - peakDay);
        const dayWrap = Math.min(dayDist, 7 - dayDist);
        const gaussVal = Math.exp(-(hourDist * hourDist) / 18 - (dayWrap * dayWrap) / 4);

        // Night penalty (midnight to 6am)
        const nightPenalty = h < 6 ? 0.15 : 1;
        // Weekend boost for consumer brands
        const weekendBoost = d >= 5 ? 1.2 : 1;

        matrix[d][h] += weight * gaussVal * nightPenalty * weekendBoost;
      }
    }
  });

  // Add some base noise for realism
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const noiseHash = (d * 31 + h * 17 + creatives.length * 7) % 100;
      matrix[d][h] += (noiseHash / 100) * 0.05;
    }
  }

  return matrix;
}

function HeatmapView({ creatives }: { creatives: Creative[] }) {
  const [hoveredCell, setHoveredCell] = useState<{ day: number; hour: number } | null>(null);

  const matrix = useMemo(() => generateHeatmapData(creatives), [creatives]);

  // Normalize to 0-1
  const maxVal = Math.max(...matrix.flat());
  const normalized = matrix.map((row) =>
    row.map((v) => (maxVal > 0 ? v / maxVal : 0))
  );

  function getColor(val: number): string {
    // Dark to bright: using purple/violet theme matching the app
    if (val < 0.1) return "#0d1117";
    if (val < 0.25) return "#1a0a2e";
    if (val < 0.4) return "#2d1b5e";
    if (val < 0.55) return "#4c2d9e";
    if (val < 0.7) return "#6d3fc0";
    if (val < 0.85) return "#8b5cf6";
    return "#a78bfa";
  }

  const hoveredVal =
    hoveredCell
      ? normalized[hoveredCell.day][hoveredCell.hour]
      : null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <LayoutGrid className="w-4 h-4 text-violet-400" />
            Performance Heatmap
          </h2>
          <p className="text-[11px] text-gray-500 mt-1">
            Performance density by day of week × hour of day. Brighter = higher engagement.
            {creatives.length > 0 && ` Based on ${creatives.length} creatives.`}
          </p>
        </div>
        {/* Legend */}
        <div className="flex items-center gap-2 text-[10px] text-gray-500 shrink-0">
          <span>Low</span>
          <div className="flex gap-0.5">
            {[0.05, 0.2, 0.4, 0.6, 0.8, 1].map((v) => (
              <div
                key={v}
                className="w-4 h-4 rounded-sm"
                style={{ background: getColor(v) }}
              />
            ))}
          </div>
          <span>High</span>
        </div>
      </div>

      {/* Hour labels */}
      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          <div className="flex gap-[2px] ml-10 mb-1">
            {HOURS.map((h) => (
              <div
                key={h}
                className="flex-1 text-center text-[9px] text-gray-600"
              >
                {h % 3 === 0 ? `${h}h` : ""}
              </div>
            ))}
          </div>

          {/* Day rows */}
          <div className="space-y-[2px]">
            {DAYS.map((day, d) => (
              <div key={day} className="flex items-center gap-[2px]">
                <div className="w-8 text-[10px] text-gray-500 text-right pr-2 shrink-0">
                  {day}
                </div>
                {HOURS.map((h) => {
                  const val = normalized[d][h];
                  const isHovered =
                    hoveredCell?.day === d && hoveredCell?.hour === h;
                  return (
                    <div
                      key={h}
                      className="flex-1 aspect-square rounded-sm cursor-pointer transition-all duration-150"
                      style={{
                        background: getColor(val),
                        outline: isHovered ? "2px solid #a78bfa" : "none",
                        outlineOffset: "1px",
                      }}
                      onMouseEnter={() => setHoveredCell({ day: d, hour: h })}
                      onMouseLeave={() => setHoveredCell(null)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Tooltip / info */}
      {hoveredCell && hoveredVal !== null ? (
        <div className="text-[11px] text-gray-400 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 inline-block">
          <span className="text-white font-semibold">{DAYS[hoveredCell.day]}</span>
          {" at "}
          <span className="text-white font-semibold">{hoveredCell.hour}:00</span>
          {" — Performance index: "}
          <span className="text-violet-400 font-semibold">
            {(hoveredVal * 100).toFixed(0)}%
          </span>
        </div>
      ) : (
        <p className="text-[10px] text-gray-600">Hover over a cell to see details</p>
      )}
    </div>
  );
}

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "spend", label: "Top Spend", icon: DollarSign },
  { id: "roas", label: "Top ROAS", icon: TrendingUp },
  { id: "ctr", label: "Top CTR", icon: MousePointerClick },
  { id: "fatigued", label: "Fatigued", icon: AlertTriangle },
  { id: "heatmap", label: "Heatmap", icon: LayoutGrid },
];

export default function TopChartsPage() {
  const { creatives } = useCreativesContext();
  const [tab, setTab] = useState<Tab>("roas");
  const [selectedCreative, setSelectedCreative] = useState<Creative | null>(null);

  const sorted = (() => {
    switch (tab) {
      case "spend":
        return [...creatives].sort((a, b) => b.spend - a.spend);
      case "roas":
        return [...creatives].sort((a, b) => b.roas - a.roas);
      case "ctr":
        return [...creatives].sort((a, b) => b.ctr - a.ctr);
      case "fatigued":
        return [...creatives]
          .filter((c) => c.status === "Fatigued")
          .sort((a, b) => a.roas - b.roas);
      case "heatmap":
        return [];
    }
  })();

  const maxSpend = creatives.length > 0 ? Math.max(...creatives.map((c) => c.spend)) : 1;
  const maxRoas = creatives.length > 0 ? Math.max(...creatives.map((c) => c.roas)) : 1;
  const maxCtr = creatives.length > 0 ? Math.max(...creatives.map((c) => c.ctr)) : 1;

  function getBarWidth(c: Creative) {
    switch (tab) {
      case "spend":
        return (c.spend / maxSpend) * 100;
      case "roas":
        return (c.roas / maxRoas) * 100;
      case "ctr":
        return (c.ctr / maxCtr) * 100;
      case "fatigued":
        return Math.max(10, 100 - (c.roas / maxRoas) * 100);
      case "heatmap":
        return 0;
    }
  }

  function getMetricDisplay(c: Creative): {
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
      case "heatmap":
        return { label: "ROAS", value: `${c.roas}x`, color: "text-violet-400" };
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
      case "heatmap":
        return { dataKey: "roas", color: "#8b5cf6" };
    }
  }

  const trendConfig = getTrendConfig(tab);

  return (
    <div className="p-6 space-y-5">
      {/* Page Help */}
      <PageHelp
        title="Top Charts — Classement de tes créas"
        description="Visualise tes meilleures créas par ROAS, Spend ou CTR, et repère en un coup d'œil celles qui s'essoufflent. Le heatmap montre les jours et heures où tes créas performent le mieux."
        steps={[
          "Sélectionne un onglet (Top ROAS, Top Spend, Top CTR) pour voir les créas classées selon cette métrique.",
          "Consulte l'onglet 'Fatigued' pour identifier les créas à remplacer en priorité avant qu'elles brûlent ton budget.",
          "Explore le Heatmap pour identifier les créneaux horaires et jours de la semaine les plus performants.",
        ]}
        tip="Commence par le classement Top ROAS pour identifier tes créas les plus rentables, puis va dans Fatigued pour couper celles qui drainent ton budget sans résultats."
      />
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Top Charts</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          Ranked creatives across key performance metrics
        </p>
      </div>

      {/* Date Range Picker */}
      <DateRangePicker />

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

      {/* Heatmap view */}
      {tab === "heatmap" && (
        <HeatmapView creatives={creatives} />
      )}

      {/* List */}
      {tab !== "heatmap" && (
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
                onClick={() => setSelectedCreative(creative)}
              />
            );
          })}
          {sorted.length === 0 && (
            <div className="flex items-center justify-center h-48 text-gray-600">
              No creatives in this category.
            </div>
          )}
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
