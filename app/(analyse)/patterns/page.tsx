"use client";

import { useMemo, useState } from "react";
import type { Creative } from "@/lib/creative-types";
import { useCreativesContext, useMoney } from "@/lib/creatives-context";
import { Layers, TrendingUp, DollarSign, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNamingConfig } from "@/lib/use-naming-config";
import { bySegment, UNCATEGORIZED_KEY } from "@/lib/creative-stats";
import { fmtPct } from "@/lib/creative-format";
import { PageHelp } from "@/components/ui/page-help";
import { Card, PageHeader } from "@/components/ui/surface";
import { MetricInfoButton } from "@/components/metric-info-button";
import { RoasValue } from "@/components/roas-value";

function ThumbnailCluster({ creatives }: { creatives: Creative[] }) {
  const withUrl = creatives.filter((c) => c.thumbnailUrl).slice(0, 3);
  const shown = withUrl.length > 0 ? withUrl : creatives.slice(0, 3);
  return (
    <div className="flex -space-x-2 mb-3">
      {shown.map((c) =>
        c.thumbnailUrl ? (
          <div key={c.id} className="w-10 h-10 rounded-lg border-2 border-gray-900 overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.thumbnailUrl} alt="" className="w-full h-full object-cover" />
          </div>
        ) : (
          <div key={c.id} className={`w-10 h-10 rounded-lg border-2 border-gray-900 bg-gradient-to-br ${c.thumbnailColor}`} />
        ),
      )}
    </div>
  );
}

export default function PatternsPage() {
  const { creatives, isLoading } = useCreativesContext();
  const money = useMoney();
  const namingConfig = useNamingConfig();
  const [activeSegmentIdx, setActiveSegmentIdx] = useState(0);

  const activeSegment = namingConfig.segments[activeSegmentIdx];

  const groups = useMemo(() => {
    if (!activeSegment) return [];
    return bySegment(creatives, namingConfig, activeSegmentIdx);
  }, [creatives, namingConfig, activeSegment, activeSegmentIdx]);

  const maxSpend = groups[0]?.stats.spend || 1;

  return (
    <div className="flex-1 overflow-auto bg-gray-950 p-6 space-y-6">
      <PageHelp
        title="Patterns — Segments gagnants de ta naming"
        description="Chaque onglet regroupe les annonces par valeur d'un segment de ta naming convention (produit, format, angle…). Spend, clics et achats sont cumulés par valeur pour comparer ce qui fonctionne vraiment."
        steps={[
          "Configure d'abord ta naming convention sur la page Naming (séparateur, segments, positions).",
          "Sélectionne un segment via les onglets pour voir les stats agrégées par valeur.",
          "Repère les cartes « Proven » (Hit Rate ≥ 30 %) : ce sont tes patterns à dupliquer.",
        ]}
        tip="Le Hit Rate est le pourcentage de créas Winner dans le groupe. Un segment avec ROAS élevé et Hit Rate ≥ 30 % est une base solide pour briefer l'équipe créa."
      />

      <PageHeader
        title="Patterns"
        subtitle={
          activeSegment
            ? `Segment « ${activeSegment.label} » — position ${activeSegment.position + 1}, séparateur « ${namingConfig.separator} »`
            : "Analyse de tes créas par segment de naming"
        }
      />

      {namingConfig.segments.length > 0 && (
        <div className="flex gap-1 bg-gray-900 rounded-xl p-1 w-fit">
          {namingConfig.segments.map((seg, idx) => (
            <button
              key={`${seg.label}-${idx}`}
              type="button"
              onClick={() => setActiveSegmentIdx(idx)}
              className={cn(
                "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                activeSegmentIdx === idx ? "bg-violet-600 text-white" : "text-gray-400 hover:text-gray-200",
              )}
            >
              {seg.label}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {groups.map((g) => {
          const isUnknown = g.key === UNCATEGORIZED_KEY;
          const { stats } = g;
          return (
            <Card key={g.key} padded interactive className={cn(isUnknown && "opacity-60")}>
              <div className="flex items-start justify-between mb-1">
                <ThumbnailCluster creatives={g.creatives} />
                {stats.hitRate >= 30 && !isUnknown && (
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                    <Trophy className="w-3 h-3" />Proven
                  </span>
                )}
              </div>
              <div className={cn("text-sm font-semibold truncate mb-0.5", isUnknown ? "text-gray-500 italic" : "text-gray-100")} title={g.label}>{g.label}</div>
              <div className="text-xs text-gray-500 mb-3">{stats.count} créa{stats.count > 1 ? "s" : ""} · {stats.winners} winner{stats.winners !== 1 ? "s" : ""}</div>

              <div className="space-y-1.5 mb-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500 flex items-center gap-1"><DollarSign className="w-3 h-3" />Spend <MetricInfoButton metricKey="spend" /></span>
                  <span className="text-gray-200 font-medium">{money(stats.spend)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500 flex items-center gap-1"><TrendingUp className="w-3 h-3" />ROAS <MetricInfoButton metricKey="roas" /></span>
                  <RoasValue value={stats.roas} estimated={stats.estimated} tone className="font-semibold" />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500 flex items-center gap-1">CPA <MetricInfoButton metricKey="cpa" /></span>
                  <span className="text-gray-200 font-medium">{money(stats.cpa, 2)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500 flex items-center gap-1">CTR <MetricInfoButton metricKey="ctr" /></span>
                  <span className="text-gray-200 font-medium">{fmtPct(stats.ctr)}</span>
                </div>
                {stats.videoCount > 0 && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500 flex items-center gap-1">Hook Rate <MetricInfoButton metricKey="hookRate" /></span>
                    <span className="text-gray-200 font-medium">{fmtPct(stats.hookRate, 1)}</span>
                  </div>
                )}
              </div>

              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-gray-500 flex items-center gap-1">Hit Rate <MetricInfoButton metricKey="hitRate" /></span>
                <span className={cn("font-semibold", stats.hitRate >= 30 ? "text-emerald-400" : stats.hitRate < 10 ? "text-red-400" : "text-amber-400")}>
                  {fmtPct(stats.hitRate, 0)}
                </span>
              </div>
              <div className="h-1 bg-gray-800 rounded-full overflow-hidden mb-2">
                <div
                  className={cn("h-full rounded-full", stats.hitRate >= 30 ? "bg-emerald-500" : stats.hitRate >= 10 ? "bg-amber-500" : "bg-red-500")}
                  style={{ width: `${Math.min(100, stats.hitRate)}%` }}
                />
              </div>

              <div className="h-1 bg-gray-800 rounded-full overflow-hidden" title="Part du spend vs. le segment le plus dépensier">
                <div className="h-full bg-violet-500 rounded-full" style={{ width: `${Math.min(100, (stats.spend / maxSpend) * 100)}%` }} />
              </div>
            </Card>
          );
        })}
      </div>

      {isLoading && <div className="text-center py-16 text-gray-500 text-sm">Chargement…</div>}
      {!isLoading && groups.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-gray-600">
          <Layers className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">Aucun pattern trouvé</p>
          {namingConfig.segments.length === 0 && <p className="text-xs mt-1">Configure ta naming convention sur la page Naming</p>}
        </div>
      )}
    </div>
  );
}
