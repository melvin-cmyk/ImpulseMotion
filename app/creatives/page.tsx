"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { Platform, Format, Status, Creative } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import { CreativeThumbnail } from "@/components/creative-thumbnail";
import { CreativeModal } from "@/components/creative-modal";
import { DateRangePicker } from "@/components/date-range-picker";
import { LineChart, Line, ResponsiveContainer, Tooltip } from "recharts";
import { ArrowUpDown, Database, Wifi, DollarSign, MousePointerClick, Play, TrendingUp, Rocket, Scissors, ChevronDown, ChevronUp, Sparkles, Zap, AlertCircle, Star, LayoutGrid, Table2, ChevronUp as ChevronUpSort, X, Tag } from "lucide-react";
import { FiltersBar, AdStatus } from "@/components/ui/filters-bar";

type SortKey = "roas" | "cpa" | "spend" | "ctr" | "hookRate";
type ViewMode = "card" | "table";
type TableSortKey = "name" | "spend" | "ctr" | "hookRate" | "thumbstop" | "roas" | "cpa" | "status";

// ── localStorage helpers for tags ─────────────────────────────────────────────

function getTagsForCreative(creativeId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(`impulse_tags_${creativeId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function getAllUsedTags(creatives: Creative[]): string[] {
  const set = new Set<string>();
  creatives.forEach((c) => {
    getTagsForCreative(c.id).forEach((t) => set.add(t));
  });
  return Array.from(set).sort();
}

// ── Score badge (A/B/C/D) ─────────────────────────────────────────────────────

function getScore(creative: Creative): "A" | "B" | "C" | "D" {
  // For video creatives: use hookRate + ROAS composite
  if (creative.hookRate > 0) {
    if (creative.hookRate >= 30 && creative.roas >= 4) return "A";
    if (creative.hookRate >= 20 || creative.roas >= 3.5) return "B";
    if (creative.hookRate >= 10 || creative.roas >= 2) return "C";
    return "D";
  }
  // For image/carousel: use ROAS + CTR
  if (creative.roas >= 4 && creative.ctr >= 2.5) return "A";
  if (creative.roas >= 3 || creative.ctr >= 2) return "B";
  if (creative.roas >= 1.5 || creative.ctr >= 1) return "C";
  return "D";
}

function ScoreBadge({ creative }: { creative: Creative }) {
  const score = getScore(creative);
  const styles: Record<string, string> = {
    A: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-emerald-900/30",
    B: "bg-blue-500/20 text-blue-300 border border-blue-500/40 shadow-blue-900/30",
    C: "bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-amber-900/30",
    D: "bg-red-500/20 text-red-300 border border-red-500/40 shadow-red-900/30",
  };
  return (
    <span className={`text-xs font-bold px-1.5 py-0.5 rounded-md shadow-sm ${styles[score]}`}>
      {score}
    </span>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent: string;
}

function KpiCard({ label, value, sub, icon: Icon, accent }: KpiCardProps) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex items-start gap-3">
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${accent}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div>
        <p className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">{label}</p>
        <p className="text-xl font-bold text-white mt-0.5">{value}</p>
        {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

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

// ── Sparkline (CTR trend) ─────────────────────────────────────────────────────

function Sparkline({ data }: { data: { date: string; roas: number; ctr?: number }[] }) {
  // Build per-day CTR from trend data (clicks/impressions * 100)
  const sparkData = data.map((d) => ({
    date: d.date,
    ctr: d.ctr ?? ((d as { clicks?: number }).clicks && (d as { impressions?: number }).impressions
      ? (((d as { clicks?: number }).clicks ?? 0) / ((d as { impressions?: number }).impressions ?? 1)) * 100
      : d.roas),
    roas: d.roas,
  }));

  return (
    <ResponsiveContainer width="100%" height={36}>
      <LineChart data={sparkData}>
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
          formatter={(v: unknown) => [`${Number(v).toFixed(2)}x`, "ROAS"]}
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

// ── Creatives to Scale section ────────────────────────────────────────────────

function CreativesToScaleSection({
  creatives,
  onCreativeClick,
}: {
  creatives: Creative[];
  onCreativeClick: (c: Creative) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const toScale = useMemo(() => {
    if (creatives.length === 0) return [];
    const spends = creatives.map((c) => c.spend).sort((a, b) => a - b);
    const roasArr = creatives.map((c) => c.roas).sort((a, b) => a - b);
    const medianSpend = spends[Math.floor(spends.length / 2)];
    const medianRoas = roasArr[Math.floor(roasArr.length / 2)];
    return creatives
      .filter((c) => c.spend < medianSpend && c.roas > medianRoas)
      .sort((a, b) => b.roas - a.roas)
      .slice(0, 5);
  }, [creatives]);

  if (toScale.length === 0) return null;

  return (
    <div className="bg-gray-900 border border-emerald-800/40 rounded-2xl overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 border-b border-gray-800 hover:bg-gray-800/30 transition-colors"
      >
        <div className="w-8 h-8 rounded-xl bg-emerald-500/20 flex items-center justify-center shrink-0">
          <Rocket className="w-4 h-4 text-emerald-400" />
        </div>
        <div className="text-left flex-1">
          <h2 className="text-sm font-semibold text-emerald-300">Creatives to Scale</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Low spend + high ROAS — untapped scaling potential ({toScale.length})
          </p>
        </div>
        {collapsed ? (
          <ChevronDown className="w-4 h-4 text-gray-500" />
        ) : (
          <ChevronUp className="w-4 h-4 text-gray-500" />
        )}
      </button>

      {!collapsed && (
        <div className="divide-y divide-gray-800">
          {toScale.map((c) => (
            <div
              key={c.id}
              onClick={() => onCreativeClick(c)}
              className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-800/40 cursor-pointer transition-colors"
            >
              <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0">
                <CreativeThumbnail
                  format={c.format}
                  thumbnailColor={c.thumbnailColor}
                  thumbnailUrl={c.thumbnailUrl}
                  videoUrl={c.videoUrl}
                  videoId={c.videoId}
                  className="w-10 h-10"
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-mono text-gray-200 truncate">{c.name}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <PlatformBadge platform={c.platform} />
                  <span className="text-[10px] text-gray-500 uppercase">{c.format}</span>
                </div>
              </div>
              <div className="flex items-center gap-6 shrink-0">
                <div className="text-center">
                  <p className="text-[10px] text-gray-500 uppercase">Spend</p>
                  <p className="text-xs font-semibold text-gray-300">
                    ${(c.spend / 1000).toFixed(1)}k
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] text-gray-500 uppercase">ROAS</p>
                  <p className="text-xs font-semibold text-emerald-400">{c.roas}x</p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] text-gray-500 uppercase">CTR</p>
                  <p className="text-xs font-semibold text-gray-300">{c.ctr}%</p>
                </div>
                <ScoreBadge creative={c} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Creatives to Cut section ──────────────────────────────────────────────────

function CreativesToCutSection({
  creatives,
  onCreativeClick,
}: {
  creatives: Creative[];
  onCreativeClick: (c: Creative) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const toCut = useMemo(() => {
    if (creatives.length === 0) return [];
    // Frequency proxy: impressions / clicks (higher = more repetitive exposure per click)
    // CTR declining = status Fatigued OR low CTR relative to spend
    const avgCtr = creatives.reduce((s, c) => s + c.ctr, 0) / creatives.length;
    return creatives
      .filter((c) => {
        const frequency = c.impressions > 0 && c.clicks > 0 ? c.impressions / c.clicks : 0;
        const frequencyHigh = frequency > 30; // >30 impressions per click = high frequency proxy
        const ctrDeclined = c.ctr < avgCtr * 0.7 || c.status === "Fatigued";
        return frequencyHigh && ctrDeclined;
      })
      .sort((a, b) => a.ctr - b.ctr)
      .slice(0, 5);
  }, [creatives]);

  if (toCut.length === 0) return null;

  return (
    <div className="bg-gray-900 border border-red-800/40 rounded-2xl overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 border-b border-gray-800 hover:bg-gray-800/30 transition-colors"
      >
        <div className="w-8 h-8 rounded-xl bg-red-500/20 flex items-center justify-center shrink-0">
          <Scissors className="w-4 h-4 text-red-400" />
        </div>
        <div className="text-left flex-1">
          <h2 className="text-sm font-semibold text-red-300">Creatives to Cut</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            High frequency + declining CTR — confirmed ad fatigue ({toCut.length})
          </p>
        </div>
        {collapsed ? (
          <ChevronDown className="w-4 h-4 text-gray-500" />
        ) : (
          <ChevronUp className="w-4 h-4 text-gray-500" />
        )}
      </button>

      {!collapsed && (
        <div className="divide-y divide-gray-800">
          {toCut.map((c) => {
            const frequency =
              c.impressions > 0 && c.clicks > 0
                ? (c.impressions / c.clicks).toFixed(0)
                : "—";
            return (
              <div
                key={c.id}
                onClick={() => onCreativeClick(c)}
                className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-800/40 cursor-pointer transition-colors"
              >
                <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0">
                  <CreativeThumbnail
                    format={c.format}
                    thumbnailColor={c.thumbnailColor}
                    thumbnailUrl={c.thumbnailUrl}
                    videoUrl={c.videoUrl}
                    videoId={c.videoId}
                    className="w-10 h-10"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-gray-200 truncate">{c.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <PlatformBadge platform={c.platform} />
                    <StatusBadge status={c.status} />
                  </div>
                </div>
                <div className="flex items-center gap-6 shrink-0">
                  <div className="text-center">
                    <p className="text-[10px] text-gray-500 uppercase">Freq.</p>
                    <p className="text-xs font-semibold text-red-400">{frequency}x</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-gray-500 uppercase">CTR</p>
                    <p className="text-xs font-semibold text-gray-300">{c.ctr}%</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-gray-500 uppercase">ROAS</p>
                    <p className="text-xs font-semibold text-gray-400">{c.roas}x</p>
                  </div>
                  <ScoreBadge creative={c} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Creative Labels/Tags ──────────────────────────────────────────────────────

export interface CreativeLabel {
  text: string;
  emoji: string;
  style: string;
}

export function getCreativeLabels(
  creative: Creative,
  allCreatives: Creative[]
): CreativeLabel[] {
  const labels: CreativeLabel[] = [];
  if (allCreatives.length === 0) return labels;

  // "Top Performer" — ROAS in top 10%
  const sortedByRoas = [...allCreatives].sort((a, b) => b.roas - a.roas);
  const top10pctIndex = Math.ceil(allCreatives.length * 0.1);
  const roasThreshold = sortedByRoas[top10pctIndex - 1]?.roas ?? 0;
  if (creative.roas >= roasThreshold && allCreatives.length >= 3) {
    labels.push({
      text: "Top Performer",
      emoji: "🏅",
      style: "bg-amber-500/20 text-amber-300 border border-amber-500/40",
    });
  }

  // "Winner" — CTR > 2% AND ROAS > 3
  if (creative.ctr > 2 && creative.roas > 3) {
    labels.push({
      text: "Winner",
      emoji: "🏆",
      style: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40",
    });
  }

  // "Fatigué" — frequency proxy > 3 (impressions / clicks > 200) AND CTR below average
  const avgCtr = allCreatives.reduce((s, c) => s + c.ctr, 0) / allCreatives.length;
  const freqProxy =
    creative.clicks > 0 ? creative.impressions / creative.clicks : 0;
  if (freqProxy > 200 && creative.ctr < avgCtr) {
    labels.push({
      text: "Fatigué",
      emoji: "😴",
      style: "bg-orange-500/20 text-orange-300 border border-orange-500/40",
    });
  }

  // "En test" — Spend < 50€ (or $50)
  if (creative.spend < 50) {
    labels.push({
      text: "En test",
      emoji: "🧪",
      style: "bg-blue-500/20 text-blue-300 border border-blue-500/40",
    });
  }

  return labels;
}

function CreativeLabelTags({
  creative,
  allCreatives,
}: {
  creative: Creative;
  allCreatives: Creative[];
}) {
  const labels = useMemo(
    () => getCreativeLabels(creative, allCreatives),
    [creative, allCreatives]
  );
  if (labels.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {labels.map((label) => (
        <span
          key={label.text}
          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${label.style}`}
        >
          {label.emoji} {label.text}
        </span>
      ))}
    </div>
  );
}

// ── Industry Benchmarks ───────────────────────────────────────────────────────

interface BenchmarkMetric {
  key: string;
  label: string;
  benchmark: number;
  unit: string;
  description: string;
  higherIsBetter: boolean;
  color: string;
}

const BENCHMARKS: BenchmarkMetric[] = [
  {
    key: "hookRate",
    label: "Hook Rate",
    benchmark: 30,
    unit: "%",
    description: "3-sec views / impressions",
    higherIsBetter: true,
    color: "bg-pink-500",
  },
  {
    key: "thumbstop",
    label: "Thumbstop",
    benchmark: 25,
    unit: "%",
    description: "scroll stops / impressions",
    higherIsBetter: true,
    color: "bg-violet-500",
  },
  {
    key: "ctr",
    label: "CTR",
    benchmark: 1.5,
    unit: "%",
    description: "clicks / impressions",
    higherIsBetter: true,
    color: "bg-blue-500",
  },
  {
    key: "holdRate",
    label: "Hold Rate",
    benchmark: 40,
    unit: "%",
    description: "15-sec views / 3-sec views",
    higherIsBetter: true,
    color: "bg-emerald-500",
  },
];

function BenchmarksSection({ creatives }: { creatives: Creative[] }) {
  const [collapsed, setCollapsed] = useState(false);

  const userMetrics = useMemo(() => {
    if (creatives.length === 0) return {} as Record<string, number>;
    const videoCreatives = creatives.filter((c) => c.hookRate > 0);
    const avgHookRate =
      videoCreatives.length > 0
        ? videoCreatives.reduce((s, c) => s + c.hookRate, 0) / videoCreatives.length
        : 0;
    const avgCtr = creatives.reduce((s, c) => s + c.ctr, 0) / creatives.length;
    // thumbstop: proxy via (clicks * 5) / impressions * 100 (rough estimate)
    const avgThumbstop =
      creatives.reduce((s, c) => {
        const imp = c.impressions;
        return imp > 0 ? s + (c.clicks * 5 / imp) * 100 : s;
      }, 0) / creatives.length;
    // holdRate: 15sec views / 3sec views
    const withHold = creatives.filter((c) => c.holdRate > 0);
    const avgHoldRate =
      withHold.length > 0
        ? withHold.reduce((s, c) => s + c.holdRate, 0) / withHold.length
        : 0;
    return {
      hookRate: avgHookRate,
      thumbstop: Math.min(avgThumbstop, 60),
      ctr: avgCtr,
      holdRate: avgHoldRate,
    };
  }, [creatives]);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 border-b border-gray-800 hover:bg-gray-800/30 transition-colors"
      >
        <div className="w-8 h-8 rounded-xl bg-blue-500/20 flex items-center justify-center shrink-0">
          <TrendingUp className="w-4 h-4 text-blue-400" />
        </div>
        <div className="text-left flex-1">
          <h2 className="text-sm font-semibold text-white">Industry Benchmarks</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Your KPIs vs e-commerce average — see where you stand
          </p>
        </div>
        {collapsed ? (
          <ChevronDown className="w-4 h-4 text-gray-500" />
        ) : (
          <ChevronUp className="w-4 h-4 text-gray-500" />
        )}
      </button>

      {!collapsed && (
        <div className="p-5 space-y-5">
          <p className="text-[11px] text-gray-500">
            Benchmarks based on e-commerce industry averages. Your metrics are averaged across all filtered creatives.
          </p>
          <div className="space-y-4">
            {BENCHMARKS.map((bm) => {
              const userVal = userMetrics[bm.key] ?? 0;
              const maxVal = Math.max(userVal, bm.benchmark) * 1.3;
              const userPct = Math.min((userVal / maxVal) * 100, 100);
              const bmPct = Math.min((bm.benchmark / maxVal) * 100, 100);
              const isAbove = userVal >= bm.benchmark;
              const diff = userVal > 0 ? ((userVal - bm.benchmark) / bm.benchmark) * 100 : null;

              return (
                <div key={bm.key}>
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <span className="text-sm font-semibold text-white">{bm.label}</span>
                      <span className="text-[11px] text-gray-500 ml-2">{bm.description}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      {userVal > 0 ? (
                        <span className={`font-bold ${isAbove ? "text-emerald-400" : "text-red-400"}`}>
                          {userVal.toFixed(1)}{bm.unit}
                          {diff !== null && (
                            <span className="ml-1 font-normal opacity-70">
                              ({diff > 0 ? "+" : ""}{diff.toFixed(0)}%)
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-gray-600">no data</span>
                      )}
                      <span className="text-gray-500">
                        Benchmark: <span className="text-gray-300">{bm.benchmark}{bm.unit}</span>
                      </span>
                    </div>
                  </div>
                  {/* Stacked bar chart */}
                  <div className="relative h-5 bg-gray-800 rounded-full overflow-hidden">
                    {/* Benchmark marker */}
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-gray-400 z-10"
                      style={{ left: `${bmPct}%` }}
                    />
                    {/* User bar */}
                    {userVal > 0 && (
                      <div
                        className={`h-full rounded-full transition-all duration-700 ${isAbove ? bm.color : "bg-gray-600"} opacity-80`}
                        style={{ width: `${userPct}%` }}
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-1 mt-1">
                    <div className="w-2 h-2 rounded-full bg-gray-400" />
                    <span className="text-[10px] text-gray-600">Benchmark line at {bm.benchmark}{bm.unit}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── AI Insights ───────────────────────────────────────────────────────────────

interface AiInsight {
  icon: React.ElementType;
  color: string;
  bgColor: string;
  borderColor: string;
  title: string;
  description: string;
}

function generateInsights(creatives: Creative[]): AiInsight[] {
  if (creatives.length === 0) return [];
  const insights: AiInsight[] = [];

  // Insight 1: Video vs Image CTR comparison
  const videos = creatives.filter((c) => c.format === "Video");
  const images = creatives.filter((c) => c.format === "Image");
  if (videos.length > 0 && images.length > 0) {
    const videoCtr = videos.reduce((s, c) => s + c.ctr, 0) / videos.length;
    const imageCtr = images.reduce((s, c) => s + c.ctr, 0) / images.length;
    if (videoCtr > imageCtr * 1.2) {
      const ratio = (videoCtr / imageCtr).toFixed(1);
      insights.push({
        icon: Zap,
        color: "text-violet-300",
        bgColor: "bg-violet-500/15",
        borderColor: "border-violet-500/30",
        title: "Videos outperform images on CTR",
        description: `Your video creatives have a ${ratio}x higher CTR (${videoCtr.toFixed(2)}%) vs images (${imageCtr.toFixed(2)}%) this period. Consider shifting more budget toward video formats.`,
      });
    } else if (imageCtr > videoCtr * 1.2) {
      const ratio = (imageCtr / videoCtr).toFixed(1);
      insights.push({
        icon: Zap,
        color: "text-blue-300",
        bgColor: "bg-blue-500/15",
        borderColor: "border-blue-500/30",
        title: "Images outperform videos on CTR",
        description: `Your image creatives have a ${ratio}x higher CTR (${imageCtr.toFixed(2)}%) vs videos (${videoCtr.toFixed(2)}%) this period. Images are driving stronger engagement right now.`,
      });
    }
  }

  // Insight 2: Underutilized top performer (high ROAS, low spend)
  if (creatives.length > 0) {
    const sortedByRoas = [...creatives].sort((a, b) => b.roas - a.roas);
    const spends = creatives.map((c) => c.spend).sort((a, b) => a - b);
    const medianSpend = spends[Math.floor(spends.length / 2)];
    const topRoas = sortedByRoas[0];
    if (topRoas && topRoas.spend < medianSpend && topRoas.roas > 3) {
      insights.push({
        icon: Rocket,
        color: "text-emerald-300",
        bgColor: "bg-emerald-500/15",
        borderColor: "border-emerald-500/30",
        title: "Underutilized winner detected",
        description: `"${topRoas.name.slice(0, 30)}..." has your best ROAS at ${topRoas.roas}x but only $${(topRoas.spend / 1000).toFixed(1)}k spend. Scale this creative — it's your top performer flying under the radar.`,
      });
    }
  }

  // Insight 3: Hook Rate opportunity
  const videoWithHook = creatives.filter((c) => c.hookRate > 0);
  if (videoWithHook.length > 0) {
    const avgHook = videoWithHook.reduce((s, c) => s + c.hookRate, 0) / videoWithHook.length;
    const bestHook = [...videoWithHook].sort((a, b) => b.hookRate - a.hookRate)[0];
    const worstHook = [...videoWithHook].sort((a, b) => a.hookRate - b.hookRate)[0];
    if (bestHook && bestHook.hookRate > avgHook * 1.5) {
      insights.push({
        icon: Star,
        color: "text-amber-300",
        bgColor: "bg-amber-500/15",
        borderColor: "border-amber-500/30",
        title: "Best Hook Rate is underscaled",
        description: `"${bestHook.name.slice(0, 30)}..." hooks ${bestHook.hookRate}% of viewers in the first 3 seconds — ${((bestHook.hookRate / avgHook - 1) * 100).toFixed(0)}% above average. Strong hooks = lower CPMs. Prioritize scaling it.`,
      });
    } else if (worstHook && worstHook.hookRate < avgHook * 0.5 && worstHook.spend > 500) {
      insights.push({
        icon: AlertCircle,
        color: "text-red-300",
        bgColor: "bg-red-500/15",
        borderColor: "border-red-500/30",
        title: "Weak hook burning your budget",
        description: `"${worstHook.name.slice(0, 30)}..." only hooks ${worstHook.hookRate}% of viewers — far below your ${avgHook.toFixed(1)}% average. Consider refreshing the first 3 seconds or pausing it.`,
      });
    }
  }

  // Insight 4: ROAS spread — top vs bottom gap
  if (creatives.length >= 4) {
    const sortedRoas = [...creatives].sort((a, b) => b.roas - a.roas);
    const top25 = sortedRoas.slice(0, Math.ceil(sortedRoas.length * 0.25));
    const bottom25 = sortedRoas.slice(Math.floor(sortedRoas.length * 0.75));
    const topAvg = top25.reduce((s, c) => s + c.roas, 0) / top25.length;
    const botAvg = bottom25.reduce((s, c) => s + c.roas, 0) / bottom25.length;
    if (topAvg > botAvg * 2) {
      const totalBotSpend = bottom25.reduce((s, c) => s + c.spend, 0);
      insights.push({
        icon: TrendingUp,
        color: "text-pink-300",
        bgColor: "bg-pink-500/15",
        borderColor: "border-pink-500/30",
        title: `Top 25% outperform bottom 25% by ${(topAvg / botAvg).toFixed(1)}x`,
        description: `Your best creatives average ${topAvg.toFixed(1)}x ROAS vs ${botAvg.toFixed(1)}x for your weakest. Reallocating $${(totalBotSpend / 1000).toFixed(1)}k from low performers to top winners could significantly improve overall returns.`,
      });
    }
  }

  return insights.slice(0, 4);
}

function AiInsightsSection({ creatives }: { creatives: Creative[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const insights = useMemo(() => generateInsights(creatives), [creatives]);

  if (insights.length === 0) return null;

  return (
    <div className="bg-gray-900 border border-violet-800/40 rounded-2xl overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 border-b border-gray-800 hover:bg-gray-800/30 transition-colors"
      >
        <div className="w-8 h-8 rounded-xl bg-violet-500/20 flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4 text-violet-400" />
        </div>
        <div className="text-left flex-1">
          <h2 className="text-sm font-semibold text-violet-300">AI Insights</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Automated analysis from your creative data ({insights.length} insights)
          </p>
        </div>
        {collapsed ? (
          <ChevronDown className="w-4 h-4 text-gray-500" />
        ) : (
          <ChevronUp className="w-4 h-4 text-gray-500" />
        )}
      </button>

      {!collapsed && (
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          {insights.map((insight, i) => {
            const Icon = insight.icon;
            return (
              <div
                key={i}
                className={`${insight.bgColor} border ${insight.borderColor} rounded-xl p-4 flex gap-3`}
              >
                <div className={`w-8 h-8 rounded-lg ${insight.bgColor} border ${insight.borderColor} flex items-center justify-center shrink-0`}>
                  <Icon className={`w-4 h-4 ${insight.color}`} />
                </div>
                <div>
                  <p className={`text-xs font-semibold ${insight.color} mb-1`}>{insight.title}</p>
                  <p className="text-[11px] text-gray-400 leading-relaxed">{insight.description}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Table View ────────────────────────────────────────────────────────────────

function getMedian(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface TableViewProps {
  creatives: Creative[];
  onCreativeClick: (c: Creative) => void;
}

function TableView({ creatives, onCreativeClick }: TableViewProps) {
  const [sortKey, setSortKey] = useState<TableSortKey>("roas");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function handleSort(key: TableSortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "cpa" ? "asc" : "desc");
    }
  }

  const medians = useMemo(() => {
    return {
      spend: getMedian(creatives.map((c) => c.spend)),
      ctr: getMedian(creatives.map((c) => c.ctr)),
      hookRate: getMedian(creatives.map((c) => c.hookRate)),
      thumbstop: getMedian(
        creatives.map((c) =>
          c.impressions > 0 ? (c.clicks * 5 / c.impressions) * 100 : 0
        )
      ),
      roas: getMedian(creatives.map((c) => c.roas)),
      cpa: getMedian(creatives.map((c) => c.cpa)),
    };
  }, [creatives]);

  const sorted = useMemo(() => {
    const list = [...creatives];
    list.sort((a, b) => {
      let aVal: number | string = 0;
      let bVal: number | string = 0;
      if (sortKey === "name") { aVal = a.name; bVal = b.name; }
      else if (sortKey === "spend") { aVal = a.spend; bVal = b.spend; }
      else if (sortKey === "ctr") { aVal = a.ctr; bVal = b.ctr; }
      else if (sortKey === "hookRate") { aVal = a.hookRate; bVal = b.hookRate; }
      else if (sortKey === "thumbstop") {
        aVal = a.impressions > 0 ? (a.clicks * 5 / a.impressions) * 100 : 0;
        bVal = b.impressions > 0 ? (b.clicks * 5 / b.impressions) * 100 : 0;
      }
      else if (sortKey === "roas") { aVal = a.roas; bVal = b.roas; }
      else if (sortKey === "cpa") { aVal = a.cpa; bVal = b.cpa; }
      else if (sortKey === "status") { aVal = a.status; bVal = b.status; }

      if (typeof aVal === "string") {
        return sortDir === "asc"
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal);
      }
      return sortDir === "asc"
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return list;
  }, [creatives, sortKey, sortDir]);

  function cellColor(value: number, median: number, higherIsBetter = true): string {
    if (value === 0 || median === 0) return "";
    const isGood = higherIsBetter ? value > median : value < median;
    return isGood
      ? "bg-emerald-900/30 text-emerald-300"
      : "bg-red-900/30 text-red-300";
  }

  function SortIcon({ col }: { col: TableSortKey }) {
    if (col !== sortKey)
      return <ChevronUpSort className="w-3 h-3 text-gray-600 opacity-40" />;
    return sortDir === "asc" ? (
      <ChevronUpSort className="w-3 h-3 text-violet-400" />
    ) : (
      <ChevronUpSort className="w-3 h-3 text-violet-400 rotate-180" />
    );
  }

  const columns: { key: TableSortKey; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "spend", label: "Spend" },
    { key: "ctr", label: "CTR" },
    { key: "hookRate", label: "Hook Rate" },
    { key: "thumbstop", label: "Thumbstop" },
    { key: "roas", label: "ROAS" },
    { key: "cpa", label: "CPA" },
    { key: "status", label: "Status" },
  ];

  return (
    <div className="overflow-x-auto rounded-2xl border border-gray-800 bg-gray-900">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="px-3 py-3 text-left text-[10px] text-gray-500 uppercase tracking-wide w-12">
              Thumb
            </th>
            {columns.map((col) => (
              <th
                key={col.key}
                onClick={() => handleSort(col.key)}
                className="px-3 py-3 text-left text-[10px] text-gray-500 uppercase tracking-wide cursor-pointer hover:text-gray-300 transition-colors select-none"
              >
                <div className="flex items-center gap-1">
                  {col.label}
                  <SortIcon col={col.key} />
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/60">
          {sorted.map((c) => {
            const thumbstop =
              c.impressions > 0
                ? Math.min((c.clicks * 5 / c.impressions) * 100, 60)
                : 0;

            const statusMap: Record<Status, string> = {
              Winner: "bg-green-900/60 text-green-300 border border-green-800",
              Loser: "bg-red-900/60 text-red-300 border border-red-800",
              Fatigued: "bg-orange-900/60 text-orange-300 border border-orange-800",
              Active: "bg-blue-900/60 text-blue-300 border border-blue-800",
            };

            return (
              <tr
                key={c.id}
                onClick={() => onCreativeClick(c)}
                className="hover:bg-gray-800/40 cursor-pointer transition-colors"
              >
                {/* Thumbnail */}
                <td className="px-3 py-2">
                  <div className="w-12 h-12 rounded-lg overflow-hidden shrink-0">
                    <CreativeThumbnail
                      format={c.format}
                      thumbnailColor={c.thumbnailColor}
                      thumbnailUrl={c.thumbnailUrl}
                      videoUrl={c.videoUrl}
                      videoId={c.videoId}
                      className="w-12 h-12"
                    />
                  </div>
                </td>
                {/* Name */}
                <td className="px-3 py-2 max-w-[200px]">
                  <p className="text-xs font-mono text-gray-200 truncate" title={c.name}>
                    {c.name}
                  </p>
                </td>
                {/* Spend */}
                <td className={`px-3 py-2 text-xs font-semibold rounded-none ${cellColor(c.spend, medians.spend)}`}>
                  {c.spend >= 1000 ? `$${(c.spend / 1000).toFixed(1)}k` : `$${c.spend.toFixed(0)}`}
                </td>
                {/* CTR */}
                <td className={`px-3 py-2 text-xs font-semibold ${cellColor(c.ctr, medians.ctr)}`}>
                  {c.ctr.toFixed(2)}%
                </td>
                {/* Hook Rate */}
                <td className={`px-3 py-2 text-xs font-semibold ${cellColor(c.hookRate, medians.hookRate)}`}>
                  {c.hookRate > 0 ? `${c.hookRate.toFixed(1)}%` : "—"}
                </td>
                {/* Thumbstop */}
                <td className={`px-3 py-2 text-xs font-semibold ${cellColor(thumbstop, medians.thumbstop)}`}>
                  {thumbstop > 0 ? `${thumbstop.toFixed(1)}%` : "—"}
                </td>
                {/* ROAS */}
                <td className={`px-3 py-2 text-xs font-semibold ${cellColor(c.roas, medians.roas)}`}>
                  {c.roas > 0 ? `${c.roas}x` : "—"}
                </td>
                {/* CPA */}
                <td className={`px-3 py-2 text-xs font-semibold ${cellColor(c.cpa, medians.cpa, false)}`}>
                  {c.cpa > 0 ? `$${c.cpa}` : "—"}
                </td>
                {/* Status */}
                <td className="px-3 py-2">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusMap[c.status]}`}>
                    {c.status}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && (
        <div className="flex items-center justify-center h-24 text-gray-600 text-sm">
          No creatives match the selected filters.
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CreativesPage() {
  const [platform, setPlatform] = useState<"All" | Platform>("All");
  const [status, setStatus] = useState<"All" | Status>("All");
  const [format, setFormat] = useState<"All" | Format>("All");
  const [sortBy, setSortBy] = useState<SortKey>("roas");
  const [adStatus, setAdStatus] = useState<AdStatus>("ALL");
  const [selectedCreative, setSelectedCreative] = useState<Creative | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("card");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  // Key to re-compute tags after modal closes (localStorage update)
  const [tagsKey, setTagsKey] = useState(0);

  const { creatives, isLoading: loading, error, isRealData } = useCreativesContext();

  // Refresh tags list when modal closes
  const handleModalClose = useCallback(() => {
    setSelectedCreative(null);
    setTagsKey((k) => k + 1);
  }, []);

  const allTags = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    tagsKey; // dependency to recompute
    return getAllUsedTags(creatives);
  }, [creatives, tagsKey]);

  // Derive meta account id from localStorage for FiltersBar
  const [metaAccountId, setMetaAccountId] = useState<string | null>(null);
  useMemo(() => {
    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem("impulse_meta_account");
        if (raw) setMetaAccountId(JSON.parse(raw).accountId ?? null);
      } catch {}
    }
  }, []);

  const filtered = useMemo(() => {
    let list = [...creatives];
    if (platform !== "All") list = list.filter((c) => c.platform === platform);
    if (status !== "All") list = list.filter((c) => c.status === status);
    if (format !== "All") list = list.filter((c) => c.format === format);
    if (adStatus === "ACTIVE") {
      list = list.filter((c) => c.status === "Active" || c.status === "Winner");
    } else if (adStatus === "PAUSED") {
      list = list.filter((c) => c.status === "Loser" || c.status === "Fatigued");
    }
    if (selectedTag) {
      list = list.filter((c) => getTagsForCreative(c.id).includes(selectedTag));
    }
    list.sort((a, b) => {
      if (sortBy === "cpa") return a.cpa - b.cpa;
      return (b[sortBy] as number) - (a[sortBy] as number);
    });
    return list;
  }, [creatives, platform, status, format, sortBy, adStatus, selectedTag, tagsKey]);

  // ── KPI Summary calculations ──────────────────────────────────────────────
  const kpiData = useMemo(() => {
    if (filtered.length === 0) {
      return { totalSpend: 0, avgCtr: 0, avgHookRate: 0, avgRoas: 0 };
    }
    const totalSpend = filtered.reduce((s, c) => s + c.spend, 0);
    const avgCtr =
      filtered.reduce((s, c) => s + c.ctr, 0) / filtered.length;
    const videoCreatives = filtered.filter((c) => c.hookRate > 0);
    const avgHookRate =
      videoCreatives.length > 0
        ? videoCreatives.reduce((s, c) => s + c.hookRate, 0) /
          videoCreatives.length
        : 0;
    const roasCreatives = filtered.filter((c) => c.roas > 0);
    const avgRoas =
      roasCreatives.length > 0
        ? roasCreatives.reduce((s, c) => s + c.roas, 0) / roasCreatives.length
        : 0;
    return { totalSpend, avgCtr, avgHookRate, avgRoas };
  }, [filtered]);

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Creative Feed</h1>
          <p className="text-gray-400 text-sm mt-0.5">{filtered.length} creatives</p>
        </div>
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
            <button
              onClick={() => setViewMode("card")}
              title="Card view"
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                viewMode === "card"
                  ? "bg-violet-600 text-white"
                  : "text-gray-500 hover:text-gray-200"
              }`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode("table")}
              title="Table view"
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                viewMode === "table"
                  ? "bg-violet-600 text-white"
                  : "text-gray-500 hover:text-gray-200"
              }`}
            >
              <Table2 className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border border-gray-800 bg-gray-900">
            {isRealData ? (
              <><Wifi className="w-3 h-3 text-green-400" /><span className="text-green-400">Live data</span></>
            ) : (
              <><Database className="w-3 h-3 text-gray-500" /><span className="text-gray-500">Demo data</span></>
            )}
          </div>
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

      {/* Date Range Picker */}
      <DateRangePicker />

      {/* KPI Summary Cards */}
      {!loading && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            label="Total Spend"
            value={
              kpiData.totalSpend >= 1000
                ? `$${(kpiData.totalSpend / 1000).toFixed(1)}k`
                : `$${kpiData.totalSpend.toFixed(0)}`
            }
            sub={`across ${filtered.length} creatives`}
            icon={DollarSign}
            accent="bg-violet-500/20 text-violet-400"
          />
          <KpiCard
            label="Avg CTR"
            value={`${kpiData.avgCtr.toFixed(2)}%`}
            sub="click-through rate"
            icon={MousePointerClick}
            accent="bg-blue-500/20 text-blue-400"
          />
          <KpiCard
            label="Avg Hook Rate"
            value={
              kpiData.avgHookRate > 0
                ? `${kpiData.avgHookRate.toFixed(1)}%`
                : "—"
            }
            sub="3s views / impressions"
            icon={Play}
            accent="bg-pink-500/20 text-pink-400"
          />
          <KpiCard
            label="Avg ROAS"
            value={
              kpiData.avgRoas > 0 ? `${kpiData.avgRoas.toFixed(2)}x` : "—"
            }
            sub="return on ad spend"
            icon={TrendingUp}
            accent="bg-emerald-500/20 text-emerald-400"
          />
        </div>
      )}

      {/* AI Insights */}
      {!loading && (
        <AiInsightsSection creatives={creatives} />
      )}

      {/* Industry Benchmarks */}
      {!loading && (
        <BenchmarksSection creatives={filtered} />
      )}

      {/* Filters Bar (campaign + ad status) */}
      <FiltersBar
        accountId={metaAccountId}
        adStatus={adStatus}
        onAdStatusChange={setAdStatus}
      />

      {/* Creatives to Scale */}
      {!loading && (
        <CreativesToScaleSection
          creatives={creatives}
          onCreativeClick={setSelectedCreative}
        />
      )}

      {/* Creatives to Cut */}
      {!loading && (
        <CreativesToCutSection
          creatives={creatives}
          onCreativeClick={setSelectedCreative}
        />
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

      {/* Tag filter */}
      {allTags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Tag className="w-3.5 h-3.5" />
            <span>Tags:</span>
          </div>
          <button
            onClick={() => setSelectedTag(null)}
            className={`text-xs font-semibold px-2.5 py-1 rounded-full border transition-colors ${
              selectedTag === null
                ? "bg-violet-600 border-violet-500 text-white"
                : "bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200"
            }`}
          >
            All
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
              className={`flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border transition-colors ${
                selectedTag === tag
                  ? "bg-violet-500/20 border-violet-500/50 text-violet-300"
                  : "bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200"
              }`}
            >
              {tag}
              {selectedTag === tag && <X className="w-3 h-3" />}
            </button>
          ))}
        </div>
      )}

      {/* Table View */}
      {!loading && viewMode === "table" && (
        <TableView creatives={filtered} onCreativeClick={setSelectedCreative} />
      )}

      {/* Grid */}
      {!loading && viewMode === "card" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((creative) => (
            <div
              key={creative.id}
              onClick={() => setSelectedCreative(creative)}
              className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden hover:border-violet-700/60 hover:shadow-xl hover:shadow-violet-900/20 transition-all duration-200 group cursor-pointer"
            >
              {/* Thumbnail */}
              <div className="relative">
                <CreativeThumbnail
                  format={creative.format}
                  thumbnailColor={creative.thumbnailColor}
                  thumbnailUrl={creative.thumbnailUrl}
                  videoUrl={creative.videoUrl}
                  videoId={creative.videoId}
                  className="h-36"
                />
                <div className="absolute top-2 left-2 z-10">
                  <PlatformBadge platform={creative.platform} />
                </div>
                <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
                  <ScoreBadge creative={creative} />
                  <StatusBadge status={creative.status} />
                </div>
                <div className="absolute bottom-2 left-2 z-10 text-[10px] font-medium text-white/60 uppercase tracking-wide">
                  {creative.format}
                </div>
              </div>

              {/* Body */}
              <div className="p-3 space-y-3">
                <div>
                  <p className="text-xs font-mono text-gray-300 truncate" title={creative.name}>
                    {creative.name}
                  </p>
                  <CreativeLabelTags creative={creative} allCreatives={creatives} />
                </div>

                {/* Sparkline (ROAS trend — last 7 points) */}
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

      {!loading && filtered.length === 0 && viewMode === "card" && (
        <div className="flex items-center justify-center h-48 text-gray-600">
          No creatives match the selected filters.
        </div>
      )}

      {/* Creative Detail Modal */}
      <CreativeModal
        creative={selectedCreative}
        onClose={handleModalClose}
      />
    </div>
  );
}
