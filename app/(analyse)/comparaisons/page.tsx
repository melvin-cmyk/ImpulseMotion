"use client";

import { useMemo, useState } from "react";
import type { Creative } from "@/lib/creative-types";
import { useCreativesContext, useMoney } from "@/lib/creatives-context";
import { aggregate, byFormat, byStatus, type Group } from "@/lib/creative-stats";
import { fmtPct, fmtX, type MoneyFmt } from "@/lib/creative-format";
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
import { BarChart2, LayoutGrid, TrendingUp, DollarSign, MousePointerClick } from "lucide-react";
import { PageHelp } from "@/components/ui/page-help";
import { Kpi, PageHeader } from "@/components/ui/surface";
import { MetricInfoButton } from "@/components/metric-info-button";
import { RoasValue } from "@/components/roas-value";

// ── Colors ────────────────────────────────────────────────────────────────────

const FORMAT_COLORS: Record<string, string> = {
  Video: "#8b5cf6",
  Image: "#60a5fa",
  Carousel: "#34d399",
};

const STATUS_COLORS: Record<string, string> = {
  Winner: "#34d399",
  Active: "#60a5fa",
  Fatigued: "#fb923c",
  Loser: "#f87171",
};

function colorFor(g: Group, palette: Record<string, string>): string {
  return palette[g.key] ?? "#8b5cf6";
}

// ── Grouped bar chart (Spend + CPA side by side) ──────────────────────────────

function SpendCpaSideBySide({ groups }: { groups: Group[] }) {
  const chartData = groups.map((g) => ({
    label: g.label,
    "Spend ($k)": Math.round((g.stats.spend / 1000) * 10) / 10,
    "CPA ($)": g.stats.cpa === null ? null : Math.round(g.stats.cpa * 100) / 100,
  }));

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-white">Spend & CPA par groupe</h3>
        <p className="text-[11px] text-gray-500 mt-0.5">Spend total ($k) et CPA ($) — le CPA est absent quand aucun achat n&apos;est attribué</p>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }} barCategoryGap="30%" barGap={4}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
          <XAxis dataKey="label" tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: "8px", fontSize: "11px", color: "#e5e7eb" }}
            formatter={(v: unknown) => (typeof v === "number" ? v : "—")}
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

const METRIC_CONFIG: { key: BarMetric; label: string; format: (v: number | null, money: MoneyFmt) => string }[] = [
  { key: "spend", label: "Spend total", format: (v, money) => money(v) },
  { key: "cpa", label: "CPA", format: (v, money) => money(v, 2) },
  { key: "ctr", label: "CTR", format: (v) => fmtPct(v) },
  { key: "roas", label: "ROAS", format: (v) => fmtX(v) },
];

function MetricBarChart({ groups, metric, palette }: { groups: Group[]; metric: BarMetric; palette: Record<string, string> }) {
  const money = useMoney();
  const cfg = METRIC_CONFIG.find((m) => m.key === metric)!;
  const values = groups.map((g) => g.stats[metric] ?? 0);
  const maxVal = Math.max(...values, 0.001);

  return (
    <div className="space-y-3">
      {groups.map((g) => {
        const val = g.stats[metric];
        const pct = val === null ? 0 : (val / maxVal) * 100;
        const color = colorFor(g, palette);
        return (
          <div key={g.key}>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
                <span className="text-sm font-semibold text-white">{g.label}</span>
                <span className="text-[11px] text-gray-500">({g.stats.count} créas)</span>
              </div>
              <span className="text-sm font-bold" style={{ color }}>
                {metric === "roas" ? <RoasValue value={val} estimated={g.stats.estimated} /> : cfg.format(val, money)}
              </span>
            </div>
            <div className="h-5 bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: color, opacity: 0.8 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Detailed summary table ────────────────────────────────────────────────────

function SummaryTable({ groups, palette }: { groups: Group[]; palette: Record<string, string> }) {
  const money = useMoney();
  const th = "px-4 py-3 text-right text-[10px] text-gray-500 uppercase tracking-wide";
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-800">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-800 bg-gray-900/80">
            <th className="px-4 py-3 text-left text-[10px] text-gray-500 uppercase tracking-wide">Groupe</th>
            <th className={th}>Créas</th>
            <th className={th}><span className="inline-flex items-center gap-1 justify-end">Spend total <MetricInfoButton metricKey="spend" /></span></th>
            <th className={th}>Achats</th>
            <th className={th}><span className="inline-flex items-center gap-1 justify-end">CPA <MetricInfoButton metricKey="cpa" /></span></th>
            <th className={th}><span className="inline-flex items-center gap-1 justify-end">CTR <MetricInfoButton metricKey="ctr" /></span></th>
            <th className={th}><span className="inline-flex items-center gap-1 justify-end">ROAS <MetricInfoButton metricKey="roas" /></span></th>
            <th className={th}><span className="inline-flex items-center gap-1 justify-end">Hook Rate <MetricInfoButton metricKey="hookRate" /></span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/60 bg-gray-900">
          {groups.map((g) => {
            const color = colorFor(g, palette);
            return (
              <tr key={g.key} className="hover:bg-gray-800/30 transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-sm" style={{ background: color }} />
                    <span className="font-semibold text-gray-200">{g.label}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-gray-300">{g.stats.count}</td>
                <td className="px-4 py-3 text-right text-gray-300 font-semibold">{money(g.stats.spend)}</td>
                <td className="px-4 py-3 text-right text-gray-300">{g.stats.conversions}</td>
                <td className="px-4 py-3 text-right text-gray-300">{money(g.stats.cpa, 2)}</td>
                <td className="px-4 py-3 text-right text-gray-300">{fmtPct(g.stats.ctr)}</td>
                <td className="px-4 py-3 text-right font-semibold" style={{ color }}>
                  <RoasValue value={g.stats.roas} estimated={g.stats.estimated} />
                </td>
                <td className="px-4 py-3 text-right text-gray-300">{g.stats.videoCount > 0 ? fmtPct(g.stats.hookRate, 1) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {groups.length === 0 && (
        <div className="flex items-center justify-center h-16 text-gray-600 text-sm bg-gray-900">Aucun groupe disponible.</div>
      )}
    </div>
  );
}

// ── Comparison Section (one dimension at a time) ──────────────────────────────

function ComparisonSection({
  title,
  description,
  groups,
  palette,
  icon: Icon,
  iconColor,
  iconBg,
}: {
  title: string;
  description: string;
  groups: Group[];
  palette: Record<string, string>;
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
}) {
  const [barMetric, setBarMetric] = useState<BarMetric>("spend");
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 border-b border-gray-800 hover:bg-gray-800/30 transition-colors"
        aria-expanded={!collapsed}
      >
        <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${iconBg}`}>
          <Icon className={`w-4 h-4 ${iconColor}`} />
        </div>
        <div className="text-left flex-1">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">{description}</p>
        </div>
        <svg className={`w-4 h-4 text-gray-500 transition-transform ${collapsed ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {!collapsed && (
        <div className="p-5 space-y-6">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <p className="text-xs text-gray-500">{groups.map((g) => `${g.label} (${g.stats.count})`).join(" · ")}</p>
            <div className="flex gap-1 bg-gray-800 rounded-xl p-1">
              {METRIC_CONFIG.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setBarMetric(key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    barMetric === key ? "bg-violet-600 text-white" : "text-gray-400 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <MetricBarChart groups={groups} metric={barMetric} palette={palette} />
          <SpendCpaSideBySide groups={groups} />
          <SummaryTable groups={groups} palette={palette} />
        </div>
      )}
    </div>
  );
}

// ── Insights banner (computed, not AI) ────────────────────────────────────────

function ComparativeInsights({ creatives, formatGroups }: { creatives: Creative[]; formatGroups: Group[] }) {
  const money = useMoney();
  const insights = useMemo(() => {
    const items: { text: string; color: string }[] = [];
    if (creatives.length === 0) return items;

    const withRoas = formatGroups.filter((g) => g.stats.spend > 0 && g.stats.roas !== null);
    if (withRoas.length >= 2) {
      const best = withRoas.reduce((a, b) => ((a.stats.roas ?? 0) >= (b.stats.roas ?? 0) ? a : b));
      const worst = withRoas.reduce((a, b) => ((a.stats.roas ?? 0) <= (b.stats.roas ?? 0) ? a : b));
      const bestRoas = best.stats.roas ?? 0;
      const worstRoas = worst.stats.roas ?? 0;
      if (best.key !== worst.key && bestRoas > 0 && bestRoas > worstRoas * 1.2) {
        items.push({
          text: `${best.label} a le meilleur ROAS (${fmtX(bestRoas)}${best.stats.estimated ? "*" : ""} vs ${fmtX(worstRoas)}${worst.stats.estimated ? "*" : ""} pour ${worst.label}) sur ${money(best.stats.spend)} de spend.`,
          color: "text-violet-300",
        });
      }
    }

    const winners = creatives.filter((c) => c.status === "Winner");
    const losers = creatives.filter((c) => c.status === "Loser");
    const totalSpend = creatives.reduce((s, c) => s + c.spend, 0);
    if (losers.length > 0 && totalSpend > 0) {
      const loserSpend = losers.reduce((s, c) => s + c.spend, 0);
      const winnerSpend = winners.reduce((s, c) => s + c.spend, 0);
      const loserPct = (loserSpend / totalSpend) * 100;
      if (loserPct > 10) {
        items.push({
          text: `${loserPct.toFixed(0)}% du budget (${money(loserSpend)}) est alloué à des créatives « Loser »${winners.length > 0 ? ` contre ${money(winnerSpend)} pour les Winners` : " et aucune créative n'est Winner sur la période"}.`,
          color: "text-amber-300",
        });
      }
    }

    return items.slice(0, 3);
  }, [creatives, formatGroups, money]);

  if (insights.length === 0) return null;

  return (
    <div className="bg-gray-900 border border-violet-800/40 rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-violet-400" />
          <h3 className="text-sm font-semibold text-violet-300">Constats calculés</h3>
        </div>
        <span className="text-[11px] text-gray-500">déduits des totaux, pas une analyse IA</span>
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
  const money = useMoney();

  const formatGroups = useMemo(() => byFormat(creatives), [creatives]);
  const statusGroups = useMemo(() => byStatus(creatives), [creatives]);
  const total = useMemo(() => aggregate(creatives), [creatives]);

  return (
    <div className="p-6 space-y-6">
      <PageHelp
        title="Comparaisons — Métriques agrégées par dimension"
        description="Compare les performances par format créatif (Image vs Vidéo vs Carrousel) et par statut (Winner / Active / Fatigued / Loser). Spend, clics et achats sont cumulés par groupe ; CTR, CPA et ROAS sont recalculés sur ces totaux."
        steps={[
          "Sélectionne une période avec le date picker pour filtrer les données.",
          "Consulte les KPIs globaux en haut, puis descends dans chaque section pour comparer par format et par statut.",
          "Utilise les boutons de métrique (Spend, CPA, CTR, ROAS) dans chaque section pour changer la visualisation.",
        ]}
        tip="Un ROAS suivi d'un astérisque est estimé à partir du panier moyen. Un CPA absent signifie qu'aucun achat n'a été attribué au groupe."
      />
      <PageHeader title="Comparaisons" subtitle="Métriques agrégées par format et par statut" action={<DateRangePicker />} />

      {isLoading ? (
        <div className="text-center py-16 text-gray-500 text-sm">Chargement des données…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label="Spend total" value={money(total.spend)} sub={`${creatives.length} créatives`} icon={<DollarSign className="w-4 h-4" />} />
            <Kpi label="CPA" value={money(total.cpa, 2)} sub={`${total.conversions} achat${total.conversions > 1 ? "s" : ""}`} icon={<BarChart2 className="w-4 h-4" />} accent="blue" />
            <Kpi label="CTR" value={fmtPct(total.ctr)} sub="clics / impressions" icon={<MousePointerClick className="w-4 h-4" />} accent="amber" />
            <Kpi label="ROAS" value={<RoasValue value={total.roas} estimated={total.estimated} />} sub="revenu / spend" icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
          </div>

          <ComparativeInsights creatives={creatives} formatGroups={formatGroups} />

          <ComparisonSection
            title="Par format (Image vs Vidéo vs Carrousel)"
            description="Performances agrégées par type de créative — Spend, CPA, CTR, ROAS"
            groups={formatGroups}
            palette={FORMAT_COLORS}
            icon={LayoutGrid}
            iconColor="text-violet-400"
            iconBg="bg-violet-500/20"
          />

          <ComparisonSection
            title="Par statut (Winner / Active / Fatigued / Loser)"
            description="Distribution du budget et des performances selon le statut calculé des créatives"
            groups={statusGroups}
            palette={STATUS_COLORS}
            icon={BarChart2}
            iconColor="text-emerald-400"
            iconBg="bg-emerald-500/20"
          />
        </>
      )}
    </div>
  );
}
