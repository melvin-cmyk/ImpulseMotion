"use client";

import { useMemo } from "react";
import { useCreativesContext } from "@/lib/creatives-context";
import { Sidebar } from "@/components/sidebar";
import {
  DollarSign,
  Eye,
  MousePointerClick,
  TrendingUp,
  ShoppingCart,
  BarChart3,
} from "lucide-react";

// ── KPI card ──────────────────────────────────────────────────────────────────

function KpiCard({
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
    <div className="bg-[#111118] border border-gray-800 rounded-2xl p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${accent}`}>
          <Icon className="w-4 h-4 text-white" />
        </div>
        <span className="text-xs text-gray-400 font-medium">{label}</span>
      </div>
      <div>
        <div className="text-2xl font-bold text-white">{value}</div>
        {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

// ── Table row ──────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtCurrency(n: number) {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MonthlyPage() {
  const { creatives, isLoading, error, dateRange, setDatePreset, isRealData } =
    useCreativesContext();

  // Force 30-day preset for monthly view
  const handleMount = () => {
    setDatePreset(30);
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
    // Weighted average ROAS
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

  return (
    <div className="flex h-screen bg-[#0a0a0f] text-white overflow-hidden">
      <Sidebar />
      <div className="flex-1 overflow-y-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">Monthly Overview</h1>
            <p className="text-sm text-gray-400 mt-0.5">
              Meta Ads · {dateRange.since} → {dateRange.until}
            </p>
          </div>
          <button
            onClick={handleMount}
            className="text-xs px-3 py-1.5 bg-violet-600 hover:bg-violet-500 rounded-lg font-medium transition-colors"
          >
            Reset to 30 days
          </button>
        </div>

        {/* Status */}
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

        {/* KPI grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-6">
          <KpiCard
            label="Spend"
            value={fmtCurrency(totals.spend)}
            sub="30-day total"
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
            icon={MousePointerClick}
            accent="bg-cyan-600"
          />
          <KpiCard
            label="CPA"
            value={totals.cpa > 0 ? fmtCurrency(totals.cpa) : "—"}
            icon={ShoppingCart}
            accent="bg-pink-600"
          />
          <KpiCard
            label="ROAS"
            value={totals.roas > 0 ? fmt(totals.roas) + "×" : "—"}
            icon={TrendingUp}
            accent="bg-emerald-600"
          />
        </div>

        {/* Data table */}
        <div className="bg-[#111118] border border-gray-800 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
            <span className="text-sm font-semibold text-white">
              Adset Performance — Top {sortedBySpend.length} creatives
            </span>
            {isLoading && (
              <span className="text-xs text-gray-500 animate-pulse">Loading…</span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-xs text-gray-500">
                  <th className="text-left px-5 py-3 font-medium">Creative</th>
                  <th className="text-right px-4 py-3 font-medium">Spend</th>
                  <th className="text-right px-4 py-3 font-medium">Impressions</th>
                  <th className="text-right px-4 py-3 font-medium">CPM</th>
                  <th className="text-right px-4 py-3 font-medium">CTR</th>
                  <th className="text-right px-4 py-3 font-medium">CPA</th>
                  <th className="text-right px-4 py-3 font-medium">ROAS</th>
                  <th className="text-right px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {sortedBySpend.length === 0 && !isLoading && (
                  <tr>
                    <td colSpan={8} className="text-center py-12 text-gray-600 text-xs">
                      No Meta creatives found for this date range.
                    </td>
                  </tr>
                )}
                {sortedBySpend.map((c) => {
                  const impressions = c.impressions ?? 0;
                  const clicks = c.clicks ?? 0;
                  const cpm = impressions > 0 ? (c.spend / impressions) * 1000 : 0;
                  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
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
                        <div className="font-medium text-white truncate max-w-[180px]" title={c.name}>
                          {c.name}
                        </div>
                        <div className="text-xs text-gray-500">{c.format}</div>
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
                        {c.cpa > 0 ? fmtCurrency(c.cpa) : "—"}
                      </td>
                      <td className="text-right px-4 py-3 font-semibold text-white">
                        {c.roas > 0 ? fmt(c.roas) + "×" : "—"}
                      </td>
                      <td className={`text-right px-5 py-3 text-xs font-medium ${statusColor[c.status] ?? "text-gray-400"}`}>
                        {c.status}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
