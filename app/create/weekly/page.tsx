"use client";

import { useMemo, useState } from "react";
import { useCreativesContext } from "@/lib/creatives-context";
import { Sidebar } from "@/components/sidebar";
import { CreativeThumbnail } from "@/components/creative-thumbnail";
import { DayMetric } from "@/lib/mock-data";
import {
  DollarSign,
  Eye,
  MousePointerClick,
  TrendingUp,
  ShoppingCart,
  BarChart3,
  ArrowUp,
  ArrowDown,
  Presentation,
  Target,
  AlertTriangle,
  Sparkles,
} from "lucide-react";

// ── KPI card ──────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  wowChange,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  wowChange?: number | null;
  icon: React.ElementType;
  accent: string;
}) {
  const hasWow = wowChange != null && !isNaN(wowChange);
  const isPositive = hasWow && wowChange! >= 0;
  return (
    <div className="bg-[#111118] border border-gray-800 rounded-2xl p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${accent}`}>
          <Icon className="w-4 h-4 text-white" />
        </div>
        <span className="text-xs text-gray-400 font-medium">{label}</span>
      </div>
      <div>
        <div className="text-2xl font-bold text-white">{value}</div>
        {hasWow && (
          <div
            className={`flex items-center gap-0.5 text-xs mt-1 font-medium ${
              isPositive ? "text-emerald-400" : "text-red-400"
            }`}
          >
            {isPositive ? (
              <ArrowUp className="w-3 h-3" />
            ) : (
              <ArrowDown className="w-3 h-3" />
            )}
            {Math.abs(wowChange!).toFixed(1)}% vs prev week
          </div>
        )}
      </div>
    </div>
  );
}

function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtCurrency(n: number) {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Spend Distribution ────────────────────────────────────────────────────────

function SpendBreakdown({
  creatives,
}: {
  creatives: Array<{ spend: number; format?: string | null; status: string }>;
}) {
  const total = creatives.reduce((s, c) => s + c.spend, 0);
  if (total === 0) return null;

  const formatColors: Record<string, string> = {
    Video: "bg-violet-500",
    Image: "bg-cyan-500",
    Carousel: "bg-pink-500",
  };
  const statusColors: Record<string, string> = {
    Winner: "bg-emerald-500",
    Active: "bg-blue-500",
    Fatigued: "bg-amber-500",
    Paused: "bg-gray-500",
  };

  const byFormat = Object.entries(
    creatives.reduce<Record<string, number>>((acc, c) => {
      const key = c.format ?? "Other";
      acc[key] = (acc[key] ?? 0) + c.spend;
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1]);

  const byStatus = Object.entries(
    creatives.reduce<Record<string, number>>((acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + c.spend;
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1]);

  const BarRow = ({
    label,
    spend,
    colorClass,
  }: {
    label: string;
    spend: number;
    colorClass: string;
  }) => {
    const pct = total > 0 ? (spend / total) * 100 : 0;
    return (
      <div className="flex items-center gap-3 text-xs">
        <span className="w-20 text-gray-400 truncate shrink-0">{label}</span>
        <div className="flex-1 bg-gray-800 rounded-full h-1.5 overflow-hidden">
          <div
            className={`h-full rounded-full ${colorClass}`}
            style={{ width: `${pct.toFixed(1)}%` }}
          />
        </div>
        <span className="text-gray-300 w-10 text-right">{pct.toFixed(0)}%</span>
        <span className="text-gray-500 w-16 text-right">${(spend / 1000).toFixed(1)}k</span>
      </div>
    );
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
      <div className="bg-[#111118] border border-gray-800 rounded-2xl p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
          Spend by Format
        </h3>
        <div className="flex flex-col gap-3">
          {byFormat.map(([fmt, spend]) => (
            <BarRow
              key={fmt}
              label={fmt}
              spend={spend}
              colorClass={formatColors[fmt] ?? "bg-gray-500"}
            />
          ))}
        </div>
      </div>
      <div className="bg-[#111118] border border-gray-800 rounded-2xl p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
          Spend by Status
        </h3>
        <div className="flex flex-col gap-3">
          {byStatus.map(([status, spend]) => (
            <BarRow
              key={status}
              label={status}
              spend={spend}
              colorClass={statusColors[status] ?? "bg-gray-500"}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Spend Sparkline ────────────────────────────────────────────────────────────

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function SpendSparkline({
  creatives,
}: {
  creatives: Array<{ spend: number; trend: DayMetric[] }>;
}) {
  const dailySpend = useMemo(() => {
    const totals = Array(7).fill(0) as number[];
    for (const c of creatives) {
      c.trend.forEach((d, i) => {
        if (i < 7) totals[i] += d.spend;
      });
    }
    return totals;
  }, [creatives]);

  const total = dailySpend.reduce((s, v) => s + v, 0);
  if (total === 0) return null;

  const max = Math.max(...dailySpend);
  const min = Math.min(...dailySpend);
  const range = max - min || 1;

  const W = 600;
  const H = 140;
  const padL = 44;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const n = dailySpend.length;

  const xOf = (i: number) => padL + (i / (n - 1)) * chartW;
  const yOf = (v: number) => padT + chartH - ((v - min) / range) * chartH;

  const points = dailySpend.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`);
  const polyline = points.join(" ");
  const areaPath =
    `M${xOf(0).toFixed(1)},${(padT + chartH).toFixed(1)} ` +
    points.map((p) => `L${p}`).join(" ") +
    ` L${xOf(n - 1).toFixed(1)},${(padT + chartH).toFixed(1)} Z`;

  const peakIdx = dailySpend.indexOf(max);

  const yLabels = [
    { v: max, y: yOf(max) },
    { v: (max + min) / 2, y: yOf((max + min) / 2) },
    { v: min, y: yOf(min) },
  ];

  return (
    <div className="bg-[#111118] border border-gray-800 rounded-2xl p-5 mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-violet-400" />
          <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
            Daily Spend Trend
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Peak:</span>
          <span className="text-xs font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
            {DAY_LABELS[peakIdx]} — ${(max / 1000).toFixed(1)}k
          </span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: 140 }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="sparkline-fill-w" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#7c3aed" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {yLabels.map(({ y }, i) => (
          <line
            key={i}
            x1={padL}
            y1={y.toFixed(1)}
            x2={W - padR}
            y2={y.toFixed(1)}
            stroke="#374151"
            strokeWidth="0.5"
            strokeDasharray="4 4"
          />
        ))}
        {yLabels.map(({ v, y }, i) => (
          <text
            key={i}
            x={padL - 6}
            y={(y + 4).toFixed(1)}
            textAnchor="end"
            fontSize="9"
            fill="#6b7280"
          >
            ${(v / 1000).toFixed(1)}k
          </text>
        ))}
        <path d={areaPath} fill="url(#sparkline-fill-w)" />
        <polyline
          points={polyline}
          fill="none"
          stroke="#7c3aed"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {dailySpend.map((v, i) => (
          <circle
            key={i}
            cx={xOf(i).toFixed(1)}
            cy={yOf(v).toFixed(1)}
            r={i === peakIdx ? "5" : "3"}
            fill={i === peakIdx ? "#10b981" : "#7c3aed"}
            stroke="#0a0a0f"
            strokeWidth="1.5"
          />
        ))}
        {DAY_LABELS.map((label, i) => (
          <text
            key={i}
            x={xOf(i).toFixed(1)}
            y={(padT + chartH + 16).toFixed(1)}
            textAnchor="middle"
            fontSize="9"
            fill={i === peakIdx ? "#10b981" : "#6b7280"}
            fontWeight={i === peakIdx ? "700" : "400"}
          >
            {label}
          </text>
        ))}
      </svg>
    </div>
  );
}

// ── AI Insights ───────────────────────────────────────────────────────────────

type InsightType = "success" | "warning" | "danger" | "info" | "neutral";

interface Insight {
  icon: React.ElementType;
  colorClass: string;
  bgClass: string;
  text: string;
  type: InsightType;
}

function AiInsights({
  creatives,
  totals,
}: {
  creatives: Array<{
    spend: number;
    roas: number;
    format?: string | null;
    status: string;
    impressions?: number | null;
    clicks?: number | null;
  }>;
  totals: { spend: number; impressions: number; clicks: number; ctr: number };
}) {
  const insights = useMemo<Insight[]>(() => {
    if (!creatives.length || totals.spend === 0) return [];
    const list: Insight[] = [];

    // 1. Best format by spend-weighted ROAS
    const formatMap: Record<string, { totalRoasWeighted: number; spend: number }> = {};
    for (const c of creatives) {
      const key = c.format ?? "Other";
      if (!formatMap[key]) formatMap[key] = { totalRoasWeighted: 0, spend: 0 };
      formatMap[key].totalRoasWeighted += c.roas * c.spend;
      formatMap[key].spend += c.spend;
    }
    const formats = Object.entries(formatMap)
      .map(([fmtKey, v]) => ({ fmt: fmtKey, avgRoas: v.spend > 0 ? v.totalRoasWeighted / v.spend : 0, spend: v.spend }))
      .filter((f) => f.spend > 0)
      .sort((a, b) => b.avgRoas - a.avgRoas);
    if (formats.length > 0) {
      const best = formats[0];
      const pct = Math.round((best.spend / totals.spend) * 100);
      list.push({
        icon: TrendingUp,
        colorClass: "text-emerald-400",
        bgClass: "bg-emerald-500/15",
        text: `${best.fmt} is your top format at ${best.avgRoas.toFixed(1)}× ROAS avg (${pct}% of spend)`,
        type: "success",
      });
    }

    // 2. Concentration risk — top creative >35% of spend
    const sorted = [...creatives].sort((a, b) => b.spend - a.spend);
    if (sorted.length > 0) {
      const topPct = (sorted[0].spend / totals.spend) * 100;
      if (topPct > 35) {
        list.push({
          icon: AlertTriangle,
          colorClass: "text-amber-400",
          bgClass: "bg-amber-500/10",
          text: `1 creative drives ${topPct.toFixed(0)}% of spend — consider diversifying your budget`,
          type: "warning",
        });
      }
    }

    // 3. CTR efficiency
    if (totals.impressions > 0 && totals.clicks > 0) {
      const ctr = totals.ctr;
      if (ctr >= 2) {
        list.push({
          icon: MousePointerClick,
          colorClass: "text-cyan-400",
          bgClass: "bg-cyan-500/10",
          text: `Strong click-through rate at ${ctr.toFixed(1)}% — your audience resonates with the creatives`,
          type: "success",
        });
      } else if (ctr < 1) {
        list.push({
          icon: MousePointerClick,
          colorClass: "text-orange-400",
          bgClass: "bg-orange-500/10",
          text: `CTR below 1% (${ctr.toFixed(2)}%) — test new hooks or angles to improve engagement`,
          type: "warning",
        });
      }
    }

    // 4. Fatigue rate
    const fatigued = creatives.filter((c) => c.status === "Fatigued");
    if (fatigued.length > 0) {
      const fatigueSpend = fatigued.reduce((s, c) => s + c.spend, 0);
      list.push({
        icon: AlertTriangle,
        colorClass: "text-red-400",
        bgClass: "bg-red-500/10",
        text: `${fatigued.length} creative${fatigued.length > 1 ? "s" : ""} fatigued, $${(fatigueSpend / 1000).toFixed(1)}k spend at risk — refresh soon`,
        type: "danger",
      });
    }

    // 5. Win rate (only if >5 creatives)
    if (creatives.length > 5) {
      const active = creatives.filter((c) => c.status === "Winner" || c.status === "Active").length;
      const rate = (active / creatives.length) * 100;
      if (rate >= 60) {
        list.push({
          icon: Target,
          colorClass: "text-violet-400",
          bgClass: "bg-violet-500/10",
          text: `Good portfolio health — ${active}/${creatives.length} creatives are winners or active`,
          type: "success",
        });
      } else if (rate < 30) {
        list.push({
          icon: Target,
          colorClass: "text-gray-400",
          bgClass: "bg-gray-500/10",
          text: `Only ${active}/${creatives.length} creatives are performing — audit your budget allocation`,
          type: "neutral",
        });
      }
    }

    return list.slice(0, 5);
  }, [creatives, totals]);

  if (!insights.length) return null;

  return (
    <div className="bg-[#0e0e16] border border-gray-800 rounded-2xl p-5 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="w-4 h-4 text-violet-400" />
        <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Smart Insights</h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {insights.map((insight, i) => (
          <div key={i} className={`flex items-start gap-2.5 rounded-xl p-3 ${insight.bgClass}`}>
            <div className={`mt-0.5 flex-shrink-0 ${insight.colorClass}`}>
              <insight.icon className="w-4 h-4" />
            </div>
            <p className="text-sm text-gray-200 leading-snug">{insight.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Sort types ─────────────────────────────────────────────────────────────────

type SortKey = "spend" | "impressions" | "cpm" | "ctr" | "cpc" | "cpa" | "roas" | "hookRate";
type SortDir = "asc" | "desc";

// ── Main page ─────────────────────────────────────────────────────────────────

export default function WeeklyPage() {
  const { creatives, isLoading, error, dateRange, setDatePreset, isRealData, wowData } =
    useCreativesContext();

  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [formatFilter, setFormatFilter] = useState<string>("all");

  const handleMount = () => {
    setDatePreset(7);
  };

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const metaCreatives = useMemo(
    () => creatives.filter((c) => c.platform === "Meta"),
    [creatives]
  );

  const totals = useMemo(() => {
    if (!metaCreatives.length)
      return { spend: 0, impressions: 0, clicks: 0, conversions: 0, cpm: 0, ctr: 0, cpa: 0, roas: 0 };

    const spend = metaCreatives.reduce((s, c) => s + c.spend, 0);
    const impressions = metaCreatives.reduce((s, c) => s + (c.impressions ?? 0), 0);
    const clicks = metaCreatives.reduce((s, c) => s + (c.clicks ?? 0), 0);
    const conversions = metaCreatives.reduce((s, c) => s + (c.conversions ?? 0), 0);
    const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
    const cpa = conversions > 0 ? spend / conversions : 0;
    const roas =
      spend > 0
        ? metaCreatives.reduce((s, c) => s + c.roas * c.spend, 0) / spend
        : 0;

    return { spend, impressions, clicks, conversions, cpm, ctr, cpa, roas };
  }, [metaCreatives]);

  const sortedBySpend = useMemo(
    () => [...metaCreatives].sort((a, b) => b.spend - a.spend),
    [metaCreatives]
  );

  // Sortable table data
  const sortedCreatives = useMemo(() => {
    return [...metaCreatives].sort((a, b) => {
      const impA = a.impressions ?? 0;
      const impB = b.impressions ?? 0;
      const clkA = a.clicks ?? 0;
      const clkB = b.clicks ?? 0;
      let valA: number;
      let valB: number;
      switch (sortKey) {
        case "spend": valA = a.spend; valB = b.spend; break;
        case "impressions": valA = impA; valB = impB; break;
        case "cpm": valA = impA > 0 ? (a.spend / impA) * 1000 : 0; valB = impB > 0 ? (b.spend / impB) * 1000 : 0; break;
        case "ctr": valA = impA > 0 ? (clkA / impA) * 100 : 0; valB = impB > 0 ? (clkB / impB) * 100 : 0; break;
        case "cpc": valA = clkA > 0 ? a.spend / clkA : 0; valB = clkB > 0 ? b.spend / clkB : 0; break;
        case "cpa": valA = a.cpa ?? 0; valB = b.cpa ?? 0; break;
        case "roas": valA = a.roas ?? 0; valB = b.roas ?? 0; break;
        case "hookRate": valA = a.hookRate ?? 0; valB = b.hookRate ?? 0; break;
        default: valA = a.spend; valB = b.spend;
      }
      return sortDir === "desc" ? valB - valA : valA - valB;
    });
  }, [metaCreatives, sortKey, sortDir]);

  // Filtered by search query + status + format
  const filteredCreatives = useMemo(() => {
    let result = sortedCreatives;
    if (statusFilter !== "all") {
      result = result.filter((c) => (c.status ?? "").toLowerCase() === statusFilter.toLowerCase());
    }
    if (formatFilter !== "all") {
      result = result.filter((c) => (c.format ?? "").toLowerCase().includes(formatFilter.toLowerCase()));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (c) => c.name.toLowerCase().includes(q) || (c.format ?? "").toLowerCase().includes(q)
      );
    }
    return result;
  }, [sortedCreatives, searchQuery, statusFilter, formatFilter]);

  // CSV export
  const exportCsv = () => {
    const header = ["Name", "Format", "Spend", "Impressions", "CPM", "CTR", "CPC", "CPA", "ROAS", "Hook Rate", "Status"];
    const rows = filteredCreatives.map((c) => {
      const imp = c.impressions ?? 0;
      const clk = c.clicks ?? 0;
      const cpm = imp > 0 ? (c.spend / imp) * 1000 : 0;
      const ctr = imp > 0 ? (clk / imp) * 100 : 0;
      const cpc = clk > 0 ? c.spend / clk : 0;
      return [
        `"${c.name.replace(/"/g, '""')}"`,
        c.format ?? "",
        c.spend.toFixed(2),
        imp,
        cpm.toFixed(2),
        ctr.toFixed(2),
        cpc.toFixed(2),
        (c.cpa ?? 0).toFixed(2),
        (c.roas ?? 0).toFixed(2),
        (c.hookRate ?? 0).toFixed(2),
        c.status,
      ].join(",");
    });
    const csv = [header.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `weekly-${dateRange.since}-${dateRange.until}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <span className="opacity-30 ml-1">↕</span>;
    return sortDir === "desc"
      ? <ArrowDown className="inline w-3 h-3 ml-1 text-violet-400" />
      : <ArrowUp className="inline w-3 h-3 ml-1 text-violet-400" />;
  };

  const thClass = (col: SortKey) =>
    `text-right px-4 py-3 font-medium cursor-pointer select-none hover:text-white transition-colors ${
      sortKey === col ? "text-violet-300" : ""
    }`;

  // Top 6 creatives for visual grid
  const topVisuals = useMemo(() => sortedBySpend.slice(0, 6), [sortedBySpend]);

  // Winners this week (top 3 by ROAS among actives)
  const winners = useMemo(
    () =>
      [...metaCreatives]
        .filter((c) => c.status === "Winner" || c.roas >= 3)
        .sort((a, b) => b.roas - a.roas)
        .slice(0, 3),
    [metaCreatives]
  );

  return (
    <div className="flex h-screen bg-[#0a0a0f] text-white overflow-hidden">
      <Sidebar />
      <div className="flex-1 overflow-y-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">Weekly Overview</h1>
            <p className="text-sm text-gray-400 mt-0.5">
              Meta Ads · {dateRange.since} → {dateRange.until}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                alert("Google Slides export coming soon — connect your Google account in Settings.");
              }}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded-lg font-medium transition-colors"
            >
              <Presentation className="w-3.5 h-3.5" />
              Générer Google Slide
            </button>
            <button
              onClick={handleMount}
              className="text-xs px-3 py-1.5 bg-violet-600 hover:bg-violet-500 rounded-lg font-medium transition-colors"
            >
              Reset to 7 days
            </button>
          </div>
        </div>

        {/* Status banners */}
        {!isRealData && (
          <div className="mb-4 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 text-xs text-amber-300">
            Using demo data — connect your Meta Ads account in Settings for real metrics.
          </div>
        )}
        {error && (
          <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-xs text-red-300">
            {error}
          </div>
        )}

        {/* KPI grid with WoW deltas */}
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 mb-6">
          <KpiCard
            label="Spend"
            value={fmtCurrency(totals.spend)}
            wowChange={wowData?.aggregateWow?.spendChange ?? null}
            icon={DollarSign}
            accent="bg-violet-600"
          />
          <KpiCard
            label="Impressions"
            value={totals.impressions > 0 ? (totals.impressions / 1000).toFixed(1) + "k" : "—"}
            icon={Eye}
            accent="bg-blue-600"
          />
          <KpiCard
            label="CPM"
            value={totals.cpm > 0 ? fmtCurrency(totals.cpm) : "—"}
            icon={BarChart3}
            accent="bg-indigo-600"
          />
          <KpiCard
            label="CTR"
            value={totals.ctr > 0 ? fmt(totals.ctr) + "%" : "—"}
            wowChange={wowData?.aggregateWow?.ctrChange ?? null}
            icon={MousePointerClick}
            accent="bg-cyan-600"
          />
          <KpiCard
            label="CPA"
            value={totals.cpa > 0 ? fmtCurrency(totals.cpa) : "—"}
            wowChange={
              wowData?.aggregateWow?.cpaChange != null ? -wowData.aggregateWow.cpaChange : null // CPA down = good
            }
            icon={ShoppingCart}
            accent="bg-pink-600"
          />
          <KpiCard
            label="ROAS"
            value={totals.roas > 0 ? fmt(totals.roas) + "×" : "—"}
            wowChange={wowData?.aggregateWow?.roasChange ?? null}
            icon={TrendingUp}
            accent="bg-emerald-600"
          />
          <KpiCard
            label="Conversions"
            value={totals.conversions > 0 ? totals.conversions.toLocaleString() : "—"}
            icon={Target}
            accent="bg-orange-600"
          />
        </div>

        {/* Daily Spend Sparkline */}
        <SpendSparkline creatives={metaCreatives} />

        {/* Spend Distribution */}
        <SpendBreakdown creatives={metaCreatives} />

        {/* AI Smart Insights */}
        <AiInsights creatives={metaCreatives} totals={totals} />

        {/* Winners spotlight */}
        {winners.length > 0 && (
          <div className="mb-6">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              🏆 Top Performers This Week
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {winners.map((c) => (
                <div
                  key={c.id}
                  className="bg-[#111118] border border-emerald-500/30 rounded-2xl p-4 flex gap-3 items-start"
                >
                  <div className="flex-shrink-0">
                    {c.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.thumbnailUrl}
                        alt={c.name}
                        className="w-10 h-10 rounded-lg object-cover"
                      />
                    ) : (
                      <div
                        className="w-10 h-10 rounded-lg"
                        style={{ backgroundColor: c.thumbnailColor ?? "#374151" }}
                      />
                    )}
                  </div>
                  <div className="flex flex-col gap-1 min-w-0">
                  <div className="font-semibold text-white truncate text-sm" title={c.name}>
                    {c.name}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-400">
                    <span className="text-emerald-400 font-bold text-base">
                      {fmt(c.roas)}× ROAS
                    </span>
                    <span>{fmtCurrency(c.spend)} spend</span>
                  </div>
                  <div className="flex gap-2 text-xs text-gray-500">
                    <span>CTR {fmt(c.ctr)}%</span>
                    <span>·</span>
                    <span>CPA {fmtCurrency(c.cpa)}</span>
                    {c.hookRate > 0 && (
                      <>
                        <span>·</span>
                        <span>Hook {fmt(c.hookRate)}%</span>
                      </>
                    )}
                  </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Data table */}
        <div className="bg-[#111118] border border-gray-800 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800 flex flex-wrap items-center gap-3 justify-between">
            <span className="text-sm font-semibold text-white">
              Adset Performance — {filteredCreatives.length}{filteredCreatives.length !== sortedCreatives.length ? ` / ${sortedCreatives.length}` : ""} creatives{statusFilter !== "all" ? ` · ${statusFilter}` : ""}{formatFilter !== "all" ? ` · ${formatFilter}` : ""}
            </span>
            <div className="flex items-center gap-2">
              <select
                value={formatFilter}
                onChange={(e) => setFormatFilter(e.target.value)}
                className="text-xs bg-[#1a1a24] border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200 focus:outline-none focus:border-violet-500 cursor-pointer"
              >
                <option value="all">All formats</option>
                <option value="Video">Video</option>
                <option value="Image">Image</option>
                <option value="Carousel">Carousel</option>
              </select>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="text-xs bg-[#1a1a24] border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200 focus:outline-none focus:border-violet-500 cursor-pointer"
              >
                <option value="all">All statuses</option>
                <option value="Winner">Winner</option>
                <option value="Active">Active</option>
                <option value="Fatigued">Fatigued</option>
                <option value="Paused">Paused</option>
              </select>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search creatives…"
                className="text-xs bg-[#1a1a24] border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 w-44"
              />
              <button
                onClick={exportCsv}
                disabled={filteredCreatives.length === 0}
                className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 rounded-lg font-medium transition-colors"
              >
                Export CSV
              </button>
              {isLoading && (
                <span className="text-xs text-gray-500 animate-pulse">Loading…</span>
              )}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-xs text-gray-500">
                  <th className="text-left px-5 py-3 font-medium">Creative</th>
                  <th className={thClass("spend")} onClick={() => handleSort("spend")}>Spend<SortIcon col="spend" /></th>
                  <th className={thClass("impressions")} onClick={() => handleSort("impressions")}>Impressions<SortIcon col="impressions" /></th>
                  <th className={thClass("cpm")} onClick={() => handleSort("cpm")}>CPM<SortIcon col="cpm" /></th>
                  <th className={thClass("ctr")} onClick={() => handleSort("ctr")}>CTR<SortIcon col="ctr" /></th>
                  <th className={thClass("cpc")} onClick={() => handleSort("cpc")}>CPC<SortIcon col="cpc" /></th>
                  <th className={thClass("cpa")} onClick={() => handleSort("cpa")}>CPA<SortIcon col="cpa" /></th>
                  <th className={thClass("roas")} onClick={() => handleSort("roas")}>ROAS<SortIcon col="roas" /></th>
                  <th className={thClass("hookRate")} onClick={() => handleSort("hookRate")}>Hook<SortIcon col="hookRate" /></th>
                  <th className="text-right px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredCreatives.length === 0 && !isLoading && (
                  <tr>
                    <td colSpan={10} className="text-center py-12 text-gray-600 text-xs">
                      {(searchQuery || statusFilter !== "all") ? "No creatives match your filters." : "No Meta creatives found for this date range."}
                    </td>
                  </tr>
                )}
                {filteredCreatives.map((c) => {
                  const impressions = c.impressions ?? 0;
                  const clicks = c.clicks ?? 0;
                  const cpm = impressions > 0 ? (c.spend / impressions) * 1000 : 0;
                  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
                  const cpc = clicks > 0 ? c.spend / clicks : 0;
                  const statusColor: Record<string, string> = {
                    Winner: "text-emerald-400",
                    Loser: "text-red-400",
                    Fatigued: "text-amber-400",
                    Active: "text-blue-400",
                  };
                  return (
                    <tr
                      key={c.id}
                      className="border-b border-gray-800/50 hover:bg-gray-800/20 transition-colors"
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          {c.thumbnailUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={c.thumbnailUrl}
                              alt={c.name}
                              className="w-8 h-8 rounded object-cover flex-shrink-0"
                            />
                          ) : (
                            <div
                              className="w-8 h-8 rounded flex-shrink-0"
                              style={{ backgroundColor: c.thumbnailColor ?? "#374151" }}
                            />
                          )}
                          <div>
                            <div className="font-medium text-white truncate max-w-[160px]" title={c.name}>
                              {c.name}
                            </div>
                            <div className="text-xs text-gray-500">{c.format}</div>
                          </div>
                        </div>
                      </td>
                      <td className="text-right px-4 py-3 text-gray-200">
                        {fmtCurrency(c.spend)}
                      </td>
                      <td className="text-right px-4 py-3 text-gray-400">
                        {impressions > 0 ? (impressions / 1000).toFixed(1) + "k" : "—"}
                      </td>
                      <td className="text-right px-4 py-3 text-gray-400">
                        {cpm > 0 ? fmtCurrency(cpm) : "—"}
                      </td>
                      <td className="text-right px-4 py-3 text-gray-400">
                        {ctr > 0 ? fmt(ctr) + "%" : "—"}
                      </td>
                      <td className="text-right px-4 py-3 text-gray-400">
                        {cpc > 0 ? fmtCurrency(cpc) : "—"}
                      </td>
                      <td className="text-right px-4 py-3 text-gray-400">
                        {c.cpa > 0 ? fmtCurrency(c.cpa) : "—"}
                      </td>
                      <td className="text-right px-4 py-3 font-semibold text-white">
                        {c.roas > 0 ? fmt(c.roas) + "×" : "—"}
                      </td>
                      <td className="text-right px-4 py-3 text-gray-400">
                        {c.hookRate > 0 ? fmt(c.hookRate) + "%" : "—"}
                      </td>
                      <td
                        className={`text-right px-5 py-3 text-xs font-medium ${
                          statusColor[c.status] ?? "text-gray-400"
                        }`}
                      >
                        {c.status}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {filteredCreatives.length > 0 && (() => {
                const fSpend = filteredCreatives.reduce((s, c) => s + c.spend, 0);
                const fImp = filteredCreatives.reduce((s, c) => s + (c.impressions ?? 0), 0);
                const fClk = filteredCreatives.reduce((s, c) => s + (c.clicks ?? 0), 0);
                const fConv = filteredCreatives.reduce((s, c) => s + (c.conversions ?? 0), 0);
                const fCpm = fImp > 0 ? (fSpend / fImp) * 1000 : 0;
                const fCtr = fImp > 0 ? (fClk / fImp) * 100 : 0;
                const fCpc = fClk > 0 ? fSpend / fClk : 0;
                const fCpa = fConv > 0 ? fSpend / fConv : 0;
                const fRoas = fSpend > 0 ? filteredCreatives.reduce((s, c) => s + c.roas * c.spend, 0) / fSpend : 0;
                const fHook = filteredCreatives.filter((c) => c.hookRate > 0).length > 0
                  ? filteredCreatives.reduce((s, c) => s + (c.hookRate ?? 0), 0) / filteredCreatives.filter((c) => c.hookRate > 0).length
                  : 0;
                return (
                  <tfoot>
                    <tr className="border-t-2 border-gray-700 bg-gray-900/40 text-xs font-semibold">
                      <td className="px-5 py-3 text-gray-300">Totals / Avg</td>
                      <td className="text-right px-4 py-3 text-white">{fmtCurrency(fSpend)}</td>
                      <td className="text-right px-4 py-3 text-gray-300">{fImp > 0 ? (fImp / 1000).toFixed(1) + "k" : "—"}</td>
                      <td className="text-right px-4 py-3 text-gray-300">{fCpm > 0 ? fmtCurrency(fCpm) : "—"}</td>
                      <td className="text-right px-4 py-3 text-gray-300">{fCtr > 0 ? fmt(fCtr) + "%" : "—"}</td>
                      <td className="text-right px-4 py-3 text-gray-300">{fCpc > 0 ? fmtCurrency(fCpc) : "—"}</td>
                      <td className="text-right px-4 py-3 text-gray-300">{fCpa > 0 ? fmtCurrency(fCpa) : "—"}</td>
                      <td className="text-right px-4 py-3 text-violet-300">{fRoas > 0 ? fmt(fRoas) + "×" : "—"}</td>
                      <td className="text-right px-4 py-3 text-gray-300">{fHook > 0 ? fmt(fHook) + "%" : "—"}</td>
                      <td />
                    </tr>
                  </tfoot>
                );
              })()}
            </table>
          </div>
        </div>

        {/* Creative Visuals Grid */}
        {topVisuals.length > 0 && (
          <div className="mt-6">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Top Creatives — Visual Preview
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {topVisuals.map((c) => {
                const impressions = c.impressions ?? 0;
                const clicks = c.clicks ?? 0;
                const cpm = impressions > 0 ? (c.spend / impressions) * 1000 : 0;
                const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
                const cpc = clicks > 0 ? c.spend / clicks : 0;
                return (
                  <div
                    key={c.id}
                    className="bg-[#111118] border border-gray-800 rounded-2xl overflow-hidden"
                  >
                    <CreativeThumbnail
                      format={c.format}
                      thumbnailColor={c.thumbnailColor}
                      thumbnailUrl={c.thumbnailUrl}
                      videoUrl={c.videoUrl}
                      videoId={c.videoId}
                      className="h-44"
                    />
                    <div className="p-4">
                      <div className="font-medium text-white text-sm truncate mb-2" title={c.name}>
                        {c.name}
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <span className="text-gray-500">Spend</span>
                          <div className="text-gray-200 font-medium">{fmtCurrency(c.spend)}</div>
                        </div>
                        <div>
                          <span className="text-gray-500">ROAS</span>
                          <div className="text-white font-bold">{c.roas > 0 ? fmt(c.roas) + "×" : "—"}</div>
                        </div>
                        <div>
                          <span className="text-gray-500">CPA</span>
                          <div className="text-gray-200 font-medium">{c.cpa > 0 ? fmtCurrency(c.cpa) : "—"}</div>
                        </div>
                        <div>
                          <span className="text-gray-500">CPM</span>
                          <div className="text-gray-400">{cpm > 0 ? fmtCurrency(cpm) : "—"}</div>
                        </div>
                        <div>
                          <span className="text-gray-500">CTR</span>
                          <div className="text-gray-400">{ctr > 0 ? fmt(ctr) + "%" : "—"}</div>
                        </div>
                        <div>
                          <span className="text-gray-500">CPC</span>
                          <div className="text-gray-400">{cpc > 0 ? fmtCurrency(cpc) : "—"}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
