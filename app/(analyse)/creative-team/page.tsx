"use client";

import { useMemo, useState } from "react";
import { useCreativesContext } from "@/lib/creatives-context";
import type { Creative } from "@/lib/creative-types";
import { calculateFunnelScores } from "@/lib/funnel-scores";
import { FunnelScoresBar } from "@/components/funnel-scores-bar";
import { Scissors, TrendingUp, Star, ChevronDown, ChevronUp } from "lucide-react";
import { PageHelp } from "@/components/ui/page-help";
import { MetricInfoButton } from "@/components/metric-info-button";
import { StatusBadge } from "@/components/status-badge";
import { RoasValue } from "@/components/roas-value";
import { fmtMoney, fmtRoas } from "@/lib/creative-format";
import { aggregate, median } from "@/lib/creative-stats";

type InsightType = "cut" | "scale" | "working" | null;

/** Known ROAS (null / unavailable → 0). */
const roasOf = (c: Creative) => (c.roas !== null && c.roas !== undefined && !c.roasUnavailable ? c.roas : 0);
const roasText = (c: Creative) => fmtRoas(c.roasUnavailable ? null : c.roas, { estimated: c.roasEstimated });

function getInsights(creatives: Creative[], type: InsightType, currency: string | null): string[] {
  if (!type || creatives.length === 0) return [];
  const medianSpend = median(creatives.filter((c) => c.spend > 0).map((c) => c.spend)) ?? 0;

  if (type === "cut") {
    const candidates = creatives
      .filter((c) => c.status === "Loser" || (c.cpa > 0 && c.ctr < 1 && roasOf(c) > 0 && roasOf(c) < 1.5))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 5);
    if (candidates.length === 0) return ["Aucune créa à couper détectée — bon boulot !"];
    return candidates.map(
      (c) =>
        `${c.name} — CPA ${c.cpa > 0 ? fmtMoney(c.cpa, currency, 2) : "—"}, CTR ${c.ctr.toFixed(1)}%, ROAS ${roasText(c)}`
    );
  }

  if (type === "scale") {
    // Known ROAS ≥ 2.5 with spend under the median of the list (currency-agnostic).
    const candidates = creatives
      .filter((c) => roasOf(c) >= 2.5 && c.spend < medianSpend && c.status !== "Loser")
      .sort((a, b) => roasOf(b) - roasOf(a))
      .slice(0, 5);
    if (candidates.length === 0)
      return ["Aucune opportunité de scale détectée pour l'instant."];
    return candidates.map(
      (c) =>
        `${c.name} — ROAS ${roasText(c)}, Spend ${fmtMoney(c.spend, currency)} (sous-exploité)`
    );
  }

  if (type === "working") {
    const winners = creatives.filter((c) => c.status === "Winner");
    if (winners.length === 0) return ["Pas encore de créas winner dans la période sélectionnée."];

    // Σ then ratio over the winners; hook weighted by impressions over videos only.
    const stats = aggregate(winners);

    const videoCount = winners.filter((c) => c.format === "Video").length;
    const imageCount = winners.filter((c) => c.format === "Image").length;
    const carouselCount = winners.filter((c) => c.format === "Carousel").length;

    const topFormat =
      videoCount >= imageCount && videoCount >= carouselCount
        ? "Vidéo"
        : imageCount >= carouselCount
        ? "Image"
        : "Carrousel";

    return [
      `${winners.length} créas winner sur ${creatives.length} testées`,
      `ROAS winners (Σ revenu / Σ spend) : ${fmtRoas(stats.unavailable ? null : stats.roas, { estimated: stats.estimated })}`,
      `CTR winners (Σ clics / Σ impressions) : ${stats.ctr !== null ? `${stats.ctr.toFixed(1)}%` : "—"}`,
      `Hook winners (pondéré, ${stats.videoCount} vidéo${stats.videoCount > 1 ? "s" : ""}) : ${stats.hookRate !== null ? `${stats.hookRate.toFixed(1)}%` : "—"}`,
      `Format dominant : ${topFormat} (${Math.max(videoCount, imageCount, carouselCount)} winners)`,
    ];
  }

  return [];
}

export default function CreativeTeamPage() {
  const { creatives, isLoading, currency } = useCreativesContext();
  const [activeInsight, setActiveInsight] = useState<InsightType>(null);

  const sorted = useMemo(
    () => [...creatives].sort((a, b) => b.spend - a.spend),
    [creatives]
  );

  const insights = useMemo(
    () => getInsights(creatives, activeInsight, currency),
    [creatives, activeInsight, currency]
  );

  const toggleInsight = (type: InsightType) => {
    setActiveInsight((prev) => (prev === type ? null : type));
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Chargement…
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-[#09090f] p-6">
      {/* Page Help */}
      <PageHelp
        title="Équipe Créa — Vue optimisée pour les créatifs"
        description="Partage les insights créa avec ton équipe production. Cette vue funnel est optimisée pour les créatifs et réalisateurs — pas pour les media buyers. Elle met en avant les scores Hook, CTR, et Conversion de chaque créa."
        steps={[
          "Utilise les boutons d'insight rapide ('Quelles créas couper ?', 'Opportunités de scale', 'Ce qui fonctionne') pour générer des recommandations.",
          "Parcours la liste des créas avec leur score funnel : Hook Rate, CTR et taux de conversion visualisés en barres.",
          "Partage cette page directement avec ton équipe créa pour qu'ils voient ce qui performe et pourquoi.",
        ]}
        tip="Cette page est conçue pour être partagée avec des créatifs qui ne comprennent pas forcément le ROAS. Les barres de score funnel parlent d'elles-mêmes : Hook bon, CTR faible = problème dans l'ad copy."
      />
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">Pour l&apos;équipe créa</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Vue funnel optimisée pour briefer l&apos;équipe créative
        </p>
      </div>

      {/* AI Insight buttons */}
      <div className="flex flex-wrap gap-2 mb-6">
        <InsightButton
          icon={<Scissors className="w-3.5 h-3.5" />}
          label="Quelles créas couper ?"
          active={activeInsight === "cut"}
          onClick={() => toggleInsight("cut")}
        />
        <InsightButton
          icon={<TrendingUp className="w-3.5 h-3.5" />}
          label="Opportunités de scale"
          active={activeInsight === "scale"}
          onClick={() => toggleInsight("scale")}
        />
        <InsightButton
          icon={<Star className="w-3.5 h-3.5" />}
          label="Ce qui fonctionne"
          active={activeInsight === "working"}
          onClick={() => toggleInsight("working")}
        />
      </div>

      {/* Insight panel */}
      {activeInsight && insights.length > 0 && (
        <div className="mb-6 bg-[#0d0d1a] border border-violet-500/20 rounded-xl p-4">
          <ul className="space-y-1.5">
            {insights.map((line, i) => (
              <li key={i} className="text-sm text-gray-300 flex gap-2">
                <span className="text-violet-400 mt-0.5">→</span>
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Creative list */}
      <div className="space-y-3">
        {sorted.map((creative) => {
          const scores = calculateFunnelScores(creative);
          return (
            <CreativeTeamCard key={creative.id} creative={creative} scores={scores} currency={currency} />
          );
        })}
      </div>
    </div>
  );
}

function InsightButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
        active
          ? "bg-violet-600 text-white"
          : "bg-[#0d0d1a] border border-white/5 text-gray-400 hover:text-white hover:border-white/10"
      }`}
    >
      {icon}
      {label}
      {active ? (
        <ChevronUp className="w-3 h-3" />
      ) : (
        <ChevronDown className="w-3 h-3" />
      )}
    </button>
  );
}

function CreativeTeamCard({
  creative,
  scores,
  currency,
}: {
  creative: Creative;
  scores: ReturnType<typeof calculateFunnelScores>;
  currency: string | null;
}) {
  return (
    <div className="bg-[#0d0d1a] border border-white/5 rounded-xl p-4 flex items-center gap-4 hover:border-white/10 transition-colors">
      {/* Thumbnail */}
      <div className="w-14 h-14 rounded-lg overflow-hidden shrink-0 bg-gray-900">
        {creative.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={creative.thumbnailUrl}
            alt={creative.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className={`w-full h-full bg-gradient-to-br ${creative.thumbnailColor}`} />
        )}
      </div>

      {/* Name + status */}
      <div className="w-48 shrink-0 min-w-0">
        <p className="text-sm font-medium text-white truncate">{creative.name}</p>
        <div className="flex items-center gap-2 mt-1">
          <StatusBadge status={creative.status} />
          <span className="text-[10px] text-gray-600">{creative.format}</span>
        </div>
        <p className="text-xs text-gray-500 mt-1 flex items-center gap-1 flex-wrap">
          <span className="inline-flex items-center gap-0.5">Spend <MetricInfoButton metricKey="spend" /></span>{" "}
          <span className="text-white font-medium">{fmtMoney(creative.spend, currency)}</span>{" "}
          · <span className="inline-flex items-center gap-0.5">ROAS <MetricInfoButton metricKey="roas" /></span>{" "}
          <RoasValue value={creative.spend > 0 && !creative.roasUnavailable ? creative.roas : null} estimated={creative.roasEstimated && !creative.roasUnavailable} className="text-white font-medium" />
        </p>
      </div>

      {/* Funnel scores */}
      <div className="flex-1">
        <FunnelScoresBar scores={scores} />
      </div>
    </div>
  );
}
