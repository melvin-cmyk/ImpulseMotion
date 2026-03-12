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
import { TrendingUp, TrendingDown, Minus, CalendarDays, Loader2, LayoutGrid, Plus, X, Trophy } from "lucide-react";
import { MetricInfoButton } from "@/components/metric-info-button";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_CREATIVES = 5;

const SLOT_COLORS = [
  {
    label: "A",
    border: "border-violet-600",
    accent: "text-violet-400",
    fill: "#7c3aed",
    bg: "bg-violet-950/30",
    badgeBg: "bg-violet-900/60",
  },
  {
    label: "B",
    border: "border-emerald-600",
    accent: "text-emerald-400",
    fill: "#059669",
    bg: "bg-emerald-950/30",
    badgeBg: "bg-emerald-900/60",
  },
  {
    label: "C",
    border: "border-blue-600",
    accent: "text-blue-400",
    fill: "#2563eb",
    bg: "bg-blue-950/30",
    badgeBg: "bg-blue-900/60",
  },
  {
    label: "D",
    border: "border-orange-600",
    accent: "text-orange-400",
    fill: "#ea580c",
    bg: "bg-orange-950/30",
    badgeBg: "bg-orange-900/60",
  },
  {
    label: "E",
    border: "border-pink-600",
    accent: "text-pink-400",
    fill: "#db2777",
    bg: "bg-pink-950/30",
    badgeBg: "bg-pink-900/60",
  },
];

interface Metric {
  key: keyof Creative;
  label: string;
  format: (v: number) => string;
  higherIsBetter: boolean;
}

const METRICS: Metric[] = [
  { key: "spend", label: "Spend", format: (v) => `$${(v / 1000).toFixed(1)}k`, higherIsBetter: true },
  { key: "roas", label: "ROAS", format: (v) => `${v}x`, higherIsBetter: true },
  { key: "cpa", label: "CPA", format: (v) => `$${v}`, higherIsBetter: false },
  { key: "ctr", label: "CTR", format: (v) => `${v}%`, higherIsBetter: true },
  { key: "hookRate", label: "Hook Rate", format: (v) => (v > 0 ? `${v}%` : "—"), higherIsBetter: true },
  { key: "holdRate", label: "Hold Rate", format: (v) => (v > 0 ? `${v}%` : "—"), higherIsBetter: true },
];

// ── Sub-components ────────────────────────────────────────────────────────────

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
        <p className="text-sm font-mono text-gray-100 truncate max-w-[160px]">{creative.name}</p>
        <div className="flex items-center gap-2 mt-1">
          <PlatformBadge platform={creative.platform} />
          <span className="text-[10px] text-gray-500 uppercase">{creative.format}</span>
        </div>
      </div>
    </div>
  );
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
    creatives.forEach((c) => { if (groups[c.format]) groups[c.format].push(c); });

    return (["Video", "Image", "Carousel"] as Format[]).map((format) => {
      const list = groups[format];
      if (list.length === 0) return { format, count: 0, spend: 0, ctr: 0, hookRate: 0, roas: 0 };
      const spend = list.reduce((s, c) => s + c.spend, 0);
      const ctr = list.reduce((s, c) => s + c.ctr, 0) / list.length;
      const videoList = list.filter((c) => c.hookRate > 0);
      const hookRate = videoList.length > 0 ? videoList.reduce((s, c) => s + c.hookRate, 0) / videoList.length : 0;
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
      Spend: Math.round((d.spend / 1000) * 10) / 10,
      CTR: Math.round(d.ctr * 100) / 100,
      "Hook Rate": Math.round(d.hookRate * 10) / 10,
      ROAS: Math.round(d.roas * 100) / 100,
    }));

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
        <div className="w-8 h-8 rounded-xl bg-violet-500/20 flex items-center justify-center">
          <LayoutGrid className="w-4 h-4 text-violet-400" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-200">Creative Type Comparison</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">Images vs Videos vs Carousels — aggregated metrics</p>
        </div>
      </div>

      <div className="p-5 space-y-5">
        {(
          [
            { label: "Avg ROAS", key: "roas" as keyof TypeAgg, max: maxRoas, format: (v: number) => `${v.toFixed(2)}x`, accent: "bg-violet-500" },
            { label: "Avg CTR", key: "ctr" as keyof TypeAgg, max: maxCtr, format: (v: number) => `${v.toFixed(2)}%`, accent: "bg-blue-500" },
            { label: "Avg Hook Rate", key: "hookRate" as keyof TypeAgg, max: maxHookRate, format: (v: number) => (v > 0 ? `${v.toFixed(1)}%` : "—"), accent: "bg-pink-500" },
            { label: "Total Spend", key: "spend" as keyof TypeAgg, max: maxSpend, format: (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`), accent: "bg-emerald-500" },
          ] as const
        ).map(({ label, key, max, format, accent }) => (
          <div key={label}>
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-2">{label}</p>
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
                        <div className={`h-2 rounded-full ${accent} transition-all duration-500`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs font-semibold text-gray-300 w-14 text-right shrink-0">{format(val)}</span>
                      <span className="text-[10px] text-gray-600 w-8 shrink-0">({d.count})</span>
                    </div>
                  );
                })}
            </div>
          </div>
        ))}
      </div>

      <div className="px-5 pb-5">
        <p className="text-xs text-gray-500 mb-3 uppercase tracking-wide font-medium">Overview chart (Spend in $k, rates in %)</p>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} barCategoryGap="30%" barGap={3}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" horizontal={false} />
            <XAxis type="number" tick={{ fill: "#9ca3af", fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="format" tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} width={60} />
            <Tooltip contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: "8px", fontSize: "12px", color: "#e5e7eb" }} />
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

// ── Week-over-Week ─────────────────────────────────────────────────────────────

interface WowMetricRow {
  label: string;
  key: string;
  thisWeek: number;
  lastWeek: number;
  higherIsBetter: boolean;
  format: (v: number) => string;
}

interface WowData { spend: number; ctr: number; cpm: number; cpc: number; roas: number; }

function aggregateWow(creatives: Creative[]): WowData {
  if (creatives.length === 0) return { spend: 0, ctr: 0, cpm: 0, cpc: 0, roas: 0 };
  const total = creatives.length;
  const spend = creatives.reduce((s, c) => s + c.spend, 0);
  const ctr = creatives.reduce((s, c) => s + c.ctr, 0) / total;
  const totalImpressions = creatives.reduce((s, c) => s + c.impressions, 0);
  const cpm = totalImpressions > 0 ? (spend / totalImpressions) * 1000 : 0;
  const totalClicks = creatives.reduce((s, c) => s + c.clicks, 0);
  const cpc = totalClicks > 0 ? spend / totalClicks : 0;
  const roas = creatives.reduce((s, c) => s + c.roas, 0) / total;
  return { spend, ctr, cpm, cpc, roas };
}

function isoOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function ChangePill({ change, higherIsBetter }: { change: number; higherIsBetter: boolean }) {
  if (!isFinite(change) || change === 0) return <span className="text-gray-500 text-sm font-medium">—</span>;
  const improved = (higherIsBetter && change > 0) || (!higherIsBetter && change < 0);
  const abs = Math.abs(change);
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-semibold ${improved ? "text-emerald-400" : "text-red-400"}`}>
      {improved ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
      {change > 0 ? "+" : ""}{abs.toFixed(1)}%
    </span>
  );
}

function WowSection() {
  const { creatives, isRealData } = useCreativesContext();
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
      const half = Math.floor(creatives.length / 2);
      setThisWeekData(aggregateWow(creatives.slice(0, half || creatives.length)));
      setLastWeekData(aggregateWow(creatives.slice(half)));
      return;
    }
    async function fetchWow() {
      setLoading(true);
      setFetchError(null);
      try {
        const [thisRes, lastRes] = await Promise.all([
          fetch(`/api/meta/creatives?accountId=${encodeURIComponent(metaAccountId!)}&since=${isoOffset(-7)}&until=${isoOffset(0)}`).then((r) => r.json()),
          fetch(`/api/meta/creatives?accountId=${encodeURIComponent(metaAccountId!)}&since=${isoOffset(-14)}&until=${isoOffset(-7)}`).then((r) => r.json()),
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

  const rows: WowMetricRow[] = useMemo(() => {
    if (!thisWeekData || !lastWeekData) return [];
    return (["spend", "ctr", "cpm", "cpc", "roas"] as const).map((k) => ({
      key: k,
      label: k === "spend" ? "Spend" : k === "ctr" ? "CTR" : k === "cpm" ? "CPM" : k === "cpc" ? "CPC" : "ROAS",
      thisWeek: thisWeekData[k],
      lastWeek: lastWeekData[k],
      higherIsBetter: k === "roas" || k === "ctr",
      format:
        k === "spend" ? (v: number) => `$${v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(0)}`
        : k === "ctr" ? (v: number) => `${v.toFixed(2)}%`
        : k === "cpm" || k === "cpc" ? (v: number) => `$${v.toFixed(2)}`
        : (v: number) => `${v.toFixed(2)}x`,
    }));
  }, [thisWeekData, lastWeekData]);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
        <div className="w-8 h-8 rounded-xl bg-violet-500/20 flex items-center justify-center">
          <CalendarDays className="w-4 h-4 text-violet-400" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-200">Week over Week</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">This week (last 7 days) vs previous week (7–14 days ago)</p>
        </div>
        {loading && <Loader2 className="w-4 h-4 text-gray-500 animate-spin ml-auto" />}
      </div>

      {fetchError && (
        <div className="px-5 py-3 text-xs text-red-400 bg-red-900/10 border-b border-gray-800">{fetchError}</div>
      )}

      <div className="grid grid-cols-[1fr_120px_120px_100px] border-b border-gray-800 bg-gray-900/80">
        <div className="px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Metric</div>
        <div className="px-4 py-2.5 text-xs font-semibold text-violet-400 uppercase tracking-wide text-center">This Week</div>
        <div className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center">Last Week</div>
        <div className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center">Change</div>
      </div>

      {rows.map((row, i) => {
        const change = row.lastWeek !== 0 ? ((row.thisWeek - row.lastWeek) / Math.abs(row.lastWeek)) * 100 : 0;
        const improved = (row.higherIsBetter && change > 0) || (!row.higherIsBetter && change < 0);
        return (
          <div key={row.key} className={`grid grid-cols-[1fr_120px_120px_100px] ${i < rows.length - 1 ? "border-b border-gray-800/70" : ""}`}>
            <div className="px-5 py-4 flex items-center gap-1.5">
              <span className="text-sm text-gray-400 font-medium">{row.label}</span>
              <MetricInfoButton metricKey={row.key} />
            </div>
            <div className={`px-4 py-4 flex items-center justify-center ${improved && change !== 0 ? "bg-violet-950/20" : ""}`}>
              <span className="text-sm font-bold text-gray-100">{row.format(row.thisWeek)}</span>
            </div>
            <div className="px-4 py-4 flex items-center justify-center">
              <span className="text-sm text-gray-500">{row.format(row.lastWeek)}</span>
            </div>
            <div className="px-4 py-4 flex items-center justify-center">
              <ChangePill change={change} higherIsBetter={row.higherIsBetter} />
            </div>
          </div>
        );
      })}

      {rows.length === 0 && !loading && (
        <div className="px-5 py-8 text-center text-gray-600 text-sm">No data available</div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ComparePage() {
  const { creatives } = useCreativesContext();
  const [ids, setIds] = useState<string[]>(["", ""]);
  const [selectedCreative, setSelectedCreative] = useState<Creative | null>(null);

  // Resolve effective IDs (fallback to index-based default)
  const resolvedCreatives = useMemo(() => {
    return ids.map((id, idx) => {
      if (id) return creatives.find((c) => c.id === id) ?? creatives[idx] ?? null;
      return creatives[idx] ?? null;
    });
  }, [ids, creatives]);

  if (creatives.length < 2) {
    return (
      <div className="p-6 flex items-center justify-center h-48 text-gray-600">
        Loading creatives…
      </div>
    );
  }

  function setId(idx: number, id: string) {
    setIds((prev) => prev.map((v, i) => (i === idx ? id : v)));
  }

  function addSlot() {
    if (ids.length >= MAX_CREATIVES) return;
    setIds((prev) => [...prev, ""]);
  }

  function removeSlot(idx: number) {
    if (ids.length <= 2) return;
    setIds((prev) => prev.filter((_, i) => i !== idx));
  }

  // Compute wins per creative across all metrics
  const wins = useMemo(() => {
    const w = resolvedCreatives.map(() => 0);
    METRICS.forEach((m) => {
      const values = resolvedCreatives.map((c) => (c ? (c[m.key] as number) : 0));
      const allZero = values.every((v) => v === 0);
      if (allZero) return;
      const best = m.higherIsBetter ? Math.max(...values) : Math.min(...values);
      values.forEach((v, i) => { if (v === best && resolvedCreatives[i]) w[i]++; });
    });
    return w;
  }, [resolvedCreatives]);

  const overallWinnerIdx = useMemo(() => {
    const max = Math.max(...wins);
    if (max === 0) return -1;
    const topIdxs = wins.map((w, i) => (w === max ? i : -1)).filter((i) => i >= 0);
    return topIdxs.length === 1 ? topIdxs[0] : -1; // -1 = tie
  }, [wins]);

  // Chart data
  const chartData = METRICS.map((m) => {
    const row: Record<string, string | number> = { name: m.label };
    resolvedCreatives.forEach((c, idx) => {
      if (c) row[`${SLOT_COLORS[idx].label} — ${c.name.slice(0, 10)}`] = c[m.key] as number;
    });
    return row;
  });

  // Grid template for metric table
  const gridTemplate = `1fr ${resolvedCreatives.map(() => "minmax(100px, 140px)").join(" ")}`;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">A/B… Comparison</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          Compare jusqu&apos;à {MAX_CREATIVES} créatives côte à côte
        </p>
      </div>

      <DateRangePicker />

      {/* Creative Selectors */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {resolvedCreatives.map((sel, idx) => {
          const color = SLOT_COLORS[idx];
          const effectiveId = ids[idx] || sel?.id || "";
          return (
            <div key={idx} className={`bg-gray-900 border-2 ${color.border} rounded-2xl p-4 space-y-3 relative`}>
              {/* Remove button */}
              {ids.length > 2 && (
                <button
                  onClick={() => removeSlot(idx)}
                  className="absolute top-3 right-3 w-6 h-6 flex items-center justify-center rounded-full bg-gray-800 hover:bg-gray-700 text-gray-500 hover:text-gray-200 transition-colors"
                  title="Retirer cette créa"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              <div className="flex items-center justify-between pr-8">
                <p className={`text-xs font-bold uppercase tracking-widest ${color.accent}`}>
                  Créa {color.label}
                </p>
                <select
                  value={effectiveId}
                  onChange={(e) => setId(idx, e.target.value)}
                  className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded-lg px-2 py-1.5 outline-none cursor-pointer max-w-[200px]"
                >
                  {creatives.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              {sel && <CreativeCard creative={sel} onThumbClick={() => setSelectedCreative(sel)} />}
            </div>
          );
        })}

        {/* Add slot button */}
        {ids.length < MAX_CREATIVES && (
          <button
            onClick={addSlot}
            className="border-2 border-dashed border-gray-700 rounded-2xl p-4 flex flex-col items-center justify-center gap-2 text-gray-500 hover:border-gray-500 hover:text-gray-300 transition-colors min-h-[120px]"
          >
            <Plus className="w-5 h-5" />
            <span className="text-xs font-medium">Ajouter une créa</span>
          </button>
        )}
      </div>

      {/* Overall Winner Banner */}
      {overallWinnerIdx >= 0 ? (
        <div
          className="flex items-center gap-4 rounded-2xl px-5 py-4 border"
          style={{
            background: `${SLOT_COLORS[overallWinnerIdx].fill}15`,
            borderColor: `${SLOT_COLORS[overallWinnerIdx].fill}50`,
          }}
        >
          <Trophy className="w-6 h-6 shrink-0" style={{ color: SLOT_COLORS[overallWinnerIdx].fill }} />
          <div className="flex-1">
            <p className="font-bold text-sm" style={{ color: SLOT_COLORS[overallWinnerIdx].fill }}>
              Créa {SLOT_COLORS[overallWinnerIdx].label} wins !
            </p>
            <p className="text-gray-400 text-xs mt-0.5">
              {resolvedCreatives[overallWinnerIdx]?.name} — {wins[overallWinnerIdx]} métriques remportées sur {METRICS.length}
            </p>
          </div>
          <div className="flex gap-3">
            {resolvedCreatives.map((c, idx) => (
              c && (
                <div key={idx} className="text-center">
                  <p className="font-bold text-base" style={{ color: SLOT_COLORS[idx].fill }}>{wins[idx]}</p>
                  <p className="text-gray-500 text-[10px]">{SLOT_COLORS[idx].label} wins</p>
                </div>
              )
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-2xl px-5 py-4 bg-gray-800/50 border border-gray-700">
          <Minus className="w-5 h-5 text-gray-500" />
          <p className="text-gray-300 font-medium text-sm">Égalité — les créatives sont à parité sur les métriques.</p>
        </div>
      )}

      {/* Head-to-Head Metric Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden overflow-x-auto">
        {/* Table header */}
        <div
          className="grid border-b border-gray-800 bg-gray-900/80"
          style={{ gridTemplateColumns: gridTemplate }}
        >
          <div className="px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Metric</div>
          {resolvedCreatives.map((c, idx) => (
            <div key={idx} className="px-3 py-3 text-xs font-semibold uppercase tracking-wide text-center" style={{ color: SLOT_COLORS[idx].fill }}>
              {SLOT_COLORS[idx].label} — {c?.name.slice(0, 12) ?? "—"}
            </div>
          ))}
        </div>

        {/* Rows */}
        {METRICS.map((m, rowIdx) => {
          const values = resolvedCreatives.map((c) => (c ? (c[m.key] as number) : 0));
          const allZero = values.every((v) => v === 0);
          const best = allZero ? null : (m.higherIsBetter ? Math.max(...values) : Math.min(...values));

          return (
            <div
              key={m.key}
              className={`grid ${rowIdx < METRICS.length - 1 ? "border-b border-gray-800/70" : ""}`}
              style={{ gridTemplateColumns: gridTemplate }}
            >
              <div className="px-5 py-4 flex items-center gap-1.5">
                <span className="text-sm text-gray-400 font-medium">{m.label}</span>
                <MetricInfoButton metricKey={m.key} />
              </div>
              {resolvedCreatives.map((c, idx) => {
                const val = c ? (c[m.key] as number) : 0;
                const isWinner = !allZero && val === best && val !== 0;
                return (
                  <div
                    key={idx}
                    className={`px-3 py-4 flex items-center justify-center gap-1.5 ${isWinner ? SLOT_COLORS[idx].bg : ""}`}
                  >
                    {isWinner && <TrendingUp className="w-3.5 h-3.5 shrink-0" style={{ color: SLOT_COLORS[idx].fill }} />}
                    <span
                      className="text-sm font-bold"
                      style={{ color: allZero || val === 0 ? "#4b5563" : isWinner ? SLOT_COLORS[idx].fill : "#9ca3af" }}
                    >
                      {allZero || (val === 0 && m.key !== "spend") ? "—" : m.format(val)}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Bar Chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-300 mb-1">Visual Comparison</h2>
        <p className="text-xs text-gray-500 mb-4">
          Spend en $k, CPA en $, rates en %. Les valeurs ne sont pas normalisées.
        </p>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }} barCategoryGap="25%" barGap={3}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="name" tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: "8px", fontSize: "12px", color: "#e5e7eb" }} />
            <Legend wrapperStyle={{ fontSize: "12px", color: "#9ca3af" }} />
            {resolvedCreatives.map((c, idx) =>
              c ? (
                <Bar
                  key={idx}
                  dataKey={`${SLOT_COLORS[idx].label} — ${c.name.slice(0, 10)}`}
                  fill={SLOT_COLORS[idx].fill}
                  radius={[4, 4, 0, 0]}
                />
              ) : null
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Creative Type Comparison */}
      <CreativeTypeComparison creatives={creatives} />

      {/* Week over Week */}
      <WowSection />

      {/* Modal */}
      <CreativeModal creative={selectedCreative} onClose={() => setSelectedCreative(null)} />
    </div>
  );
}
