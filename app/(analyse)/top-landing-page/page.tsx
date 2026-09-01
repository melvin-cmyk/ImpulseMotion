"use client";

import { useMemo, useState } from "react";
import type { Creative } from "@/lib/creative-types";
import { useCreativesContext, useMoney } from "@/lib/creatives-context";
import { byLandingPage, sortGroups, NO_URL_KEY, type Group, type LandingPageMeta, type RankMetric } from "@/lib/creative-stats";
import { fmtPct, fmtInt, plural } from "@/lib/creative-format";
import { DateRangePicker } from "@/components/date-range-picker";
import { Globe, ExternalLink, ChevronDown, ChevronUp, MousePointerClick, ShoppingBag, DollarSign } from "lucide-react";
import { PageHelp } from "@/components/ui/page-help";
import { Kpi, PageHeader, Section } from "@/components/ui/surface";
import { MetricInfoButton } from "@/components/metric-info-button";
import { GroupAdsList } from "@/components/group-ads-list";
import { CreativeModal } from "@/components/creative-modal";
import { RoasValue } from "@/components/roas-value";
import { cn } from "@/lib/utils";

type SortKey = RankMetric | "count" | "clicks" | "conversionRate";

const COLUMNS: { key: SortKey; label: string; metricKey?: string; asc?: boolean }[] = [
  { key: "count", label: "Annonces" },
  { key: "spend", label: "Spend", metricKey: "spend" },
  { key: "clicks", label: "Clics" },
  { key: "ctr", label: "CTR", metricKey: "ctr" },
  { key: "conversions", label: "Achats" },
  { key: "cpa", label: "CPA", metricKey: "cpa", asc: true },
  { key: "roas", label: "ROAS", metricKey: "roas" },
  { key: "conversionRate", label: "Taux conv." },
];

function sortLanding(groups: Group<LandingPageMeta>[], key: SortKey, asc: boolean): Group<LandingPageMeta>[] {
  const known = groups.filter((g) => g.key !== NO_URL_KEY);
  const unknown = groups.filter((g) => g.key === NO_URL_KEY);
  let sorted: Group<LandingPageMeta>[];
  if (key === "clicks" || key === "conversionRate") {
    sorted = [...known].sort((a, b) => {
      const av = a.stats[key];
      const bv = b.stats[key];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return asc ? av - bv : bv - av;
    });
  } else {
    sorted = sortGroups(known, key, asc);
  }
  return [...sorted, ...unknown];
}

export default function TopLandingPagePage() {
  const { creatives, isLoading, isRealData } = useCreativesContext();
  const money = useMoney();
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortAsc, setSortAsc] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Creative | null>(null);

  const groups = useMemo(() => byLandingPage(creatives), [creatives]);
  const sorted = useMemo(() => sortLanding(groups, sortKey, sortAsc), [groups, sortKey, sortAsc]);
  const totalSpend = useMemo(() => groups.reduce((s, g) => s + g.stats.spend, 0), [groups]);
  const known = groups.filter((g) => g.key !== NO_URL_KEY);
  const unknown = groups.find((g) => g.key === NO_URL_KEY) ?? null;
  const bestCpa = useMemo(() => sortGroups(known.filter((g) => g.stats.cpa !== null), "cpa", true)[0] ?? null, [known]);
  const totalConversions = groups.reduce((s, g) => s + g.stats.conversions, 0);

  function toggleSort(key: SortKey) {
    const col = COLUMNS.find((c) => c.key === key);
    if (sortKey === key) setSortAsc((a) => !a);
    else {
      setSortKey(key);
      setSortAsc(!!col?.asc);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-950">
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        <PageHelp
          title="Top Landing Pages — Quelle page de destination convertit le mieux ?"
          description="Les annonces sont regroupées par URL de destination (hôte + chemin, sans paramètres de tracking). Spend, clics et achats sont cumulés par page ; CTR, CPA, ROAS et taux de conversion sont recalculés sur ces totaux."
          steps={[
            "Trie par CPA ou taux de conversion pour identifier la page qui transforme le mieux le trafic payé.",
            "Compare le spend et les achats : une page qui absorbe le budget sans achats mérite un test d'alternative.",
            "Déplie une ligne pour voir les annonces qui pointent vers cette page et ouvrir chaque créa.",
          ]}
          tip="Le taux de conversion = achats / clics. Un ROAS suivi d'un astérisque est estimé à partir du panier moyen."
        />

        <PageHeader
          title="Top Landing Pages"
          subtitle={
            isRealData
              ? `${plural(known.length, "page de destination", "pages de destination")} sur ${plural(creatives.length, "annonce")}`
              : "Données de démonstration — connecte un compte Meta pour tes vraies URLs"
          }
          action={<DateRangePicker />}
        />

        {!isLoading && creatives.length > 0 && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi
              label="Landing pages"
              value={known.length}
              icon={<Globe className="w-4 h-4" />}
              sub={unknown ? `${plural(unknown.stats.count, "annonce")} sans URL` : undefined}
            />
            <Kpi label="Spend total" value={money(totalSpend)} icon={<DollarSign className="w-4 h-4" />} accent="gray" />
            <Kpi label="Achats" value={fmtInt(totalConversions)} icon={<ShoppingBag className="w-4 h-4" />} accent="blue" />
            <Kpi
              label="Meilleur CPA"
              value={bestCpa ? money(bestCpa.stats.cpa, 2) : "—"}
              sub={bestCpa ? bestCpa.label : "aucun achat attribué"}
              icon={<MousePointerClick className="w-4 h-4" />}
              accent="emerald"
            />
          </div>
        )}

        {isLoading ? (
          <div className="text-center py-16 text-gray-500 text-sm">Chargement…</div>
        ) : creatives.length === 0 ? (
          <div className="text-center py-16 space-y-2">
            <Globe className="w-10 h-10 mx-auto text-gray-700" />
            <p className="text-gray-500 text-sm">Aucune annonce sur la période.</p>
          </div>
        ) : (
          <Section title="Performance par landing page" icon={<Globe className="w-4 h-4 text-violet-400" />} bodyClassName="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs border-b border-gray-800">
                  <th className="text-left py-3 px-4 font-medium">Landing page</th>
                  {COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      className="text-right py-3 px-3 font-medium cursor-pointer hover:text-gray-300 whitespace-nowrap"
                      onClick={() => toggleSort(col.key)}
                    >
                      <span className="inline-flex items-center gap-1">
                        {col.label}
                        {col.metricKey && <MetricInfoButton metricKey={col.metricKey} />}
                        {sortKey === col.key ? (
                          sortAsc ? <ChevronUp className="w-3 h-3 text-violet-400" /> : <ChevronDown className="w-3 h-3 text-violet-400" />
                        ) : (
                          <ChevronUp className="w-3 h-3 opacity-30" />
                        )}
                      </span>
                    </th>
                  ))}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((g, i) => {
                  const isUnknown = g.key === NO_URL_KEY;
                  const share = totalSpend > 0 ? (g.stats.spend / totalSpend) * 100 : 0;
                  const isOpen = expanded === g.key;
                  return (
                    <RowGroup key={g.key}>
                      <tr
                        className={cn(
                          "border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors cursor-pointer",
                          i === 0 && !isUnknown && sortKey === "spend" && !sortAsc && "bg-violet-900/10",
                          isUnknown && "opacity-60",
                        )}
                        onClick={() => setExpanded(isOpen ? null : g.key)}
                      >
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2 min-w-0">
                            <Globe className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                            <div className="min-w-0">
                              {g.meta.url ? (
                                <a
                                  href={g.meta.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="font-medium text-white hover:text-violet-300 inline-flex items-center gap-1 truncate max-w-xs"
                                  title={g.meta.url}
                                >
                                  <span className="truncate">{g.label}</span>
                                  <ExternalLink className="w-3 h-3 shrink-0 text-gray-500" />
                                </a>
                              ) : (
                                <span className="italic text-gray-500">{g.label}</span>
                              )}
                              <div className="flex items-center gap-2 mt-1">
                                <div className="w-16 h-1 bg-gray-800 rounded-full overflow-hidden">
                                  <div className="h-full bg-violet-500 rounded-full" style={{ width: `${Math.min(share, 100)}%` }} />
                                </div>
                                <span className="text-[10px] text-gray-500">{share.toFixed(0)}% du spend</span>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right text-gray-300">{g.stats.count}</td>
                        <td className="py-3 px-3 text-right text-gray-200 font-medium">{money(g.stats.spend)}</td>
                        <td className="py-3 px-3 text-right text-gray-300">{fmtInt(g.stats.clicks)}</td>
                        <td className="py-3 px-3 text-right text-gray-300">{fmtPct(g.stats.ctr)}</td>
                        <td className="py-3 px-3 text-right text-gray-300">{fmtInt(g.stats.conversions)}</td>
                        <td className="py-3 px-3 text-right text-gray-200">{money(g.stats.cpa, 2)}</td>
                        <td className="py-3 px-3 text-right font-semibold">
                          <RoasValue value={g.stats.roas} estimated={g.stats.estimated} tone />
                        </td>
                        <td className="py-3 px-3 text-right text-gray-300">{fmtPct(g.stats.conversionRate)}</td>
                        <td className="py-3 px-2 text-gray-500">
                          {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-gray-800/50 bg-gray-950/40">
                          <td colSpan={COLUMNS.length + 2} className="p-4">
                            <GroupAdsList creatives={g.creatives} onSelect={setSelected} />
                          </td>
                        </tr>
                      )}
                    </RowGroup>
                  );
                })}
              </tbody>
            </table>
          </Section>
        )}
      </div>

      <CreativeModal creative={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

/** Fragment wrapper so a group row + its expanded row share one key. */
function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
