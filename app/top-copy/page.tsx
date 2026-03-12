"use client";

import { useMemo, useState } from "react";
import { Creative, Status } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import { FileText, DollarSign, TrendingUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHelp } from "@/components/ui/page-help";

type FilterStatus = "all" | Status;
type SortKey = "spend" | "cpa" | "ctr" | "roas";

const STATUS_COLORS: Record<Status, string> = {
  Winner: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  Active: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  Fatigued: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  Loser: "bg-red-500/20 text-red-400 border-red-500/30",
};

export default function TopCopyPage() {
  const { creatives } = useCreativesContext();
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");
  const [sortKey, setSortKey] = useState<SortKey>("spend");

  const filters: { key: FilterStatus; label: string }[] = [
    { key: "all", label: "Tous" },
    { key: "Winner", label: "Winners" },
    { key: "Active", label: "Actifs" },
    { key: "Fatigued", label: "Fatigués" },
    { key: "Loser", label: "Losers" },
  ];

  const sortOptions: { key: SortKey; label: string }[] = [
    { key: "spend", label: "Spend" },
    { key: "cpa", label: "CPA" },
    { key: "ctr", label: "CTR" },
    { key: "roas", label: "ROAS" },
  ];

  const filtered = useMemo(() => {
    let items = filterStatus === "all" ? creatives : creatives.filter(c => c.status === filterStatus);
    return [...items].sort((a, b) => {
      if (sortKey === "spend") return b.spend - a.spend;
      if (sortKey === "cpa") return a.cpa - b.cpa;
      if (sortKey === "ctr") return b.ctr - a.ctr;
      if (sortKey === "roas") return b.roas - a.roas;
      return 0;
    });
  }, [creatives, filterStatus, sortKey]);

  return (
    <div className="flex-1 overflow-auto bg-gray-950 p-6">
      {/* Page Help */}
      <PageHelp
        title="Top Copy — Textes d'annonce qui convertissent"
        description="Vois quels textes d'annonce (headline et body copy) génèrent le plus d'engagement et de conversions. Identifie les formulations gagnantes pour briefer tes copywriters."
        steps={[
          "Filtre par statut (Winners, Actifs, Fatigués, Losers) pour te concentrer sur une catégorie spécifique.",
          "Trie par CTR pour voir quels textes attirent le plus de clics, ou par ROAS pour les plus rentables.",
          "Note les patterns de langage des créas Winners : longueur, ton, promesse, CTA — et reproduis-les.",
        ]}
        tip="Les créas sans texte affiché n'ont pas encore de headline/body renseigné dans les données Meta. Ces infos apparaissent automatiquement quand l'API les fournit."
      />
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 bg-violet-600/20 rounded-xl flex items-center justify-center">
          <FileText className="w-5 h-5 text-violet-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Top Copy</h1>
          <p className="text-xs text-gray-500">Performance des créas par nom et concept</p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        {/* Status filter */}
        <div className="flex gap-1 bg-gray-900 rounded-xl p-1">
          {filters.map(f => (
            <button
              key={f.key}
              onClick={() => setFilterStatus(f.key)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                filterStatus === f.key ? "bg-violet-600 text-white" : "text-gray-400 hover:text-gray-200"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-1 ml-auto">
          <ArrowUpDown className="w-3.5 h-3.5 text-gray-500" />
          <span className="text-xs text-gray-500 mr-1">Trier par</span>
          {sortOptions.map(s => (
            <button
              key={s.key}
              onClick={() => setSortKey(s.key)}
              className={cn(
                "px-2.5 py-1 rounded-lg text-xs font-medium transition-all",
                sortKey === s.key ? "bg-violet-600 text-white" : "bg-gray-900 text-gray-400 hover:text-gray-200"
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filtered.map(c => (
          <div key={c.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden hover:border-gray-700 transition-colors">
            {/* Thumbnail */}
            <div className="relative aspect-video bg-gray-800 overflow-hidden">
              {c.thumbnailUrl ? (
                <img src={c.thumbnailUrl} alt={c.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full" style={{ background: c.thumbnailColor }} />
              )}
              {/* Status badge */}
              <span className={cn(
                "absolute top-2 right-2 text-xs px-2 py-0.5 rounded-full border font-semibold",
                STATUS_COLORS[c.status]
              )}>
                {c.status}
              </span>
            </div>

            {/* Content */}
            <div className="p-3">
              <p className="text-xs text-gray-600 truncate mb-1" title={c.name}>
                {c.name}
              </p>

              {/* Copy text */}
              {c.headline ? (
                <p className="text-sm font-semibold text-gray-100 leading-snug mb-1 line-clamp-2" title={c.headline}>
                  {c.headline}
                </p>
              ) : null}
              {c.body ? (
                <p className="text-xs text-gray-400 leading-relaxed mb-2 line-clamp-2" title={c.body}>
                  {c.body}
                </p>
              ) : !c.headline ? (
                <p className="text-xs text-gray-600 italic mb-2">Aucun texte disponible</p>
              ) : <div className="mb-2" />}

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <p className="text-xs text-gray-500 mb-0.5">Spend</p>
                  <p className="text-xs font-semibold text-gray-200">${c.spend >= 1000 ? `${(c.spend / 1000).toFixed(1)}k` : c.spend.toFixed(0)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-0.5">CPA</p>
                  <p className="text-xs font-semibold text-gray-200">${c.cpa.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-0.5">CTR</p>
                  <p className="text-xs font-semibold text-gray-200">{c.ctr.toFixed(2)}%</p>
                </div>
              </div>

              {/* ROAS bar */}
              <div className="mt-2.5">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-gray-500">ROAS</span>
                  <span className={cn("font-semibold", c.roas >= 2 ? "text-emerald-400" : c.roas >= 1 ? "text-yellow-400" : "text-red-400")}>
                    {c.roas.toFixed(2)}x
                  </span>
                </div>
                <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={cn("h-full rounded-full", c.roas >= 2 ? "bg-emerald-500" : c.roas >= 1 ? "bg-yellow-500" : "bg-red-500")}
                    style={{ width: `${Math.min(100, (c.roas / 4) * 100)}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-gray-600">
          <FileText className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">Aucune créa trouvée</p>
        </div>
      )}
    </div>
  );
}
