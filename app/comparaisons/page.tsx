"use client";

import { useMemo, useState } from "react";
import { Creative, Format, Platform } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
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
  Cell,
} from "recharts";
import { BarChart2, LayoutGrid, TrendingUp, DollarSign, MousePointerClick, Zap } from "lucide-react";
import { PageHelp } from "@/components/ui/page-help";

// ── Types ─────────────────────────────────────────────────────────────────────

type GroupDimension = "format" | "platform" | "status";

interface GroupStats {
  label: string;
  count: number;
  totalSpend: number;
  avgCpa: number;
  avgCtr: number;
  avgRoas: number;
  avgHookRate: number;
  color: string;
}

// ── Color maps ────────────────────────────────────────────────────────────────

const FORMAT_COLORS: Record<string, string> = {
  Video: "#8b5cf6",
  Image: "#60a5fa",
  Carousel: "#34d399",
};

const PLATFORM_COLORS: Record<string, string> = {
  Meta: "#1877F2",
  TikTok: "#ff0050",
};

const STATUS_COLORS: Record<string, string> = {
  Winner: "#34d399",
  Active: "#60a5fa",
  Fatigued: "#fb923c",
  Loser: "#f87171",
};

// ── Aggregation helpers ───────────────────────────────────────────────────────

function buildGroupStats(
  creatives: Creative[],
  dimension: GroupDimension
): GroupStats[] {
  const groups = new Map<string, Creative[]>();

  creatives.forEach((c) => {
    let key: string;
    if (dimension === "format") key = c.format;
    else if (dimension === "platform") key = c.platform;
    else key = c.status;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  });

  const stats: GroupStats[] = [];
  groups.forEach((items, label) => {
    const totalSpend = items.reduce((s, c) => s + c.spend, 0);
    const avgCpa = items.reduce((s, c) => s + c.cpa, 0) / items.length;
    const avgCtr = items.reduce((s, c) => s + c.ctr, 0) / items.length;
    const avgRoas = items.reduce((s, c) => s + c.roas, 0) / items.length;
    const videoItems = items.filter((c) => c.hookRate > 0);
    const avgHookRate =
      videoItems.length > 0
        ? videoItems.reduce((s, c) => s + c.hookRate, 0) / videoItems.length
        : 0;

    let color = "#8b5cf6";
    if (dimension === "format") color = FORMAT_COLORS[label] ?? "#8b5cf6";
    else if (dimension === "platform") color = PLATFORM_COLORS[label] ?? "#8b5cf6";
    else color = STATUS_COLORS[label] ?? "#8b5cf6";

    stats.push({ label, count: items.length, totalSpend, avgCpa, avgCtr, avgRoas, avgHookRate, color });
  });

  return stats.sort((a, b) => b.totalSpend - a.totalSpend);
}

// ── Summary KPI cards ─────────────────────────────────────────────────────────

function SummaryKpiCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent: string;
}) {
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

// ── Grouped bar chart (Spend + CPA side by side using recharts) ───────────────

function SpendCpaSideBySide({ stats }: { stats: GroupStats[] }) {
  const chartData = stats.map((s) => ({
    label: s.label,
    "Spend ($k)": Math.round((s.totalSpend / 1000) * 10) / 10,
    "CPA ($)": Math.round(s.avgCpa * 100) / 100,
    color: s.color,
  }));

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-white">Spend & CPA par groupe</h3>
        <p className="text-[11px] text-gray-500 mt-0.5">
          Spend total ($k) et CPA moyen ($) — cliquer sur une barre pour voir le détail
        </p>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart
          data={chartData}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
          barCategoryGap="30%"
          barGap={4}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: "#9ca3af", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "#6b7280", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              background: "#111827",
              border: "1px solid #374151",
              borderRadius: "8px",
              fontSize: "11px",
              color: "#e5e7eb",
            }}
          />
          <Legend wrapperStyle={{ fontSize: "11px", color: "#9ca3af" }} />
          <Bar dataKey="Spend ($k)" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
          <Bar dataKey="CPA ($)" fill="#60a5fa" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Horizontal CSS bar chart ──────────────────────────────────────────────────

type BarMetric = "spend" | "cpa" | "ctr" | "roas";

const METRIC_CONFIG: {
  key: BarMetric;
  label: string;
  format: (v: number) => string;
  lowerIsBetter?: boolean;
}[] = [
  { key: "spend", label: "Spend total", format: (v) => v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}` },
  { key: "cpa", label: "CPA moyen", format: (v) => `$${v.toFixed(2)}`, lowerIsBetter: true },
  { key: "ctr", label: "CTR moyen", format: (v) => `${v.toFixed(2)}%` },
  { key: "roas", label: "ROAS moyen", format: (v) => `${v.toFixed(2)}x` },
];

function getMetricVal(s: GroupStats, metric: BarMetric): number {
  if (metric === "spend") return s.totalSpend;
  if (metric === "cpa") return s.avgCpa;
  if (metric === "ctr") return s.avgCtr;
  if (metric === "roas") return s.avgRoas;
  return 0;
}

function MetricBarChart({
  stats,
  metric,
}: {
  stats: GroupStats[];
  metric: BarMetric;
}) {
  const cfg = METRIC_CONFIG.find((m) => m.key === metric)!;
  const values = stats.map((s) => getMetricVal(s, metric));
  const maxVal = Math.max(...values, 0.001);

  return (
    <div className="space-y-3">
      {stats.map((s) => {
        const val = getMetricVal(s, metric);
        const pct = (val / maxVal) * 100;
        return (
          <div key={s.label}>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
                <span className="text-sm font-semibold text-white">{s.label}</span>
                <span className="text-[11px] text-gray-500">({s.count} créas)</span>
              </div>
              <span className="text-sm font-bold" style={{ color: s.color }}>
                {cfg.format(val)}
              </span>
            </div>
            <div className="h-5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{ width: `${pct}%`, background: s.color, opacity: 0.8 }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Detailed summary table ────────────────────────────────────────────────────

function SummaryTable({ stats }: { stats: GroupStats[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-800">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-800 bg-gray-900/80">
            <th className="px-4 py-3 text-left text-[10px] text-gray-500 uppercase tracking-wide">
              Groupe
            </th>
            <th className="px-4 py-3 text-right text-[10px] text-gray-500 uppercase tracking-wide">
              Créas
            </th>
            <th className="px-4 py-3 text-right text-[10px] text-gray-500 uppercase tracking-wide">
              Spend total
            </th>
            <th className="px-4 py-3 text-right text-[10px] text-gray-500 uppercase tracking-wide">
              CPA moy.
            </th>
            <th className="px-4 py-3 text-right text-[10px] text-gray-500 uppercase tracking-wide">
              CTR moy.
            </th>
            <th className="px-4 py-3 text-right text-[10px] text-gray-500 uppercase tracking-wide">
              ROAS moy.
            </th>
            <th className="px-4 py-3 text-right text-[10px] text-gray-500 uppercase tracking-wide">
              Hook Rate moy.
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/60 bg-gray-900">
          {stats.map((s) => (
            <tr key={s.label} className="hover:bg-gray-800/30 transition-colors">
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-sm" style={{ background: s.color }} />
                  <span className="font-semibold text-gray-200">{s.label}</span>
                </div>
              </td>
              <td className="px-4 py-3 text-right text-gray-300">{s.count}</td>
              <td className="px-4 py-3 text-right text-gray-300 font-semibold">
                {s.totalSpend >= 1000
                  ? `$${(s.totalSpend / 1000).toFixed(1)}k`
                  : `$${s.totalSpend.toFixed(0)}`}
              </td>
              <td className="px-4 py-3 text-right text-gray-300">${s.avgCpa.toFixed(2)}</td>
              <td className="px-4 py-3 text-right text-gray-300">{s.avgCtr.toFixed(2)}%</td>
              <td
                className="px-4 py-3 text-right font-semibold"
                style={{ color: s.color }}
              >
                {s.avgRoas.toFixed(2)}x
              </td>
              <td className="px-4 py-3 text-right text-gray-300">
                {s.avgHookRate > 0 ? `${s.avgHookRate.toFixed(1)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {stats.length === 0 && (
        <div className="flex items-center justify-center h-16 text-gray-600 text-sm bg-gray-900">
          Aucun groupe disponible.
        </div>
      )}
    </div>
  );
}

// ── Comparison Section (one dimension at a time) ──────────────────────────────

function ComparisonSection({
  title,
  description,
  stats,
  icon: Icon,
  iconColor,
  iconBg,
}: {
  title: string;
  description: string;
  stats: GroupStats[];
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
}) {
  const [barMetric, setBarMetric] = useState<BarMetric>("spend");
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 border-b border-gray-800 hover:bg-gray-800/30 transition-colors"
      >
        <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${iconBg}`}>
          <Icon className={`w-4 h-4 ${iconColor}`} />
        </div>
        <div className="text-left flex-1">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">{description}</p>
        </div>
        <svg
          className={`w-4 h-4 text-gray-500 transition-transform ${collapsed ? "" : "rotate-180"}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {!collapsed && (
        <div className="p-5 space-y-6">
          {/* Metric selector */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <p className="text-xs text-gray-500">
              {stats.map((s) => `${s.label} (${s.count})`).join(" · ")}
            </p>
            <div className="flex gap-1 bg-gray-800 rounded-xl p-1">
              {METRIC_CONFIG.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setBarMetric(key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    barMetric === key
                      ? "bg-violet-600 text-white"
                      : "text-gray-400 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Horizontal bar chart */}
          <MetricBarChart stats={stats} metric={barMetric} />

          {/* Spend + CPA side by side grouped bar chart */}
          <SpendCpaSideBySide stats={stats} />

          {/* Summary table */}
          <SummaryTable stats={stats} />
        </div>
      )}
    </div>
  );
}

// ── Insights banner ───────────────────────────────────────────────────────────

function ComparativeInsights({ creatives }: { creatives: Creative[] }) {
  const insights = useMemo(() => {
    const items: { text: string; color: string }[] = [];
    if (creatives.length === 0) return items;

    const byFormat: Record<Format, Creative[]> = { Video: [], Image: [], Carousel: [] };
    creatives.forEach((c) => { if (byFormat[c.format]) byFormat[c.format].push(c); });

    const formats = (Object.keys(byFormat) as Format[]).filter((f) => byFormat[f].length > 0);
    if (formats.length >= 2) {
      const avgRoas = (f: Format) =>
        byFormat[f].length > 0
          ? byFormat[f].reduce((s, c) => s + c.roas, 0) / byFormat[f].length
          : 0;
      const best = formats.reduce((a, b) => (avgRoas(a) > avgRoas(b) ? a : b));
      const worst = formats.reduce((a, b) => (avgRoas(a) < avgRoas(b) ? a : b));
      if (best !== worst && avgRoas(best) > avgRoas(worst) * 1.2) {
        items.push({
          text: `${best} a le meilleur ROAS moyen (${avgRoas(best).toFixed(2)}x vs ${avgRoas(worst).toFixed(2)}x pour ${worst}).`,
          color: "text-violet-300",
        });
      }
    }

    const byPlatform: Record<Platform, Creative[]> = { Meta: [], TikTok: [] };
    creatives.forEach((c) => byPlatform[c.platform].push(c));
    if (byPlatform.Meta.length > 0 && byPlatform.TikTok.length > 0) {
      const metaCpa = byPlatform.Meta.reduce((s, c) => s + c.cpa, 0) / byPlatform.Meta.length;
      const tiktokCpa = byPlatform.TikTok.reduce((s, c) => s + c.cpa, 0) / byPlatform.TikTok.length;
      const betterPlatform = metaCpa < tiktokCpa ? "Meta" : "TikTok";
      const diff = Math.abs(((metaCpa - tiktokCpa) / Math.max(metaCpa, tiktokCpa)) * 100);
      if (diff > 10) {
        items.push({
          text: `${betterPlatform} génère un CPA ${diff.toFixed(0)}% plus bas — concentrer les budgets là-bas.`,
          color: "text-blue-300",
        });
      }
    }

    const winners = creatives.filter((c) => c.status === "Winner");
    const losers = creatives.filter((c) => c.status === "Loser");
    if (winners.length > 0 && losers.length > 0) {
      const winnerSpend = winners.reduce((s, c) => s + c.spend, 0);
      const loserSpend = losers.reduce((s, c) => s + c.spend, 0);
      const totalSpend = creatives.reduce((s, c) => s + c.spend, 0);
      const loserPct = ((loserSpend / totalSpend) * 100).toFixed(0);
      if (Number(loserPct) > 10) {
        items.push({
          text: `${loserPct}% du budget ($${(loserSpend / 1000).toFixed(1)}k) est alloué à des créatives "Loser". Réallouer vers les Winners ($${(winnerSpend / 1000).toFixed(1)}k actuellement).`,
          color: "text-amber-300",
        });
      }
    }

    return items.slice(0, 3);
  }, [creatives]);

  if (insights.length === 0) return null;

  return (
    <div className="bg-gray-900 border border-violet-800/40 rounded-2xl p-5 space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <TrendingUp className="w-4 h-4 text-violet-400" />
        <h3 className="text-sm font-semibold text-violet-300">Insights comparatifs</h3>
      </div>
      <ul className="space-y-2">
        {insights.map((ins, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="text-gray-600 text-xs mt-0.5">•</span>
            <p className={`text-xs leading-relaxed ${ins.color}`}>{ins.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ComparaisonsPage() {
  const { creatives, isLoading } = useCreativesContext();

  const formatStats = useMemo(() => buildGroupStats(creatives, "format"), [creatives]);
  const platformStats = useMemo(() => buildGroupStats(creatives, "platform"), [creatives]);
  const statusStats = useMemo(() => buildGroupStats(creatives, "status"), [creatives]);

  const globalKpis = useMemo(() => {
    if (creatives.length === 0) return { totalSpend: 0, avgCpa: 0, avgCtr: 0, avgRoas: 0 };
    const totalSpend = creatives.reduce((s, c) => s + c.spend, 0);
    const avgCpa = creatives.reduce((s, c) => s + c.cpa, 0) / creatives.length;
    const avgCtr = creatives.reduce((s, c) => s + c.ctr, 0) / creatives.length;
    const avgRoas = creatives.reduce((s, c) => s + c.roas, 0) / creatives.length;
    return { totalSpend, avgCpa, avgCtr, avgRoas };
  }, [creatives]);

  return (
    <div className="p-6 space-y-6">
      {/* Page Help */}
      <PageHelp
        title="Comparaisons — Métriques agrégées par dimension"
        description="Compare les performances entre différentes dimensions : format créatif (Image vs Vidéo vs Carrousel), plateforme (Meta vs TikTok) et statut (Winner vs Loser). Identifie où concentrer ton budget."
        steps={[
          "Sélectionne une période avec le date picker pour filtrer les données sur la fenêtre qui t'intéresse.",
          "Consulte les KPIs globaux en haut, puis descends dans chaque section pour comparer par format, plateforme et statut.",
          "Utilise les boutons de métrique (Spend, CPA, CTR, ROAS) dans chaque section pour changer la visualisation.",
        ]}
        tip="Le panneau 'Insights comparatifs' en haut génère automatiquement des recommandations actionables — regarde si une plateforme a un CPA significativement plus bas que l'autre."
      />
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Comparaisons</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            Métriques agrégées par format, plateforme et statut
          </p>
        </div>
        <DateRangePicker />
      </div>

      {isLoading ? (
        <div className="text-center py-16 text-gray-500 text-sm">
          Chargement des données…
        </div>
      ) : (
        <>
          {/* Global KPI summary */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <SummaryKpiCard
              label="Spend total"
              value={
                globalKpis.totalSpend >= 1000
                  ? `$${(globalKpis.totalSpend / 1000).toFixed(1)}k`
                  : `$${globalKpis.totalSpend.toFixed(0)}`
              }
              sub={`${creatives.length} créatives actives`}
              icon={DollarSign}
              accent="bg-violet-500/20 text-violet-400"
            />
            <SummaryKpiCard
              label="CPA moyen"
              value={`$${globalKpis.avgCpa.toFixed(2)}`}
              sub="coût par acquisition"
              icon={BarChart2}
              accent="bg-blue-500/20 text-blue-400"
            />
            <SummaryKpiCard
              label="CTR moyen"
              value={`${globalKpis.avgCtr.toFixed(2)}%`}
              sub="click-through rate"
              icon={MousePointerClick}
              accent="bg-pink-500/20 text-pink-400"
            />
            <SummaryKpiCard
              label="ROAS moyen"
              value={`${globalKpis.avgRoas.toFixed(2)}x`}
              sub="return on ad spend"
              icon={TrendingUp}
              accent="bg-emerald-500/20 text-emerald-400"
            />
          </div>

          {/* Insights */}
          <ComparativeInsights creatives={creatives} />

          {/* By Format */}
          <ComparisonSection
            title="Par format (Image vs Vidéo vs Carrousel)"
            description="Performances agrégées par type de créative — Spend, CPA, CTR, ROAS"
            stats={formatStats}
            icon={LayoutGrid}
            iconColor="text-violet-400"
            iconBg="bg-violet-500/20"
          />

          {/* By Platform */}
          <ComparisonSection
            title="Par plateforme (Meta vs TikTok)"
            description="Comparaison des performances entre plateformes publicitaires"
            stats={platformStats}
            icon={Zap}
            iconColor="text-blue-400"
            iconBg="bg-blue-500/20"
          />

          {/* By Status */}
          <ComparisonSection
            title="Par statut (Winner / Active / Fatigued / Loser)"
            description="Distribution du budget et des performances selon le statut des créatives"
            stats={statusStats}
            icon={BarChart2}
            iconColor="text-emerald-400"
            iconBg="bg-emerald-500/20"
          />
        </>
      )}
    </div>
  );
}
