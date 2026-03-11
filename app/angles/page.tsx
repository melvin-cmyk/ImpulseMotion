"use client";

import { useMemo, useState } from "react";
import { useCreativesContext } from "@/lib/creatives-context";
import { Creative } from "@/lib/mock-data";
import { BadgeCheck } from "lucide-react";

interface AngleGroup {
  name: string;
  creatives: Creative[];
  spend: number;
  activeCount: number;
  winnerCount: number;
  hitRate: number;
  thumbnails: string[];
}

const DEFAULT_CONFIG = { separator: "_", angleIndex: 2 };

function loadNamingConfig(): { separator: string; angleIndex: number } {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = localStorage.getItem("impulse_naming_config");
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw);
    const segments: { name: string }[] = parsed.segments ?? [];
    const sep: string = parsed.separator ?? "_";
    // Find the "angle" segment index (case-insensitive) or fall back to last segment
    const angleIdx = segments.findIndex((s) =>
      s.name?.toLowerCase().includes("angle")
    );
    return {
      separator: sep,
      angleIndex: angleIdx >= 0 ? angleIdx : Math.max(0, segments.length - 1),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function extractAngle(name: string, sep: string, idx: number): string {
  const parts = name.split(sep);
  return parts[idx]?.trim() || "Unknown";
}

export default function AnglesPage() {
  const { creatives, isLoading } = useCreativesContext();
  const [sortBy, setSortBy] = useState<"spend" | "hitRate" | "active">("spend");

  const config = useMemo(() => loadNamingConfig(), []);

  const groups = useMemo<AngleGroup[]>(() => {
    const map = new Map<string, Creative[]>();

    for (const c of creatives) {
      const angle = extractAngle(c.name, config.separator, config.angleIndex);
      if (!map.has(angle)) map.set(angle, []);
      map.get(angle)!.push(c);
    }

    return Array.from(map.entries()).map(([name, items]) => {
      const spend = items.reduce((s, c) => s + c.spend, 0);
      const activeCount = items.filter(
        (c) => c.status === "Active" || c.status === "Winner"
      ).length;
      const winnerCount = items.filter((c) => c.status === "Winner").length;
      const hitRate =
        items.length > 0
          ? Math.round((winnerCount / items.length) * 100)
          : 0;
      const thumbnails = items
        .filter((c) => c.thumbnailUrl)
        .slice(0, 3)
        .map((c) => c.thumbnailUrl!);

      return { name, creatives: items, spend, activeCount, winnerCount, hitRate, thumbnails };
    });
  }, [creatives, config]);

  const sorted = useMemo(() => {
    return [...groups].sort((a, b) => {
      if (sortBy === "spend") return b.spend - a.spend;
      if (sortBy === "hitRate") return b.hitRate - a.hitRate;
      return b.activeCount - a.activeCount;
    });
  }, [groups, sortBy]);

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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Angles</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Performance par messaging angle — basé sur ta naming convention
          </p>
        </div>
        <div className="flex gap-2">
          {(["spend", "hitRate", "active"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                sortBy === s
                  ? "bg-violet-600 text-white"
                  : "bg-gray-800 text-gray-400 hover:text-white"
              }`}
            >
              {s === "spend" ? "Spend" : s === "hitRate" ? "Hit Rate" : "Actifs"}
            </button>
          ))}
        </div>
      </div>

      {/* Angle cards */}
      <div className="space-y-3">
        {sorted.map((group) => (
          <AngleCard key={group.name} group={group} />
        ))}
      </div>

      {sorted.length === 0 && (
        <div className="text-center text-gray-600 py-20">
          Aucune créa trouvée. Vérifie ta{" "}
          <a href="/naming" className="text-violet-400 underline">
            naming convention
          </a>
          .
        </div>
      )}
    </div>
  );
}

function AngleCard({ group }: { group: AngleGroup }) {
  const isProven = group.hitRate >= 20;

  return (
    <div className="bg-[#0d0d1a] border border-white/5 rounded-xl p-4 flex items-center gap-4 hover:border-white/10 transition-colors">
      {/* Thumbnail cluster */}
      <div className="relative w-16 h-16 shrink-0">
        {group.thumbnails.length === 0 && (
          <div className="w-16 h-16 rounded-lg bg-gradient-to-br from-violet-800/40 to-purple-900/40 border border-white/5" />
        )}
        {group.thumbnails.map((url, i) => (
          <img
            key={url}
            src={url}
            alt=""
            className="absolute rounded-md object-cover border border-black"
            style={{
              width: 40,
              height: 40,
              top: i * 6,
              left: i * 6,
              zIndex: group.thumbnails.length - i,
            }}
          />
        ))}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-white font-semibold text-sm truncate">
            {group.name}
          </span>
          {isProven && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 text-[10px] font-bold shrink-0">
              <BadgeCheck className="w-3 h-3" />
              Proven
            </span>
          )}
        </div>
        <div className="flex gap-4 text-xs text-gray-500">
          <span>
            <span className="text-white font-medium">
              ${group.spend >= 1000 ? `${(group.spend / 1000).toFixed(1)}k` : group.spend.toFixed(0)}
            </span>{" "}
            spend
          </span>
          <span>
            <span className="text-white font-medium">{group.activeCount}</span>{" "}
            actifs
          </span>
          <span>
            <span
              className={`font-bold ${
                group.hitRate >= 20
                  ? "text-emerald-400"
                  : group.hitRate > 0
                  ? "text-amber-400"
                  : "text-gray-500"
              }`}
            >
              {group.hitRate}%
            </span>{" "}
            hit rate
          </span>
          <span className="text-gray-600">
            {group.creatives.length} créa{group.creatives.length > 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* Hit rate bar */}
      <div className="w-24 shrink-0">
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${
              group.hitRate >= 20
                ? "bg-emerald-500"
                : group.hitRate > 0
                ? "bg-amber-400"
                : "bg-gray-700"
            }`}
            style={{ width: `${Math.min(100, group.hitRate * 3)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
