"use client";

import { useMemo, useState } from "react";
import { useCreativesContext } from "@/lib/creatives-context";
import { Creative } from "@/lib/mock-data";
import { FileText, TrendingUp, Scissors, Search } from "lucide-react";

type SortKey = "spend" | "roas" | "ctr" | "cpa";

interface CopyGroup {
  key: string;
  headline: string;
  body: string;
  creatives: Creative[];
  spend: number;
  roas: number;
  ctr: number;
  cpa: number;
  thumbnail?: string;
}

function extractCopy(name: string): { headline: string; body: string } {
  // Split name by common separators to get parts
  const parts = name.split(/[_\-|]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { headline: parts.slice(0, 2).join(" — "), body: parts.slice(2).join(" · ") };
  }
  return { headline: name, body: "" };
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function fmt(n: number, prefix = "", suffix = "", decimals = 2): string {
  if (n === 0) return "—";
  return `${prefix}${n.toFixed(decimals)}${suffix}`;
}

const AI_INSIGHTS = [
  { icon: Scissors, label: "Quels messages couper ?" },
  { icon: Search, label: "Patterns dans les winners" },
  { icon: TrendingUp, label: "Angles qui convertissent" },
];

export default function TopCopyPage() {
  const { creatives, isLoading } = useCreativesContext();
  const [sortBy, setSortBy] = useState<SortKey>("spend");
  const [aiInsight, setAiInsight] = useState<string | null>(null);

  const groups = useMemo<CopyGroup[]>(() => {
    const map = new Map<string, Creative[]>();

    for (const c of creatives) {
      const { headline } = extractCopy(c.name);
      if (!map.has(headline)) map.set(headline, []);
      map.get(headline)!.push(c);
    }

    return Array.from(map.entries()).map(([headline, items]) => {
      const { body } = extractCopy(items[0].name);
      return {
        key: headline,
        headline,
        body,
        creatives: items,
        spend: items.reduce((s, c) => s + c.spend, 0),
        roas: avg(items.map((c) => c.roas)),
        ctr: avg(items.map((c) => c.ctr)),
        cpa: avg(items.map((c) => c.cpa).filter((v) => v > 0)),
        thumbnail: items.find((c) => c.thumbnailUrl)?.thumbnailUrl,
      };
    });
  }, [creatives]);

  const sorted = useMemo(
    () =>
      [...groups].sort((a, b) => {
        if (sortBy === "spend") return b.spend - a.spend;
        if (sortBy === "roas") return b.roas - a.roas;
        if (sortBy === "ctr") return b.ctr - a.ctr;
        return a.cpa - b.cpa; // lower CPA = better
      }),
    [groups, sortBy]
  );

  const handleAiInsight = (label: string) => {
    setAiInsight(aiInsight === label ? null : label);
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
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <FileText className="w-5 h-5 text-violet-400" />
            Top Copy
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Identifiez les messages qui résonnent le mieux
          </p>
        </div>
        <div className="flex gap-2">
          {(["spend", "roas", "ctr", "cpa"] as SortKey[]).map((s) => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                sortBy === s
                  ? "bg-violet-600 text-white"
                  : "bg-gray-800 text-gray-400 hover:text-white"
              }`}
            >
              {s.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* AI Insights bar */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {AI_INSIGHTS.map(({ icon: Icon, label }) => (
          <button
            key={label}
            onClick={() => handleAiInsight(label)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              aiInsight === label
                ? "bg-violet-900/50 border-violet-500 text-violet-300"
                : "bg-[#0d0d1a] border-white/10 text-gray-400 hover:text-white hover:border-white/20"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* AI Insight result */}
      {aiInsight && (
        <div className="bg-violet-900/20 border border-violet-500/30 rounded-xl p-4 mb-5 text-sm text-violet-200">
          <p className="font-semibold mb-1">{aiInsight}</p>
          {aiInsight === "Quels messages couper ?" && (
            <p className="text-gray-400">
              Les copies avec CPA &gt; 2× la moyenne et spend &gt; $100 :{" "}
              {sorted
                .filter((g) => g.cpa > avg(groups.map((x) => x.cpa)) * 2 && g.spend > 100)
                .slice(0, 3)
                .map((g) => `"${g.headline}"`)
                .join(", ") || "Aucune identifiée pour l'instant."}
            </p>
          )}
          {aiInsight === "Patterns dans les winners" && (
            <p className="text-gray-400">
              Top 3 copies par ROAS :{" "}
              {[...groups]
                .sort((a, b) => b.roas - a.roas)
                .slice(0, 3)
                .map((g) => `"${g.headline}" (ROAS ${g.roas.toFixed(2)})`)
                .join(" · ")}
            </p>
          )}
          {aiInsight === "Angles qui convertissent" && (
            <p className="text-gray-400">
              Top copies par CTR :{" "}
              {[...groups]
                .sort((a, b) => b.ctr - a.ctr)
                .slice(0, 3)
                .map((g) => `"${g.headline}" (CTR ${g.ctr.toFixed(2)}%)`)
                .join(" · ")}
            </p>
          )}
        </div>
      )}

      {/* Copy cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {sorted.map((group, i) => (
          <CopyCard key={group.key} group={group} rank={i + 1} />
        ))}
      </div>

      {sorted.length === 0 && (
        <div className="text-center text-gray-600 py-20">Aucune créa trouvée.</div>
      )}
    </div>
  );
}

function CopyCard({ group, rank }: { group: CopyGroup; rank: number }) {
  const isTop = rank <= 3;

  return (
    <div
      className={`bg-[#0d0d1a] border rounded-xl p-4 hover:border-white/10 transition-colors ${
        isTop ? "border-violet-500/30" : "border-white/5"
      }`}
    >
      <div className="flex gap-3">
        {/* Thumbnail */}
        <div className="w-12 h-12 shrink-0 rounded-lg overflow-hidden bg-gray-800">
          {group.thumbnail ? (
            <img
              src={group.thumbnail}
              alt=""
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-violet-800 to-purple-900" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-1">
            <p className="text-sm font-semibold text-white leading-tight line-clamp-2">
              {group.headline}
            </p>
            {isTop && (
              <span className="text-[10px] font-bold text-violet-400 bg-violet-900/40 px-1.5 py-0.5 rounded shrink-0">
                #{rank}
              </span>
            )}
          </div>
          {group.body && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{group.body}</p>
          )}
          <p className="text-[10px] text-gray-600 mt-1">
            {group.creatives.length} créa{group.creatives.length > 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-4 gap-1 mt-3 pt-3 border-t border-white/5">
        {[
          { label: "Spend", value: fmt(group.spend, "$", "", 0) },
          { label: "ROAS", value: fmt(group.roas, "", "×") },
          { label: "CTR", value: fmt(group.ctr, "", "%") },
          { label: "CPA", value: fmt(group.cpa, "$", "") },
        ].map(({ label, value }) => (
          <div key={label} className="text-center">
            <p className="text-[10px] text-gray-600">{label}</p>
            <p className="text-xs font-semibold text-white">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
