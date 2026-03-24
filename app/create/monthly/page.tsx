"use client";

import { useMemo, useState } from "react";
import { useCreativesContext } from "@/lib/creatives-context";
import { Sidebar } from "@/components/sidebar";
import { CreativeThumbnail } from "@/components/creative-thumbnail";
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
  AlertTriangle,
  Target,
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

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtCurrency(n: number) {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Sort types ─────────────────────────────────────────────────────────────────

type SortKey = "spend" | "impressions" | "cpm" | "ctr" | "cpc" | "cpa" | "roas";
type SortDir = "asc" | "desc";

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MonthlyPage() {
  const { creatives, isLoading, error, dateRange, setDatePreset, isRealData } =
    useCreativesContext();

  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [formatFilter, setFormatFilter] = useState<string>("all");

  const handleMount = () => {
    setDatePreset(30);
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
      return { spend: 0, impressions: 0, clicks: 0, conversions: 0, cpm: 0, ctr: 0, cpc: 0, cpa: 0, roas: 0 };

    const spend = metaCreatives.reduce((s, c) => s + c.spend, 0);
    const impressions = metaCreatives.reduce((s, c) => s + (c.impressions ?? 0), 0);
    const clicks = metaCreatives.reduce((s, c) => s + (c.clicks ?? 0), 0);
    const conversions = metaCreatives.reduce((s, c) => s + (c.conversions ?? 0), 0);
    const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
    const cpc = clicks > 0 ? spend / clicks : 0;
    const cpa = conversions > 0 ? spend / conversions : 0;
    const roas =
      spend > 0
        ? metaCreatives.reduce((s, c) => s + c.roas * c.spend, 0) / spend
        : 0;

    return { spend, impressions, clicks, conversions, cpm, ctr, cpc, cpa, roas };
  }, [metaCreatives]);

  // Top performers: Winners or Active, sorted by ROAS, top 3
  const topPerformers = useMemo(
    () =>
      [...metaCreatives]
        .filter((c) => (c.status === "Winner" || c.status === "Active") && c.spend > 0)
        .sort((a, b) => b.roas - a.roas)
        .slice(0, 3),
    [metaCreatives]
  );

  // Fatigued creatives that need attention
  const fatigued = useMemo(
    () => metaCreatives.filter((c) => c.status === "Fatigued").sort((a, b) => b.spend - a.spend),
    [metaCreatives]
  );

  // Sortable table
  const sortedCreatives = useMemo(() => {
    return [...metaCreatives].sort((a, b) => {
      const impressionsA = a.impressions ?? 0;
      const impressionsB = b.impressions ?? 0;
      const clicksA = a.clicks ?? 0;
      const clicksB = b.clicks ?? 0;

      let valA: number;
      let valB: number;

      switch (sortKey) {
        case "spend":
          valA = a.spend;
          valB = b.spend;
          break;
        case "impressions":
          valA = impressionsA;
          valB = impressionsB;
          break;
        case "cpm":
          valA = impressionsA > 0 ? (a.spend / impressionsA) * 1000 : 0;
          valB = impressionsB > 0 ? (b.spend / impressionsB) * 1000 : 0;
          break;
        case "ctr":
          valA = impressionsA > 0 ? (clicksA / impressionsA) * 100 : 0;
          valB = impressionsB > 0 ? (clicksB / impressionsB) * 100 : 0;
          break;
        case "cpc":
          valA = clicksA > 0 ? a.spend / clicksA : 0;
          valB = clicksB > 0 ? b.spend / clicksB : 0;
          break;
        case "cpa":
          valA = a.cpa ?? 0;
          valB = b.cpa ?? 0;
          break;
        case "roas":
          valA = a.roas ?? 0;
          valB = b.roas ?? 0;
          break;
        default:
          valA = a.spend;
          valB = b.spend;
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
    const header = ["Name", "Format", "Spend", "Impressions", "CPM", "CTR", "CPC", "CPA", "ROAS", "Status"];
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
        c.status,
      ].join(",");
    });
    const csv = [header.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `monthly-${dateRange.since}-${dateRange.until}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Top 6 creatives for visual grid
  const topVisuals = useMemo(
    () => [...metaCreatives].sort((a, b) => b.spend - a.spend).slice(0, 6),
    [metaCreatives]
  );

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

  const statusColor: Record<string, string> = {
    Winner: "text-emerald-400",
    Loser: "text-red-400",
    Fatigued: "text-amber-400",
    Active: "text-blue-400",
  };

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
              Reset to 30 days
            </button>
          </div>
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
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 mb-6">
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
          <KpiCard
            label="Conversions"
            value={totals.conversions > 0 ? totals.conversions.toLocaleString() : "—"}
            sub="30-day total"
            icon={Target}
            accent="bg-orange-600"
          />
        </div>

        {/* Top performers spotlight */}
        {topPerformers.length > 0 && (
          <div className="mb-6">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Top Performers This Month
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {topPerformers.map((c) => {
                const impressions = c.impressions ?? 0;
                const clicks = c.clicks ?? 0;
                const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
                return (
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
                        <span>CTR {fmt(ctr)}%</span>
                        {c.cpa > 0 && (
                          <>
                            <span>·</span>
                            <span>CPA {fmtCurrency(c.cpa)}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Fatigued creatives alert */}
        {fatigued.length > 0 && (
          <div className="mb-6">
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <h2 className="text-xs font-semibold text-amber-400 uppercase tracking-wider">
                  {fatigued.length} Fatigued Creative{fatigued.length > 1 ? "s" : ""} — Consider Refreshing
                </h2>
              </div>
              <div className="flex flex-wrap gap-2">
                {fatigued.slice(0, 5).map((c) => (
                  <div
                    key={c.id}
                    className="bg-[#111118] border border-amber-500/20 rounded-lg px-3 py-2 text-xs"
                  >
                    <span className="text-white font-medium truncate max-w-[150px] inline-block align-middle" title={c.name}>
                      {c.name}
                    </span>
                    <span className="text-gray-500 ml-2">{fmtCurrency(c.spend)} spent</span>
                    <span className="text-amber-400 ml-2">{fmt(c.roas)}×</span>
                  </div>
                ))}
              </div>
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
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search creatives…"
                className="text-xs bg-[#1a1a24] border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 w-44"
              />
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
                  <th className={thClass("spend")} onClick={() => handleSort("spend")}>
                    Spend<SortIcon col="spend" />
                  </th>
                  <th className={thClass("impressions")} onClick={() => handleSort("impressions")}>
                    Impressions<SortIcon col="impressions" />
                  </th>
                  <th className={thClass("cpm")} onClick={() => handleSort("cpm")}>
                    CPM<SortIcon col="cpm" />
                  </th>
                  <th className={thClass("ctr")} onClick={() => handleSort("ctr")}>
                    CTR<SortIcon col="ctr" />
                  </th>
                  <th className={thClass("cpc")} onClick={() => handleSort("cpc")}>
                    CPC<SortIcon col="cpc" />
                  </th>
                  <th className={thClass("cpa")} onClick={() => handleSort("cpa")}>
                    CPA<SortIcon col="cpa" />
                  </th>
                  <th className={thClass("roas")} onClick={() => handleSort("roas")}>
                    ROAS<SortIcon col="roas" />
                  </th>
                  <th className="text-right px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredCreatives.length === 0 && !isLoading && (
                  <tr>
                    <td colSpan={9} className="text-center py-12 text-gray-600 text-xs">
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
                      <td className={`text-right px-5 py-3 text-xs font-medium ${statusColor[c.status] ?? "text-gray-400"}`}>
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
