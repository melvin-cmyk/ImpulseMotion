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
  ArrowUp,
  ArrowDown,
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function WeeklyPage() {
  const { creatives, isLoading, error, dateRange, setDatePreset, isRealData, wowData } =
    useCreativesContext();

  const handleMount = () => {
    setDatePreset(7);
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
          <button
            onClick={handleMount}
            className="text-xs px-3 py-1.5 bg-violet-600 hover:bg-violet-500 rounded-lg font-medium transition-colors"
          >
            Reset to 7 days
          </button>
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
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-6">
          <KpiCard
            label="Spend"
            value={fmtCurrency(totals.spend)}
            wowChange={wowData?.spendChange ?? null}
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
            wowChange={wowData?.ctrChange ?? null}
            icon={MousePointerClick}
            accent="bg-cyan-600"
          />
          <KpiCard
            label="CPA"
            value={totals.cpa > 0 ? fmtCurrency(totals.cpa) : "—"}
            wowChange={
              wowData?.cpaChange != null ? -wowData.cpaChange : null // CPA down = good
            }
            icon={ShoppingCart}
            accent="bg-pink-600"
          />
          <KpiCard
            label="ROAS"
            value={totals.roas > 0 ? fmt(totals.roas) + "×" : "—"}
            wowChange={wowData?.roasChange ?? null}
            icon={TrendingUp}
            accent="bg-emerald-600"
          />
        </div>

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
                  className="bg-[#111118] border border-emerald-500/30 rounded-2xl p-4 flex flex-col gap-2"
                >
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
              ))}
            </div>
          </div>
        )}

        {/* Data table */}
        <div className="bg-[#111118] border border-gray-800 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
            <span className="text-sm font-semibold text-white">
              Adset Performance — {sortedBySpend.length} creatives
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
                  <th className="text-right px-4 py-3 font-medium">Hook</th>
                  <th className="text-right px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {sortedBySpend.length === 0 && !isLoading && (
                  <tr>
                    <td colSpan={9} className="text-center py-12 text-gray-600 text-xs">
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
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
