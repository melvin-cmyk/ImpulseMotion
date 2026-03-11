"use client";

import { useMemo, useState } from "react";
import { useCreativesContext } from "@/lib/creatives-context";
import { Creative } from "@/lib/mock-data";
import { DateRangePicker } from "@/components/date-range-picker";
import {
  Globe,
  DollarSign,
  TrendingDown,
  Lightbulb,
  ExternalLink,
  Image as ImageIcon,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface LandingPageGroup {
  domain: string;
  displayUrl: string;
  count: number;
  spend: number;
  avgCpa: number;
  bestCreative: Creative | null;
  creatives: Creative[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Extract a domain + path label from a URL string.
 * Falls back to the raw string if parsing fails.
 */
function extractDisplayUrl(url: string): { domain: string; display: string } {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const domain = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const display = path.length > 30 ? `${domain}${path.slice(0, 28)}…` : `${domain}${path}`;
    return { domain, display };
  } catch {
    const short = url.length > 40 ? `${url.slice(0, 38)}…` : url;
    return { domain: url, display: short };
  }
}

/**
 * Group creatives by their destination URL.
 * Since the Creative type does not carry a dedicated destinationUrl field,
 * we derive a URL from the creative name heuristically (or fall back to a
 * placeholder key) so the page degrades gracefully when no URL data is
 * available.
 *
 * When real URL data becomes available (e.g. added to the Creative type as
 * `destinationUrl`), replace the key derivation below with:
 *   const key = c.destinationUrl ?? "unknown";
 */
function groupByLandingPage(creatives: Creative[]): LandingPageGroup[] {
  const map = new Map<string, Creative[]>();

  for (const c of creatives) {
    // Use destinationUrl if the field exists in the future; otherwise derive
    // a synthetic key from the creative name so we still show something useful.
    const url: string =
      (c as unknown as Record<string, unknown>).destinationUrl as string ||
      (c as unknown as Record<string, unknown>).website_url as string ||
      "";

    const key = url || "unknown";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(c);
  }

  return Array.from(map.entries())
    .map(([rawUrl, items]) => {
      const totalSpend = items.reduce((s, c) => s + c.spend, 0);
      const cpas = items.filter((c) => c.cpa > 0).map((c) => c.cpa);
      const avgCpa = cpas.length > 0 ? cpas.reduce((s, v) => s + v, 0) / cpas.length : 0;
      const bestCreative = [...items].sort((a, b) => b.spend - a.spend)[0] ?? null;

      const { domain, display } =
        rawUrl === "unknown"
          ? { domain: "N/A", display: "URL non disponible" }
          : extractDisplayUrl(rawUrl);

      return {
        domain,
        displayUrl: display,
        count: items.length,
        spend: Math.round(totalSpend),
        avgCpa: Math.round(avgCpa * 100) / 100,
        bestCreative,
        creatives: items,
      };
    })
    .sort((a, b) => b.spend - a.spend);
}

// ── AI Insights panel ──────────────────────────────────────────────────────────

function InsightsPanel({ groups }: { groups: LandingPageGroup[] }) {
  const topGroup = groups[0];
  const totalSpend = groups.reduce((s, g) => s + g.spend, 0);
  const hasUrls = groups.some((g) => g.domain !== "N/A");

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-5 w-64 shrink-0">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-violet-600/20 flex items-center justify-center">
          <Lightbulb className="w-4 h-4 text-violet-400" />
        </div>
        <h2 className="text-sm font-semibold text-white">AI Insights</h2>
      </div>

      {!hasUrls && (
        <div className="text-xs text-gray-500 bg-gray-800/50 rounded-xl px-3 py-2.5">
          Les URLs de destination ne sont pas encore disponibles dans les données. Elles apparaîtront
          automatiquement quand le champ <code className="text-gray-400">destinationUrl</code> sera
          renseigné dans l&apos;API.
        </div>
      )}

      {hasUrls && topGroup && (
        <>
          <div className="space-y-1.5">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Meilleure landing page</p>
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-3 py-2.5">
              <p className="text-xs font-semibold text-emerald-400 truncate">{topGroup.displayUrl}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {topGroup.count} créa{topGroup.count !== 1 ? "s" : ""} · $
                {topGroup.spend >= 1000
                  ? `${(topGroup.spend / 1000).toFixed(1)}k`
                  : topGroup.spend}{" "}
                spend
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Répartition du spend</p>
            <div className="space-y-1.5">
              {groups.slice(0, 5).map((g) => {
                const pct = totalSpend > 0 ? (g.spend / totalSpend) * 100 : 0;
                return (
                  <div key={g.displayUrl} className="space-y-0.5">
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400 truncate max-w-[120px]">{g.displayUrl}</span>
                      <span className="text-white font-medium">{pct.toFixed(0)}%</span>
                    </div>
                    <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-violet-500 to-purple-600"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      <div className="space-y-2">
        <p className="text-xs text-gray-500 uppercase tracking-wide">Thought starters</p>
        {[
          "Quelle landing page convertit le mieux ?",
          "Y a-t-il une URL qui draine le budget sans résultats ?",
          "Combiner créas gagnantes sur top LP ?",
        ].map((q) => (
          <button
            key={q}
            className="w-full text-left px-3 py-2 rounded-xl bg-gray-800/60 hover:bg-gray-800 border border-gray-700/50 text-xs text-gray-300 hover:text-white transition-colors"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Landing page card ──────────────────────────────────────────────────────────

const ACCENT_COLORS = [
  "from-violet-500/20 to-violet-900/10 border-violet-500/30",
  "from-blue-500/20 to-blue-900/10 border-blue-500/30",
  "from-emerald-500/20 to-emerald-900/10 border-emerald-500/30",
  "from-pink-500/20 to-pink-900/10 border-pink-500/30",
  "from-amber-500/20 to-amber-900/10 border-amber-500/30",
  "from-cyan-500/20 to-cyan-900/10 border-cyan-500/30",
];

function LandingPageCard({
  group,
  index,
  totalSpend,
}: {
  group: LandingPageGroup;
  index: number;
  totalSpend: number;
}) {
  const spendPct = totalSpend > 0 ? (group.spend / totalSpend) * 100 : 0;
  const accentClass = ACCENT_COLORS[index % ACCENT_COLORS.length];
  const best = group.bestCreative;

  return (
    <div className={`bg-gradient-to-br ${accentClass} border rounded-2xl p-4 space-y-3`}>
      {/* Best creative thumbnail */}
      <div className="h-28 rounded-xl overflow-hidden bg-gray-800 flex items-center justify-center relative">
        {best?.thumbnailUrl ? (
          <img src={best.thumbnailUrl} alt={best.name} className="w-full h-full object-cover" />
        ) : best ? (
          <div
            className={`w-full h-full bg-gradient-to-br ${best.thumbnailColor} flex items-center justify-center`}
          >
            <ImageIcon className="w-6 h-6 text-white/40" />
          </div>
        ) : (
          <Globe className="w-8 h-8 text-gray-600" />
        )}
        {index === 0 && (
          <div className="absolute top-2 left-2 bg-violet-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
            #1
          </div>
        )}
      </div>

      {/* URL */}
      <div className="flex items-start gap-1.5">
        <Globe className="w-3.5 h-3.5 text-gray-500 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white truncate leading-tight">
            {group.displayUrl}
          </p>
          <p className="text-[10px] text-gray-500 mt-0.5">{group.count} créa{group.count !== 1 ? "s" : ""} actives</p>
        </div>
      </div>

      {/* Spend bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-400">
          <span>Spend</span>
          <span className="font-medium text-white">
            ${group.spend >= 1000 ? `${(group.spend / 1000).toFixed(1)}k` : group.spend}
          </span>
        </div>
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-500 to-purple-600"
            style={{ width: `${Math.min(spendPct, 100)}%` }}
          />
        </div>
        <p className="text-xs text-gray-500">{spendPct.toFixed(1)}% du budget</p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-2 pt-1">
        <div>
          <div className="text-[10px] text-gray-500 mb-0.5 flex items-center gap-1">
            <DollarSign className="w-3 h-3" />
            Spend total
          </div>
          <div className="text-sm font-semibold text-white">
            ${group.spend >= 1000 ? `${(group.spend / 1000).toFixed(1)}k` : group.spend}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 mb-0.5 flex items-center gap-1">
            <TrendingDown className="w-3 h-3" />
            CPA moyen
          </div>
          <div className={`text-sm font-semibold ${group.avgCpa > 0 ? "text-white" : "text-gray-600"}`}>
            {group.avgCpa > 0 ? `$${group.avgCpa.toFixed(0)}` : "N/A"}
          </div>
        </div>
      </div>

      {/* Best creative name */}
      {best && (
        <div className="flex items-center gap-1.5 text-[10px] text-gray-500 bg-gray-800/50 rounded-lg px-2 py-1 truncate">
          <ExternalLink className="w-3 h-3 shrink-0" />
          <span className="truncate">Top: {best.name}</span>
        </div>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function TopLandingPagePage() {
  const { creatives, isLoading } = useCreativesContext();

  const groups = useMemo(() => groupByLandingPage(creatives), [creatives]);
  const totalSpend = useMemo(() => groups.reduce((s, g) => s + g.spend, 0), [groups]);

  const hasUrlData = useMemo(() => groups.some((g) => g.domain !== "N/A"), [groups]);

  return (
    <div className="flex-1 overflow-y-auto bg-[#09090f]">
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              <Globe className="w-6 h-6 text-violet-400" />
              Top Landing Pages
            </h1>
            <p className="text-gray-400 text-sm mt-1">
              Quelles landing pages génèrent le meilleur retour sur spend ?
            </p>
          </div>
          <DateRangePicker />
        </div>

        {/* Summary KPIs */}
        {!isLoading && groups.length > 0 && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
              <div className="flex items-center gap-2 text-gray-400 text-xs mb-1">
                <Globe className="w-3.5 h-3.5" />
                Landing pages
              </div>
              <div className="text-2xl font-bold text-white">{hasUrlData ? groups.length : "—"}</div>
              <div className="text-xs text-gray-500 mt-0.5">{creatives.length} créas total</div>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
              <div className="flex items-center gap-2 text-gray-400 text-xs mb-1">
                <DollarSign className="w-3.5 h-3.5" />
                Budget total
              </div>
              <div className="text-2xl font-bold text-white">
                ${totalSpend >= 1000 ? `${(totalSpend / 1000).toFixed(1)}k` : totalSpend}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">sur la période</div>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
              <div className="flex items-center gap-2 text-gray-400 text-xs mb-1">
                <TrendingDown className="w-3.5 h-3.5" />
                Meilleur CPA
              </div>
              <div className="text-2xl font-bold text-emerald-400">
                {hasUrlData && groups[0]?.avgCpa > 0
                  ? `$${groups[0].avgCpa.toFixed(0)}`
                  : "—"}
              </div>
              <div className="text-xs text-gray-500 mt-0.5 truncate">
                {hasUrlData ? groups[0]?.displayUrl : "URL non disponible"}
              </div>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
              <div className="flex items-center gap-2 text-gray-400 text-xs mb-1">
                <ExternalLink className="w-3.5 h-3.5" />
                Top spend
              </div>
              <div className="text-2xl font-bold text-white">
                {hasUrlData && groups[0]
                  ? `$${groups[0].spend >= 1000 ? `${(groups[0].spend / 1000).toFixed(1)}k` : groups[0].spend}`
                  : "—"}
              </div>
              <div className="text-xs text-gray-500 mt-0.5 truncate">
                {hasUrlData ? groups[0]?.displayUrl : "—"}
              </div>
            </div>
          </div>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="text-center py-16 text-gray-500 text-sm">Chargement...</div>
        )}

        {/* No URL data notice */}
        {!isLoading && !hasUrlData && creatives.length > 0 && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-6 text-center space-y-2">
            <Globe className="w-10 h-10 mx-auto text-amber-500/50" />
            <p className="text-amber-300 font-medium text-sm">URLs de destination non disponibles</p>
            <p className="text-gray-500 text-xs max-w-md mx-auto">
              Les landing pages apparaîtront ici quand le champ{" "}
              <code className="text-gray-400">destinationUrl</code> ou{" "}
              <code className="text-gray-400">website_url</code> sera disponible dans les données
              renvoyées par l&apos;API Meta.
            </p>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && creatives.length === 0 && (
          <div className="text-center py-16 space-y-2">
            <Globe className="w-10 h-10 mx-auto text-gray-700" />
            <p className="text-gray-500 text-sm">Aucune créa trouvée.</p>
            <p className="text-xs text-gray-600">
              Connectez votre compte Meta pour voir vos landing pages.
            </p>
          </div>
        )}

        {/* Main layout: cards + insights */}
        {!isLoading && groups.length > 0 && (
          <div className="flex gap-6 items-start">
            {/* Cards grid */}
            <div className="flex-1 min-w-0">
              {hasUrlData ? (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                  {groups.map((group, i) => (
                    <LandingPageCard
                      key={group.displayUrl}
                      group={group}
                      index={i}
                      totalSpend={totalSpend}
                    />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 opacity-50 pointer-events-none">
                  {groups.slice(0, 5).map((group, i) => (
                    <LandingPageCard
                      key={i}
                      group={group}
                      index={i}
                      totalSpend={totalSpend}
                    />
                  ))}
                </div>
              )}

              {/* Table view */}
              {hasUrlData && groups.length > 0 && (
                <div className="mt-6 bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-800">
                    <h2 className="text-sm font-semibold text-white">Vue tableau</h2>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-gray-500 text-xs uppercase tracking-wide border-b border-gray-800">
                          <th className="text-left py-3 px-4">Landing Page</th>
                          <th className="text-right py-3 px-4">Créas</th>
                          <th className="text-right py-3 px-4">Spend</th>
                          <th className="text-right py-3 px-4">Budget %</th>
                          <th className="text-right py-3 px-4">CPA moyen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groups.map((g, i) => (
                          <tr
                            key={g.displayUrl}
                            className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors ${
                              i === 0 ? "bg-violet-900/10" : ""
                            }`}
                          >
                            <td className="py-3 px-4">
                              <div className="flex items-center gap-2">
                                <Globe className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                                <span className="font-medium text-white truncate max-w-xs">
                                  {g.displayUrl}
                                </span>
                              </div>
                            </td>
                            <td className="py-3 px-4 text-right text-gray-300">{g.count}</td>
                            <td className="py-3 px-4 text-right text-gray-300">
                              ${g.spend >= 1000 ? `${(g.spend / 1000).toFixed(1)}k` : g.spend}
                            </td>
                            <td className="py-3 px-4 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-violet-500 rounded-full"
                                    style={{
                                      width: `${Math.min((g.spend / totalSpend) * 100, 100)}%`,
                                    }}
                                  />
                                </div>
                                <span className="text-gray-400 text-xs w-10 text-right">
                                  {((g.spend / totalSpend) * 100).toFixed(0)}%
                                </span>
                              </div>
                            </td>
                            <td className="py-3 px-4 text-right text-gray-300">
                              {g.avgCpa > 0 ? `$${g.avgCpa.toFixed(0)}` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* AI Insights sidebar */}
            <InsightsPanel groups={groups} />
          </div>
        )}
      </div>
    </div>
  );
}
