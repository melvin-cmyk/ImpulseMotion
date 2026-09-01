"use client";

import { useState, useMemo } from "react";
import type { Creative, WowMetrics } from "@/lib/creative-types";
import { useCreativesContext } from "@/lib/creatives-context";
import { byFormat } from "@/lib/creative-stats";
import { fmtMoney, fmtRoas } from "@/lib/creative-format";
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
import { Pill } from "@/components/ui/surface";
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

type MetricKey = "spend" | "roas" | "cpa" | "ctr" | "hookRate" | "holdRate";

interface Metric {
  key: MetricKey;
  label: string;
  format: (v: number, currency: string | null) => string;
  higherIsBetter: boolean;
}

/** Numeric value of a metric for comparisons; unknown ROAS counts as 0 (rendered "—"). */
function metricValue(c: Creative, key: MetricKey): number {
  if (key === "roas") return c.roas !== null && !c.roasUnavailable ? c.roas : 0;
  return c[key];
}

const METRICS: Metric[] = [
  { key: "spend", label: "Spend", format: (v, cur) => fmtMoney(v, cur), higherIsBetter: true },
  { key: "roas", label: "ROAS", format: (v) => fmtRoas(v), higherIsBetter: true },
  { key: "cpa", label: "CPA", format: (v, cur) => fmtMoney(v, cur, 2), higherIsBetter: false },
  { key: "ctr", label: "CTR", format: (v) => `${v}%`, higherIsBetter: true },
  { key: "hookRate", label: "Hook (démarrages / impr.)", format: (v) => (v > 0 ? `${v}%` : "—"), higherIsBetter: true },
  { key: "holdRate", label: "Hold (ThruPlay / impr.)", format: (v) => (v > 0 ? `${v}%` : "—"), higherIsBetter: true },
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
  format: string;
  count: number;
  spend: number;
  /** Σ clicks / Σ impressions */
  ctr: number;
  /** impression-weighted hook over videos */
  hookRate: number;
  /** Σ revenue / Σ spend (0 when unknown) */
  roas: number;
  roasEstimated: boolean;
  roasUnavailable: boolean;
}

function CreativeTypeComparison({ creatives, currency }: { creatives: Creative[]; currency: string | null }) {
  // byFormat → aggregate(): Σ then ratio per format, never an average of ratios.
  const typeData: TypeAgg[] = useMemo(
    () =>
      byFormat(creatives).map((g) => ({
        format: g.label,
        count: g.stats.count,
        spend: g.stats.spend,
        ctr: g.stats.ctr ?? 0,
        hookRate: g.stats.hookRate ?? 0,
        roas: g.stats.unavailable ? 0 : (g.stats.roas ?? 0),
        roasEstimated: g.stats.estimated,
        roasUnavailable: g.stats.unavailable,
      })),
    [creatives],
  );

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
          <p className="text-[11px] text-gray-500 mt-0.5">Images vs vidéos vs carrousels — Σ puis ratio par format (pas de moyenne de ratios)</p>
        </div>
      </div>

      <div className="p-5 space-y-5">
        {(
          [
            { label: "ROAS (Σ revenu / Σ spend)", key: "roas" as const, max: maxRoas, format: (v: number, d: TypeAgg) => fmtRoas(d.roasUnavailable || v <= 0 ? null : v, { estimated: d.roasEstimated }), accent: "bg-violet-500" },
            { label: "CTR (Σ clics / Σ impr.)", key: "ctr" as const, max: maxCtr, format: (v: number) => `${v.toFixed(2)}%`, accent: "bg-blue-500" },
            { label: "Hook (pondéré, vidéos)", key: "hookRate" as const, max: maxHookRate, format: (v: number) => (v > 0 ? `${v.toFixed(1)}%` : "—"), accent: "bg-pink-500" },
            { label: "Spend total", key: "spend" as const, max: maxSpend, format: (v: number) => fmtMoney(v, currency), accent: "bg-emerald-500" },
          ] as const
        ).map(({ label, key, max, format, accent }) => (
          <div key={label}>
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-2">{label}</p>
            <div className="space-y-2">
              {typeData
                .filter((d) => d.count > 0)
                .map((d) => {
                  const val = d[key];
                  const pct = max > 0 ? (val / max) * 100 : 0;
                  return (
                    <div key={d.format} className="flex items-center gap-3">
                      <span className="text-xs text-gray-400 w-16 shrink-0">{d.format}</span>
                      <div className="flex-1 bg-gray-800 rounded-full h-2 overflow-hidden">
                        <div className={`h-2 rounded-full ${accent} transition-all duration-500`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs font-semibold text-gray-300 w-14 text-right shrink-0">{format(val, d)}</span>
                      <span className="text-[10px] text-gray-600 w-8 shrink-0">({d.count})</span>
                    </div>
                  );
                })}
            </div>
          </div>
        ))}
      </div>

      <div className="px-5 pb-5">
        <p className="text-xs text-gray-500 mb-3 uppercase tracking-wide font-medium">Overview chart (Spend en k {currency ?? ""}, taux en %)</p>
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
// Source unique : /api/meta/wow via le contexte (7 derniers jours vs les 7
// précédents, sans chevauchement). En démo, le contexte fournit des valeurs
// de démonstration signalées comme telles.

interface WowRow {
  key: keyof WowMetrics;
  metricKey: string;
  label: string;
  higherIsBetter: boolean;
}

const WOW_ROWS: WowRow[] = [
  { key: "spendChange", metricKey: "spend", label: "Spend", higherIsBetter: true },
  { key: "ctrChange", metricKey: "ctr", label: "CTR", higherIsBetter: true },
  { key: "cpaChange", metricKey: "cpa", label: "CPA", higherIsBetter: false },
  { key: "roasChange", metricKey: "roas", label: "ROAS", higherIsBetter: true },
  { key: "hookRateChange", metricKey: "hookRate", label: "Hook (démarrages / impr.)", higherIsBetter: true },
];

function ChangePill({ change, higherIsBetter }: { change: number | null; higherIsBetter: boolean }) {
  if (change === null || !isFinite(change)) return <span className="text-gray-500 text-sm font-medium">—</span>;
  if (change === 0) return <span className="text-gray-400 text-sm font-medium">0.0%</span>;
  const improved = (higherIsBetter && change > 0) || (!higherIsBetter && change < 0);
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-semibold ${improved ? "text-emerald-400" : "text-red-400"}`}>
      {improved ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
      {change > 0 ? "+" : ""}{change.toFixed(1)}%
    </span>
  );
}

function formatPeriod(p: { since: string; until: string }): string {
  const f = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  return `${f(p.since)} → ${f(p.until)}`;
}

function WowSection() {
  const { wowData, isWowLoading, isRealData } = useCreativesContext();

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
        <div className="w-8 h-8 rounded-xl bg-violet-500/20 flex items-center justify-center">
          <CalendarDays className="w-4 h-4 text-violet-400" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-200">Week over Week</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {wowData
              ? `Cette semaine (${formatPeriod(wowData.currentPeriod)}) vs semaine précédente (${formatPeriod(wowData.prevPeriod)}) — tout le compte`
              : "7 derniers jours vs les 7 précédents — tout le compte"}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {!isRealData && <Pill>Démo</Pill>}
          {isWowLoading && <Loader2 className="w-4 h-4 text-gray-500 animate-spin" />}
        </div>
      </div>

      <div className="grid grid-cols-[1fr_140px] border-b border-gray-800 bg-gray-900/80">
        <div className="px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Metric</div>
        <div className="px-4 py-2.5 text-xs font-semibold text-violet-400 uppercase tracking-wide text-center">Variation WoW</div>
      </div>

      {wowData && WOW_ROWS.map((row, i) => (
        <div key={row.key} className={`grid grid-cols-[1fr_140px] ${i < WOW_ROWS.length - 1 ? "border-b border-gray-800/70" : ""}`}>
          <div className="px-5 py-4 flex items-center gap-1.5">
            <span className="text-sm text-gray-400 font-medium">{row.label}</span>
            <MetricInfoButton metricKey={row.metricKey} />
          </div>
          <div className="px-4 py-4 flex items-center justify-center">
            <ChangePill change={wowData.aggregateWow[row.key]} higherIsBetter={row.higherIsBetter} />
          </div>
        </div>
      ))}

      {!wowData && !isWowLoading && (
        <div className="px-5 py-8 text-center text-gray-600 text-sm">Aucune donnée WoW disponible</div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ComparePage() {
  const { creatives, isLoading, currency } = useCreativesContext();
  const [ids, setIds] = useState<string[]>(["", ""]);
  const [selectedCreative, setSelectedCreative] = useState<Creative | null>(null);

  // Resolve effective IDs (fallback to index-based default)
  const resolvedCreatives = useMemo(() => {
    return ids.map((id, idx) => {
      if (id) return creatives.find((c) => c.id === id) ?? creatives[idx] ?? null;
      return creatives[idx] ?? null;
    });
  }, [ids, creatives]);

  // Compute wins per creative across all metrics
  const wins = useMemo(() => {
    const w = resolvedCreatives.map(() => 0);
    METRICS.forEach((m) => {
      const values = resolvedCreatives.map((c) => (c ? metricValue(c, m.key) : 0));
      const allZero = values.every((v) => v === 0);
      if (allZero) return;
      // Lower-is-better metrics (CPA) ignore 0 / unknown values.
      const candidates = m.higherIsBetter ? values : values.filter((v) => v > 0);
      const best = m.higherIsBetter ? Math.max(...candidates) : Math.min(...candidates);
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

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center h-48 text-gray-600">
        Chargement des créas…
      </div>
    );
  }
  if (creatives.length < 2) {
    return (
      <div className="p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-white">A/B… Comparison</h1>
          <p className="text-gray-400 text-sm mt-0.5">Compare jusqu&apos;à {MAX_CREATIVES} créatives côte à côte</p>
        </div>
        <DateRangePicker />
        <div className="p-6 bg-gray-900 border border-gray-800 rounded-2xl text-center">
          <p className="text-sm text-gray-300 font-medium">Il faut au moins 2 créas avec des impressions pour comparer</p>
          <p className="text-xs text-gray-500 mt-1">{creatives.length === 0 ? "Aucune annonce sur la période sélectionnée." : "Une seule annonce sur la période."} Élargis la période ou change de compte.</p>
        </div>
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

  // Chart data
  const chartData = METRICS.map((m) => {
    const row: Record<string, string | number> = { name: m.label };
    resolvedCreatives.forEach((c, idx) => {
      if (c) row[`${SLOT_COLORS[idx].label} — ${c.name.slice(0, 10)}`] = metricValue(c, m.key);
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
          const values = resolvedCreatives.map((c) => (c ? metricValue(c, m.key) : 0));
          const allZero = values.every((v) => v === 0);
          const positive = values.filter((v) => v > 0);
          const best = allZero ? null : (m.higherIsBetter ? Math.max(...values) : Math.min(...positive));

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
                const val = c ? metricValue(c, m.key) : 0;
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
                      {allZero || (val === 0 && m.key !== "spend") ? "—" : m.format(val, currency)}
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
          Spend et CPA en {currency ?? "devise du compte"}, taux en %. Les valeurs ne sont pas normalisées.
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
      <CreativeTypeComparison creatives={creatives} currency={currency} />

      {/* Week over Week */}
      <WowSection />

      {/* Modal */}
      <CreativeModal creative={selectedCreative} onClose={() => setSelectedCreative(null)} />
    </div>
  );
}
