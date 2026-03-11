"use client";

import { useMemo, useState } from "react";
import { useCreativesContext } from "@/lib/creatives-context";
import { Creative } from "@/lib/mock-data";
import { calculateFunnelScores } from "@/lib/funnel-scores";
import { FunnelScoresBar } from "@/components/funnel-scores-bar";
import { Scissors, TrendingUp, Star, ChevronDown, ChevronUp } from "lucide-react";

type InsightType = "cut" | "scale" | "working" | null;

function fmt(n: number, style: "currency" | "percent" | "x" = "decimal" as never): string {
  if (!n || !isFinite(n)) return "—";
  if (style === "currency") {
    if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
    return `$${n.toFixed(0)}`;
  }
  if (style === "percent") return `${n.toFixed(1)}%`;
  if (style === "x") return `${n.toFixed(2)}x`;
  return String(n);
}

function getInsights(creatives: Creative[], type: InsightType): string[] {
  if (!type || creatives.length === 0) return [];

  if (type === "cut") {
    const candidates = creatives
      .filter((c) => c.status === "Loser" || (c.cpa > 0 && c.ctr < 1 && c.roas < 1.5))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 5);
    if (candidates.length === 0) return ["Aucune créa à couper détectée — bon boulot !"];
    return candidates.map(
      (c) =>
        `${c.name} — CPA $${c.cpa.toFixed(0)}, CTR ${c.ctr.toFixed(1)}%, ROAS ${c.roas.toFixed(2)}x`
    );
  }

  if (type === "scale") {
    const candidates = creatives
      .filter((c) => c.roas >= 2.5 && c.spend < 800 && c.status !== "Loser")
      .sort((a, b) => b.roas - a.roas)
      .slice(0, 5);
    if (candidates.length === 0)
      return ["Aucune opportunité de scale détectée pour l'instant."];
    return candidates.map(
      (c) =>
        `${c.name} — ROAS ${c.roas.toFixed(2)}x, Spend $${c.spend.toFixed(0)} (sous-exploité)`
    );
  }

  if (type === "working") {
    const winners = creatives.filter((c) => c.status === "Winner");
    if (winners.length === 0) return ["Pas encore de créas winner dans la période sélectionnée."];

    const avgRoas =
      winners.reduce((s, c) => s + c.roas, 0) / winners.length;
    const avgCtr =
      winners.reduce((s, c) => s + c.ctr, 0) / winners.length;
    const avgHook =
      winners.reduce((s, c) => s + c.hookRate, 0) / winners.length;

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
      `ROAS moyen winners : ${avgRoas.toFixed(2)}x`,
      `CTR moyen winners : ${avgCtr.toFixed(1)}%`,
      `Hook rate moyen : ${avgHook.toFixed(1)}%`,
      `Format dominant : ${topFormat} (${Math.max(videoCount, imageCount, carouselCount)} winners)`,
    ];
  }

  return [];
}

export default function CreativeTeamPage() {
  const { creatives, isLoading } = useCreativesContext();
  const [activeInsight, setActiveInsight] = useState<InsightType>(null);

  const sorted = useMemo(
    () => [...creatives].sort((a, b) => b.spend - a.spend),
    [creatives]
  );

  const insights = useMemo(
    () => getInsights(creatives, activeInsight),
    [creatives, activeInsight]
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
            <CreativeTeamCard key={creative.id} creative={creative} scores={scores} />
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
}: {
  creative: Creative;
  scores: ReturnType<typeof calculateFunnelScores>;
}) {
  const statusColors: Record<string, string> = {
    Winner: "bg-emerald-500/15 text-emerald-400",
    Loser: "bg-red-500/15 text-red-400",
    Fatigued: "bg-amber-500/15 text-amber-400",
    Active: "bg-blue-500/15 text-blue-400",
  };

  return (
    <div className="bg-[#0d0d1a] border border-white/5 rounded-xl p-4 flex items-center gap-4 hover:border-white/10 transition-colors">
      {/* Thumbnail */}
      <div className="w-14 h-14 rounded-lg overflow-hidden shrink-0 bg-gray-900">
        {creative.thumbnailUrl ? (
          <img
            src={creative.thumbnailUrl}
            alt={creative.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div
            className="w-full h-full"
            style={{ background: creative.thumbnailColor }}
          />
        )}
      </div>

      {/* Name + status */}
      <div className="w-48 shrink-0 min-w-0">
        <p className="text-sm font-medium text-white truncate">{creative.name}</p>
        <div className="flex items-center gap-2 mt-1">
          <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusColors[creative.status]}`}
          >
            {creative.status}
          </span>
          <span className="text-[10px] text-gray-600">{creative.format}</span>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Spend{" "}
          <span className="text-white font-medium">
            ${creative.spend >= 1000 ? `${(creative.spend / 1000).toFixed(1)}k` : creative.spend.toFixed(0)}
          </span>{" "}
          · ROAS{" "}
          <span className="text-white font-medium">{creative.roas.toFixed(2)}x</span>
        </p>
      </div>

      {/* Funnel scores */}
      <div className="flex-1">
        <FunnelScoresBar scores={scores} />
      </div>
    </div>
  );
}
