"use client";

import { useState } from "react";
import type { Creative, DayMetric, Platform, Status } from "@/lib/creative-types";
import { useCreativesContext } from "@/lib/creatives-context";
import { fmtMoney, fmtRoas } from "@/lib/creative-format";
import { FATIGUE_FREQUENCY_WEEKLY, FATIGUE_HOOK_RATE } from "@/lib/creative-stats";

/** Known ROAS for ranking; unknown / unavailable counts as 0. */
function roasOf(c: Creative): number {
  return c.roas !== null && c.roas !== undefined && !c.roasUnavailable ? c.roas : 0;
}
import { CreativeThumbnail } from "@/components/creative-thumbnail";
import { CreativeModal } from "@/components/creative-modal";
import { DateRangePicker } from "@/components/date-range-picker";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { TrendingUp, DollarSign, MousePointerClick, AlertTriangle } from "lucide-react";
import { MetricInfoButton } from "@/components/metric-info-button";
import { PageHelp } from "@/components/ui/page-help";

type Tab = "spend" | "roas" | "ctr" | "fatigued";

/** Adds a daily CTR (clicks / impressions × 100) to the trend points for the CTR sparkline. */
function withCtr(trend: DayMetric[]): (DayMetric & { ctr: number })[] {
  return trend.map((d) => ({ ...d, ctr: d.impressions > 0 ? Math.round((d.clicks / d.impressions) * 10000) / 100 : 0 }));
}

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
  data: { date: string; roas: number; cpa?: number; ctr?: number; spend?: number }[];
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
  currency,
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
  currency: string | null;
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
            data={withCtr(creative.trend)}
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
            <span className="text-gray-500 inline-flex items-center gap-0.5">Spend <MetricInfoButton metricKey="spend" /></span>{" "}
            <span className="text-gray-200">{fmtMoney(creative.spend, currency)}</span>
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            <span className="text-gray-500 inline-flex items-center gap-0.5">CPA <MetricInfoButton metricKey="cpa" /></span>{" "}
            <span className="text-gray-200">{creative.cpa > 0 ? fmtMoney(creative.cpa, currency, 2) : "—"}</span>
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            <span className="text-gray-500 inline-flex items-center gap-0.5">CTR <MetricInfoButton metricKey="ctr" /></span>{" "}
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
  const { creatives, currency } = useCreativesContext();
  const [tab, setTab] = useState<Tab>("roas");
  const [selectedCreative, setSelectedCreative] = useState<Creative | null>(null);

  const sorted = (() => {
    switch (tab) {
      case "spend":
        return [...creatives].sort((a, b) => b.spend - a.spend);
      case "roas":
        // Unknown ROAS ("—") sorts last.
        return [...creatives].filter((c) => roasOf(c) > 0).sort((a, b) => roasOf(b) - roasOf(a));
      case "ctr":
        return [...creatives].sort((a, b) => b.ctr - a.ctr);
      case "fatigued":
        return [...creatives]
          .filter((c) => c.status === "Fatigued")
          .sort((a, b) => b.spend - a.spend);
    }
  })();

  // Guard every max with 1 so an all-zero list never yields NaN %.
  const maxSpend = Math.max(1, ...creatives.map((c) => c.spend));
  const maxRoas = Math.max(1, ...creatives.map((c) => roasOf(c)));
  const maxCtr = Math.max(1, ...creatives.map((c) => c.ctr));

  function getBarWidth(c: Creative) {
    switch (tab) {
      case "spend":
        return (c.spend / maxSpend) * 100;
      case "roas":
        return (roasOf(c) / maxRoas) * 100;
      case "ctr":
        return (c.ctr / maxCtr) * 100;
      case "fatigued":
        return Math.min(100, Math.max(10, (c.spend / maxSpend) * 100));
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
          value: fmtMoney(c.spend, currency),
          color: "text-violet-400",
        };
      case "roas":
        return {
          label: "ROAS",
          value: fmtRoas(c.roasUnavailable ? null : c.roas, { estimated: c.roasEstimated }),
          color: "text-emerald-400",
        };
      case "ctr":
        return { label: "CTR", value: `${c.ctr}%`, color: "text-blue-400" };
      case "fatigued":
        return {
          label: c.format === "Video" && c.hookRate > 0 && c.hookRate < FATIGUE_HOOK_RATE ? "Hook" : "Fréq. hebdo",
          value: c.format === "Video" && c.hookRate > 0 && c.hookRate < FATIGUE_HOOK_RATE ? `${c.hookRate.toFixed(1)}%` : (typeof c.frequencyWeekly === "number" ? c.frequencyWeekly.toFixed(2) : "—"),
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
        return { dataKey: "ctr", color: "#3b82f6" };
      case "fatigued":
        return { dataKey: "ctr", color: "#f59e0b" };
    }
  }

  const trendConfig = getTrendConfig(tab);

  return (
    <div className="p-6 space-y-5">
      {/* Page Help */}
      <PageHelp
        title="Top Charts — Classement de tes créas"
        description="Visualise tes meilleures créas par ROAS, Spend ou CTR, et repère en un coup d'œil celles qui s'essoufflent. Chaque ligne affiche la tendance quotidienne réelle de la métrique classée (jusqu'à 14 jours)."
        steps={[
          "Sélectionne un onglet (Top ROAS, Top Spend, Top CTR) pour voir les créas classées selon cette métrique.",
          "Consulte l'onglet 'Fatigued' pour identifier les créas à remplacer en priorité avant qu'elles brûlent ton budget.",
          "Clique sur une créa pour ouvrir le détail : funnel, tendances et comparaison semaine par semaine.",
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
              Vidéos dont le hook (démarrages / impressions) est inférieur à {FATIGUE_HOOK_RATE} % ou annonces dont la fréquence hebdo ≥ {FATIGUE_FREQUENCY_WEEKLY}.
              Envisage de les remplacer ou de retravailler l&apos;accroche.
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
                currency={currency}
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

      {/* Creative Detail Modal */}
      <CreativeModal
        creative={selectedCreative}
        onClose={() => setSelectedCreative(null)}
      />
    </div>
  );
}
