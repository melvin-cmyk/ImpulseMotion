"use client";

import { useState, useEffect, useMemo } from "react";
import { Creative, Format } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import { CreativeThumbnail } from "@/components/creative-thumbnail";
import { CreativeModal } from "@/components/creative-modal";
import { DateRangePicker } from "@/components/date-range-picker";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { ArrowRight, TrendingUp, TrendingDown, Minus, CalendarDays, Loader2, LayoutGrid } from "lucide-react";

interface Metric {
  key: keyof Creative;
  label: string;
  format: (v: number) => string;
  higherIsBetter: boolean;
  chartScale?: number;
}

const METRICS: Metric[] = [
  {
    key: "spend",
    label: "Spend",
    format: (v) => `$${(v / 1000).toFixed(1)}k`,
    higherIsBetter: true,
  },
  {
    key: "roas",
    label: "ROAS",
    format: (v) => `${v}x`,
    higherIsBetter: true,
  },
  {
    key: "cpa",
    label: "CPA",
    format: (v) => `$${v}`,
    higherIsBetter: false,
  },
  {
    key: "ctr",
    label: "CTR",
    format: (v) => `${v}%`,
    higherIsBetter: true,
  },
  {
    key: "hookRate",
    label: "Hook Rate",
    format: (v) => (v > 0 ? `${v}%` : "—"),
    higherIsBetter: true,
  },
  {
    key: "holdRate",
    label: "Hold Rate",
    format: (v) => (v > 0 ? `${v}%` : "—"),
    higherIsBetter: true,
  },
];

function PlatformBadge({ platform }: { platform: string }) {
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

function CreativeCard({ creative, onThumbClick }: { creative: Creative; onThumbClick?: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="w-12 h-12 rounded-xl overflow-hidden shrink-0 cursor-pointer hover:ring-2 hover:ring-violet-500 transition-all"
        onClick={onThumbClick}
        title="Click to view details"
      >
        <CreativeThumbnail
          format={creative.format}
          thumbnailColor={creative.thumbnailColor}
          thumbnailUrl={creative.thumbnailUrl}
          videoUrl={creative.videoUrl}
          videoId={creative.videoId}
          className="w-12 h-12"
        />
      </div>
      <div>
        <p className="text-sm font-mono text-gray-100 truncate max-w-[180px]">
          {creative.name}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <PlatformBadge platform={creative.platform} />
          <span className="text-[10px] text-gray-500 uppercase">{creative.format}</span>
        </div>
      </div>
    </div>
  );
}

function WinnerIcon({
  winner,
}: {
  winner: "a" | "b" | "tie";
}) {
  if (winner === "tie")
    return <Minus className="w-4 h-4 text-gray-500" />;
  if (winner === "a")
    return <TrendingUp className="w-4 h-4 text-emerald-400" />;
  return <TrendingUp className="w-4 h-4 text-violet-400" />;
}

// ── Creative Type Comparison ──────────────────────────────────────────────────

interface TypeAgg {
  format: Format;
  count: number;
  spend: number;
  ctr: number;
  hookRate: number;
  roas: number;
}

const FORMAT_COLORS: Record<Format, string> = {
  Video: "#7c3aed",
  Image: "#0ea5e9",
  Carousel: "#10b981",
};

function CreativeTypeComparison({ creatives }: { creatives: Creative[] }) {
  const typeData: TypeAgg[] = useMemo(() => {
    const groups: Record<Format, Creative[]> = { Video: [], Image: [], Carousel: [] };
    creatives.forEach((c) => {
      if (groups[c.format]) groups[c.format].push(c);
    });

    return (["Video", "Image", "Carousel"] as Format[]).map((format) => {
      const list = groups[format];
      if (list.length === 0) {
        return { format, count: 0, spend: 0, ctr: 0, hookRate: 0, roas: 0 };
      }
      const spend = list.reduce((s, c) => s + c.spend, 0);
      const ctr = list.reduce((s, c) => s + c.ctr, 0) / list.length;
      const videoList = list.filter((c) => c.hookRate > 0);
      const hookRate =
        videoList.length > 0
          ? videoList.reduce((s, c) => s + c.hookRate, 0) / videoList.length
          : 0;
      const roas = list.reduce((s, c) => s + c.roas, 0) / list.length;
      return { format, count: list.length, spend, ctr, hookRate, roas };
    });
  }, [creatives]);

  const maxSpend = Math.max(...typeData.map((d) => d.spend), 1);
  const maxCtr = Math.max(...typeData.map((d) => d.ctr), 1);
  const maxRoas = Math.max(...typeData.map((d) => d.roas), 1);
  const maxHookRate = Math.max(...typeData.map((d) => d.hookRate), 1);

  const chartData = typeData
    .filter((d) => d.count > 0)
    .map((d) => ({
      format: d.format,
      Spend: Math.round(d.spend / 1000 * 10) / 10,
      CTR: Math.round(d.ctr * 100) / 100,
      "Hook Rate": Math.round(d.hookRate * 10) / 10,
      ROAS: Math.round(d.roas * 100) / 100,
    }));

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
        <div className="w-8 h-8 rounded-xl bg-violet-500/20 flex items-center justify-center">
          <LayoutGrid className="w-4 h-4 text-violet-400" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-200">Creative Type Comparison</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Images vs Videos vs Carousels — aggregated metrics
          </p>
        </div>
      </div>

      {/* Metric rows (horizontal bar charts) */}
      <div className="p-5 space-y-5">
        {(
          [
            {
              label: "Avg ROAS",
              key: "roas" as keyof TypeAgg,
              max: maxRoas,
              format: (v: number) => `${v.toFixed(2)}x`,
              accent: "bg-violet-500",
            },
            {
              label: "Avg CTR",
              key: "ctr" as keyof TypeAgg,
              max: maxCtr,
              format: (v: number) => `${v.toFixed(2)}%`,
              accent: "bg-blue-500",
            },
            {
              label: "Avg Hook Rate",
              key: "hookRate" as keyof TypeAgg,
              max: maxHookRate,
              format: (v: number) => (v > 0 ? `${v.toFixed(1)}%` : "—"),
              accent: "bg-pink-500",
            },
            {
              label: "Total Spend",
              key: "spend" as keyof TypeAgg,
              max: maxSpend,
              format: (v: number) =>
                v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`,
              accent: "bg-emerald-500",
            },
          ] as const
        ).map(({ label, key, max, format, accent }) => (
          <div key={label}>
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-2">
              {label}
            </p>
            <div className="space-y-2">
              {typeData
                .filter((d) => d.count > 0)
                .map((d) => {
                  const val = d[key] as number;
                  const pct = max > 0 ? (val / max) * 100 : 0;
                  return (
                    <div key={d.format} className="flex items-center gap-3">
                      <span className="text-xs text-gray-400 w-16 shrink-0">{d.format}</span>
                      <div className="flex-1 bg-gray-800 rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-2 rounded-full ${accent} transition-all duration-500`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs font-semibold text-gray-300 w-14 text-right shrink-0">
                        {format(val)}
                      </span>
                      <span className="text-[10px] text-gray-600 w-8 shrink-0">
                        ({d.count})
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        ))}
      </div>

      {/* Bar chart */}
      <div className="px-5 pb-5">
        <p className="text-xs text-gray-500 mb-3 uppercase tracking-wide font-medium">
          Overview chart (Spend in $k, rates in %)
        </p>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 0, right: 16, left: 0, bottom: 0 }}
            barCategoryGap="30%"
            barGap={3}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fill: "#9ca3af", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="format"
              tick={{ fill: "#9ca3af", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={60}
            />
            <Tooltip
              contentStyle={{
                background: "#111827",
                border: "1px solid #374151",
                borderRadius: "8px",
                fontSize: "12px",
                color: "#e5e7eb",
              }}
            />
            <Legend wrapperStyle={{ fontSize: "11px", color: "#9ca3af" }} />
            <Bar dataKey="ROAS" fill="#7c3aed" radius={[0, 4, 4, 0]} />
            <Bar dataKey="CTR" fill="#0ea5e9" radius={[0, 4, 4, 0]} />
            <Bar dataKey="Hook Rate" fill="#ec4899" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Week-over-Week types & helpers ────────────────────────────────────────────

interface WowMetricRow {
  label: string;
  key: string;
  thisWeek: number;
  lastWeek: number;
  higherIsBetter: boolean;
  format: (v: number) => string;
}

interface WowData {
  spend: number;
  ctr: number;
  cpm: number;
  cpc: number;
  roas: number;
}

/** Aggregate WoW metrics from a list of Creative objects */
function aggregateWow(creatives: Creative[]): WowData {
  if (creatives.length === 0) {
    return { spend: 0, ctr: 0, cpm: 0, cpc: 0, roas: 0 };
  }
  const total = creatives.length;
  const spend = creatives.reduce((s, c) => s + c.spend, 0);
  const ctr = creatives.reduce((s, c) => s + c.ctr, 0) / total;
  // CPM = (spend / impressions) * 1000
  const totalImpressions = creatives.reduce((s, c) => s + c.impressions, 0);
  const cpm = totalImpressions > 0 ? (spend / totalImpressions) * 1000 : 0;
  // CPC = spend / clicks
  const totalClicks = creatives.reduce((s, c) => s + c.clicks, 0);
  const cpc = totalClicks > 0 ? spend / totalClicks : 0;
  const roas = creatives.reduce((s, c) => s + c.roas, 0) / total;
  return { spend, ctr, cpm, cpc, roas };
}

/** Build YYYY-MM-DD offset from today */
function isoOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function ChangePill({ change, higherIsBetter }: { change: number; higherIsBetter: boolean }) {
  if (!isFinite(change) || change === 0) {
    return <span className="text-gray-500 text-sm font-medium">—</span>;
  }
  const improved =
    (higherIsBetter && change > 0) || (!higherIsBetter && change < 0);
  const abs = Math.abs(change);
  return (
    <span
      className={`inline-flex items-center gap-1 text-sm font-semibold ${
        improved ? "text-emerald-400" : "text-red-400"
      }`}
    >
      {improved ? (
        <TrendingUp className="w-3.5 h-3.5" />
      ) : (
        <TrendingDown className="w-3.5 h-3.5" />
      )}
      {change > 0 ? "+" : ""}
      {abs.toFixed(1)}%
    </span>
  );
}

function WowSection() {
  const { creatives, isRealData } = useCreativesContext();

  // Fetch this-week and last-week data independently when real data is available
  const [metaAccountId, setMetaAccountId] = useState<string | null>(null);
  const [thisWeekData, setThisWeekData] = useState<WowData | null>(null);
  const [lastWeekData, setLastWeekData] = useState<WowData | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem("impulse_meta_account");
        if (raw) setMetaAccountId(JSON.parse(raw).accountId ?? null);
      } catch {}
    }
  }, []);

  useEffect(() => {
    if (!isRealData || !metaAccountId) {
      // Derive WoW from mock creatives by splitting the trend data
      // Use the existing creatives array split by half as a proxy
      const half = Math.floor(creatives.length / 2);
      setThisWeekData(aggregateWow(creatives.slice(0, half || creatives.length)));
      setLastWeekData(aggregateWow(creatives.slice(half)));
      return;
    }

    async function fetchWow() {
      setLoading(true);
      setFetchError(null);
      try {
        const thisWeekSince = isoOffset(-7);
        const thisWeekUntil = isoOffset(0);
        const lastWeekSince = isoOffset(-14);
        const lastWeekUntil = isoOffset(-7);

        const [thisRes, lastRes] = await Promise.all([
          fetch(
            `/api/meta/creatives?accountId=${encodeURIComponent(metaAccountId!)}&since=${thisWeekSince}&until=${thisWeekUntil}`
          ).then((r) => r.json()),
          fetch(
            `/api/meta/creatives?accountId=${encodeURIComponent(metaAccountId!)}&since=${lastWeekSince}&until=${lastWeekUntil}`
          ).then((r) => r.json()),
        ]);

        if (Array.isArray(thisRes)) setThisWeekData(aggregateWow(thisRes));
        if (Array.isArray(lastRes)) setLastWeekData(aggregateWow(lastRes));
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : "Failed to load WoW data");
      } finally {
        setLoading(false);
      }
    }

    fetchWow();
  }, [isRealData, metaAccountId, creatives]);

  // Build metric rows
  const rows: WowMetricRow[] = useMemo(() => {
    if (!thisWeekData || !lastWeekData) return [];

    return (["spend", "ctr", "cpm", "cpc", "roas"] as const).map((k) => {
      const tw = thisWeekData[k];
      const lw = lastWeekData[k];
      return {
        key: k,
        label:
          k === "spend"
            ? "Spend"
            : k === "ctr"
            ? "CTR"
            : k === "cpm"
            ? "CPM"
            : k === "cpc"
            ? "CPC"
            : "ROAS",
        thisWeek: tw,
        lastWeek: lw,
        higherIsBetter: k === "roas" || k === "ctr",
        format:
          k === "spend"
            ? (v: number) =>
                `$${v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(0)}`
            : k === "ctr"
            ? (v: number) => `${v.toFixed(2)}%`
            : k === "cpm" || k === "cpc"
            ? (v: number) => `$${v.toFixed(2)}`
            : (v: number) => `${v.toFixed(2)}x`,
      };
    });
  }, [thisWeekData, lastWeekData]);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
        <div className="w-8 h-8 rounded-xl bg-violet-500/20 flex items-center justify-center">
          <CalendarDays className="w-4 h-4 text-violet-400" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-200">Week over Week</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            This week (last 7 days) vs previous week (7–14 days ago)
          </p>
        </div>
        {loading && (
          <Loader2 className="w-4 h-4 text-gray-500 animate-spin ml-auto" />
        )}
      </div>

      {fetchError && (
        <div className="px-5 py-3 text-xs text-red-400 bg-red-900/10 border-b border-gray-800">
          {fetchError}
        </div>
      )}

      {/* Table header */}
      <div className="grid grid-cols-[1fr_120px_120px_100px] border-b border-gray-800 bg-gray-900/80">
        <div className="px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Metric
        </div>
        <div className="px-4 py-2.5 text-xs font-semibold text-violet-400 uppercase tracking-wide text-center">
          This Week
        </div>
        <div className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center">
          Last Week
        </div>
        <div className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center">
          Change
        </div>
      </div>

      {/* Rows */}
      {rows.map((row, i) => {
        const change =
          row.lastWeek !== 0
            ? ((row.thisWeek - row.lastWeek) / Math.abs(row.lastWeek)) * 100
            : 0;
        const improved =
          (row.higherIsBetter && change > 0) ||
          (!row.higherIsBetter && change < 0);
        return (
          <div
            key={row.key}
            className={`grid grid-cols-[1fr_120px_120px_100px] ${
              i < rows.length - 1 ? "border-b border-gray-800/70" : ""
            }`}
          >
            <div className="px-5 py-4 flex items-center">
              <span className="text-sm text-gray-400 font-medium">{row.label}</span>
            </div>
            <div
              className={`px-4 py-4 flex items-center justify-center ${
                improved && change !== 0 ? "bg-violet-950/20" : ""
              }`}
            >
              <span className="text-sm font-bold text-gray-100">
                {row.format(row.thisWeek)}
              </span>
            </div>
            <div className="px-4 py-4 flex items-center justify-center">
              <span className="text-sm text-gray-500">
                {row.format(row.lastWeek)}
              </span>
            </div>
            <div className="px-4 py-4 flex items-center justify-center">
              <ChangePill change={change} higherIsBetter={row.higherIsBetter} />
            </div>
          </div>
        );
      })}

      {rows.length === 0 && !loading && (
        <div className="px-5 py-8 text-center text-gray-600 text-sm">
          No data available
        </div>
      )}
    </div>
  );
}

export default function ComparePage() {
  const { creatives } = useCreativesContext();
  const [idA, setIdA] = useState<string>("");
  const [idB, setIdB] = useState<string>("");
  const [selectedCreative, setSelectedCreative] = useState<Creative | null>(null);

  const effectiveIdA = idA || (creatives[0]?.id ?? "");
  const effectiveIdB = idB || (creatives[1]?.id ?? "");

  const creativeA = creatives.find((c) => c.id === effectiveIdA) ?? creatives[0];
  const creativeB = creatives.find((c) => c.id === effectiveIdB) ?? creatives[1];

  if (!creativeA || !creativeB) {
    return (
      <div className="p-6 flex items-center justify-center h-48 text-gray-600">
        Loading creatives…
      </div>
    );
  }

  function getWinner(
    a: number,
    b: number,
    higherIsBetter: boolean
  ): "a" | "b" | "tie" {
    if (a === b || (a === 0 && b === 0)) return "tie";
    if (higherIsBetter) return a > b ? "a" : "b";
    return a < b ? "a" : "b";
  }

  // Count wins
  let winsA = 0;
  let winsB = 0;
  METRICS.forEach((m) => {
    const va = creativeA[m.key] as number;
    const vb = creativeB[m.key] as number;
    if (va === 0 && vb === 0) return;
    const w = getWinner(va, vb, m.higherIsBetter);
    if (w === "a") winsA++;
    else if (w === "b") winsB++;
  });

  const overallWinner: "a" | "b" | "tie" =
    winsA > winsB ? "a" : winsB > winsA ? "b" : "tie";

  // Chart data — normalise spend for readability
  const chartData = METRICS.map((m) => ({
    name: m.label,
    [creativeA.name.slice(0, 12)]: creativeA[m.key] as number,
    [creativeB.name.slice(0, 12)]: creativeB[m.key] as number,
  }));

  const aName = creativeA.name.slice(0, 12);
  const bName = creativeB.name.slice(0, 12);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">A/B Comparison</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          Select two creatives to compare head-to-head
        </p>
      </div>

      {/* Date Range Picker */}
      <DateRangePicker />

      {/* Selectors */}
      <div className="grid grid-cols-2 gap-4">
        {[
          {
            label: "Creative A",
            id: effectiveIdA,
            setId: setIdA,
            color: "border-violet-600",
            accent: "text-violet-400",
            creative: creativeA,
          },
          {
            label: "Creative B",
            id: effectiveIdB,
            setId: setIdB,
            color: "border-emerald-600",
            accent: "text-emerald-400",
            creative: creativeB,
          },
        ].map(({ label, id, setId, color, accent, creative: sel }) => (
          <div
            key={label}
            className={`bg-gray-900 border-2 ${color} rounded-2xl p-4 space-y-3`}
          >
            <div className="flex items-center justify-between">
              <p className={`text-xs font-bold uppercase tracking-widest ${accent}`}>
                {label}
              </p>
              <select
                value={id}
                onChange={(e) => setId(e.target.value)}
                className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded-lg px-2 py-1.5 outline-none cursor-pointer max-w-[220px]"
              >
                {creatives.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <CreativeCard creative={sel} onThumbClick={() => setSelectedCreative(sel)} />
          </div>
        ))}
      </div>

      {/* Overall Winner Banner */}
      {overallWinner !== "tie" && (
        <div
          className={`flex items-center gap-3 rounded-2xl px-5 py-4 ${
            overallWinner === "a"
              ? "bg-violet-950/50 border border-violet-700/60"
              : "bg-emerald-950/50 border border-emerald-700/60"
          }`}
        >
          <span className="text-2xl">🏆</span>
          <div>
            <p
              className={`font-bold ${
                overallWinner === "a" ? "text-violet-300" : "text-emerald-300"
              }`}
            >
              Creative {overallWinner.toUpperCase()} wins!
            </p>
            <p className="text-gray-400 text-xs mt-0.5">
              {overallWinner === "a" ? creativeA.name : creativeB.name} leads on{" "}
              {overallWinner === "a" ? winsA : winsB} of {METRICS.length} metrics.
            </p>
          </div>
          <div className="ml-auto flex gap-4">
            <div className="text-center">
              <p className="text-violet-400 font-bold text-lg">{winsA}</p>
              <p className="text-gray-500 text-xs">A wins</p>
            </div>
            <ArrowRight className="w-5 h-5 text-gray-600 self-center" />
            <div className="text-center">
              <p className="text-emerald-400 font-bold text-lg">{winsB}</p>
              <p className="text-gray-500 text-xs">B wins</p>
            </div>
          </div>
        </div>
      )}
      {overallWinner === "tie" && (
        <div className="flex items-center gap-3 rounded-2xl px-5 py-4 bg-gray-800/50 border border-gray-700">
          <span className="text-2xl">🤝</span>
          <p className="text-gray-300 font-medium">
            It&apos;s a tie — both creatives are evenly matched across metrics.
          </p>
        </div>
      )}

      {/* Head-to-Head Metric Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        <div className="grid grid-cols-[1fr_120px_40px_120px] gap-0 border-b border-gray-800">
          <div className="px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Metric
          </div>
          <div className="px-4 py-3 text-xs font-semibold text-violet-400 uppercase tracking-wide text-center">
            A — {creativeA.name.slice(0, 14)}
          </div>
          <div className="py-3 text-xs font-semibold text-gray-600 uppercase text-center">
            vs
          </div>
          <div className="px-4 py-3 text-xs font-semibold text-emerald-400 uppercase tracking-wide text-center">
            B — {creativeB.name.slice(0, 14)}
          </div>
        </div>

        {METRICS.map((m, i) => {
          const va = creativeA[m.key] as number;
          const vb = creativeB[m.key] as number;
          const winner = getWinner(va, vb, m.higherIsBetter);
          const skip = va === 0 && vb === 0;

          return (
            <div
              key={m.key}
              className={`grid grid-cols-[1fr_120px_40px_120px] gap-0 ${
                i < METRICS.length - 1 ? "border-b border-gray-800/70" : ""
              }`}
            >
              <div className="px-5 py-4 flex items-center">
                <span className="text-sm text-gray-400 font-medium">{m.label}</span>
              </div>
              {/* A */}
              <div
                className={`px-4 py-4 flex items-center justify-center ${
                  winner === "a" && !skip
                    ? "bg-violet-950/30"
                    : ""
                }`}
              >
                <span
                  className={`text-sm font-bold ${
                    skip
                      ? "text-gray-600"
                      : winner === "a"
                      ? "text-violet-300"
                      : winner === "tie"
                      ? "text-gray-400"
                      : "text-gray-500"
                  }`}
                >
                  {skip ? "—" : m.format(va)}
                </span>
                {winner === "a" && !skip && (
                  <TrendingUp className="w-3.5 h-3.5 text-violet-400 ml-1.5" />
                )}
              </div>
              {/* VS */}
              <div className="py-4 flex items-center justify-center">
                <WinnerIcon winner={winner} />
              </div>
              {/* B */}
              <div
                className={`px-4 py-4 flex items-center justify-center ${
                  winner === "b" && !skip ? "bg-emerald-950/30" : ""
                }`}
              >
                {winner === "b" && !skip && (
                  <TrendingUp className="w-3.5 h-3.5 text-emerald-400 mr-1.5" />
                )}
                <span
                  className={`text-sm font-bold ${
                    skip
                      ? "text-gray-600"
                      : winner === "b"
                      ? "text-emerald-300"
                      : winner === "tie"
                      ? "text-gray-400"
                      : "text-gray-500"
                  }`}
                >
                  {skip ? "—" : m.format(vb)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bar Chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-300 mb-4">
          Visual Comparison
        </h2>
        <p className="text-xs text-gray-500 mb-4">
          Note: Spend is shown in $k, CPA in $, rates as percentages. Values are not
          normalised — use the table above for exact comparison.
        </p>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart
            data={chartData}
            margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
            barCategoryGap="30%"
            barGap={4}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis
              dataKey="name"
              tick={{ fill: "#9ca3af", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: "#9ca3af", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                background: "#111827",
                border: "1px solid #374151",
                borderRadius: "8px",
                fontSize: "12px",
                color: "#e5e7eb",
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: "12px", color: "#9ca3af" }}
            />
            <Bar dataKey={aName} fill="#7c3aed" radius={[4, 4, 0, 0]} />
            <Bar dataKey={bName} fill="#059669" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Creative Type Comparison */}
      <CreativeTypeComparison creatives={creatives} />

      {/* Week over Week Section */}
      <WowSection />

      {/* Creative Detail Modal */}
      <CreativeModal
        creative={selectedCreative}
        onClose={() => setSelectedCreative(null)}
      />
    </div>
  );
}
