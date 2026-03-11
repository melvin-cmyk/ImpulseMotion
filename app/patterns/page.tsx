"use client";

import { useMemo, useState } from "react";
import { Creative } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import { DateRangePicker } from "@/components/date-range-picker";
import { Layers, TrendingUp, DollarSign, MousePointerClick, Trophy } from "lucide-react";

// ── Segment config stored in localStorage (reuse naming convention config) ────

interface NamingConfig {
  separator: string;
  segments: { name: string; position: number }[];
}

function getNamingConfig(): NamingConfig {
  if (typeof window === "undefined") {
    return { separator: "_", segments: [{ name: "Product", position: 0 }, { name: "Format", position: 1 }, { name: "Angle", position: 2 }] };
  }
  try {
    const raw = localStorage.getItem("impulse_naming_config");
    if (raw) return JSON.parse(raw);
  } catch {}
  return { separator: "_", segments: [{ name: "Product", position: 0 }, { name: "Format", position: 1 }, { name: "Angle", position: 2 }] };
}

// ── Group stats ───────────────────────────────────────────────────────────────

interface GroupStats {
  key: string;
  count: number;
  spend: number;
  roas: number;
  cpa: number;
  ctr: number;
  winners: number;
  thumbnails: string[];
}

function groupBySegment(
  creatives: Creative[],
  separator: string,
  position: number
): GroupStats[] {
  const map: Record<string, GroupStats> = {};
  for (const c of creatives) {
    const parts = c.name.split(separator);
    const key = parts[position]?.trim() || "Unknown";
    if (!map[key]) {
      map[key] = { key, count: 0, spend: 0, roas: 0, cpa: 0, ctr: 0, winners: 0, thumbnails: [] };
    }
    map[key].count++;
    map[key].spend += c.spend;
    map[key].roas += c.roas;
    map[key].cpa += c.cpa;
    map[key].ctr += c.ctr;
    if (c.status === "Winner") map[key].winners++;
    if (c.thumbnailUrl && map[key].thumbnails.length < 3) {
      map[key].thumbnails.push(c.thumbnailUrl);
    }
  }
  return Object.values(map)
    .map((g) => ({
      ...g,
      spend: Math.round(g.spend),
      roas: Math.round((g.roas / g.count) * 100) / 100,
      cpa: Math.round((g.cpa / g.count) * 100) / 100,
      ctr: Math.round((g.ctr / g.count) * 100) / 100,
    }))
    .sort((a, b) => b.spend - a.spend);
}

// ── Segment card ──────────────────────────────────────────────────────────────

const ACCENT_COLORS = [
  "from-violet-500/20 to-violet-900/10 border-violet-500/30",
  "from-blue-500/20 to-blue-900/10 border-blue-500/30",
  "from-emerald-500/20 to-emerald-900/10 border-emerald-500/30",
  "from-pink-500/20 to-pink-900/10 border-pink-500/30",
  "from-amber-500/20 to-amber-900/10 border-amber-500/30",
  "from-cyan-500/20 to-cyan-900/10 border-cyan-500/30",
];

function PatternCard({ group, index, totalSpend }: { group: GroupStats; index: number; totalSpend: number }) {
  const spendPct = totalSpend > 0 ? (group.spend / totalSpend) * 100 : 0;
  const accentClass = ACCENT_COLORS[index % ACCENT_COLORS.length];

  return (
    <div className={`bg-gradient-to-br ${accentClass} border rounded-2xl p-4 space-y-3`}>
      {/* Thumbnails row */}
      <div className="flex gap-1.5 h-16">
        {group.thumbnails.length > 0 ? (
          group.thumbnails.map((url, i) => (
            <div key={i} className="flex-1 rounded-lg overflow-hidden bg-gray-800">
              <img src={url} alt="" className="w-full h-full object-cover" />
            </div>
          ))
        ) : (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex-1 rounded-lg bg-gray-800/60 flex items-center justify-center">
              <Layers className="w-4 h-4 text-gray-600" />
            </div>
          ))
        )}
        {group.thumbnails.length < 3 &&
          Array.from({ length: 3 - group.thumbnails.length }).map((_, i) => (
            <div key={`pad-${i}`} className="flex-1 rounded-lg bg-gray-800/60" />
          ))}
      </div>

      {/* Name + count */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold text-white text-sm leading-tight">{group.key}</h3>
        <span className="text-xs text-gray-400 shrink-0">{group.count} ads</span>
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
      <div className="grid grid-cols-3 gap-2 pt-1">
        <div className="text-center">
          <div className="text-xs text-gray-500">ROAS</div>
          <div className="text-sm font-semibold text-white">{group.roas.toFixed(1)}x</div>
        </div>
        <div className="text-center">
          <div className="text-xs text-gray-500">CPA</div>
          <div className="text-sm font-semibold text-white">${group.cpa.toFixed(0)}</div>
        </div>
        <div className="text-center">
          <div className="text-xs text-gray-500">CTR</div>
          <div className="text-sm font-semibold text-white">{group.ctr.toFixed(2)}%</div>
        </div>
      </div>

      {/* Winners badge */}
      {group.winners > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-1">
          <Trophy className="w-3 h-3" />
          <span>{group.winners} winner{group.winners > 1 ? "s" : ""}</span>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PatternsPage() {
  const { creatives, isLoading } = useCreativesContext();
  const [activeSegmentIdx, setActiveSegmentIdx] = useState(0);

  const config = useMemo(() => getNamingConfig(), []);

  const groups = useMemo(() => {
    if (!config.segments[activeSegmentIdx]) return [];
    const seg = config.segments[activeSegmentIdx];
    return groupBySegment(creatives, config.separator, seg.position);
  }, [creatives, config, activeSegmentIdx]);

  const totalSpend = useMemo(() => groups.reduce((s, g) => s + g.spend, 0), [groups]);

  const topByRoas = useMemo(() => [...groups].sort((a, b) => b.roas - a.roas)[0], [groups]);

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Patterns</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          Performance par segment de naming convention
        </p>
      </div>

      <DateRangePicker />

      {/* Summary KPIs */}
      {!isLoading && groups.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-gray-400 text-xs mb-1">
              <Layers className="w-3.5 h-3.5" />
              Segments
            </div>
            <div className="text-2xl font-bold text-white">{groups.length}</div>
            <div className="text-xs text-gray-500 mt-0.5">{config.segments[activeSegmentIdx]?.name}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-gray-400 text-xs mb-1">
              <DollarSign className="w-3.5 h-3.5" />
              Budget total
            </div>
            <div className="text-2xl font-bold text-white">
              ${totalSpend >= 1000 ? `${(totalSpend / 1000).toFixed(1)}k` : totalSpend}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">{creatives.length} créas</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-gray-400 text-xs mb-1">
              <TrendingUp className="w-3.5 h-3.5" />
              Best ROAS
            </div>
            <div className="text-2xl font-bold text-emerald-400">
              {topByRoas ? `${topByRoas.roas.toFixed(1)}x` : "—"}
            </div>
            <div className="text-xs text-gray-500 mt-0.5 truncate">{topByRoas?.key}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-gray-400 text-xs mb-1">
              <Trophy className="w-3.5 h-3.5" />
              Winners
            </div>
            <div className="text-2xl font-bold text-amber-400">
              {groups.reduce((s, g) => s + g.winners, 0)}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">total</div>
          </div>
        </div>
      )}

      {/* Segment tabs */}
      {config.segments.length > 1 && (
        <div className="flex gap-2">
          {config.segments.map((seg, i) => (
            <button
              key={i}
              onClick={() => setActiveSegmentIdx(i)}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                activeSegmentIdx === i
                  ? "bg-violet-600 text-white"
                  : "bg-gray-900 border border-gray-800 text-gray-400 hover:text-white hover:bg-gray-800"
              }`}
            >
              {seg.name}
            </button>
          ))}
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="text-center py-12 text-gray-500 text-sm">Chargement...</div>
      )}

      {/* Empty state */}
      {!isLoading && groups.length === 0 && (
        <div className="text-center py-12 text-gray-500 text-sm space-y-2">
          <Layers className="w-8 h-8 mx-auto text-gray-700" />
          <p>Aucune créa trouvée.</p>
          <p className="text-xs">Configure ta naming convention sur la page <strong className="text-gray-400">Naming</strong>.</p>
        </div>
      )}

      {/* Pattern cards grid */}
      {!isLoading && groups.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {groups.map((group, i) => (
            <PatternCard key={group.key} group={group} index={i} totalSpend={totalSpend} />
          ))}
        </div>
      )}

      {/* Table view below cards */}
      {!isLoading && groups.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800">
            <h2 className="text-sm font-semibold text-white">Vue tableau</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs uppercase tracking-wide border-b border-gray-800">
                  <th className="text-left py-3 px-4">Segment</th>
                  <th className="text-right py-3 px-4">Créas</th>
                  <th className="text-right py-3 px-4">Spend</th>
                  <th className="text-right py-3 px-4">Budget %</th>
                  <th className="text-right py-3 px-4">ROAS</th>
                  <th className="text-right py-3 px-4">CPA</th>
                  <th className="text-right py-3 px-4">CTR</th>
                  <th className="text-right py-3 px-4">Winners</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g, i) => (
                  <tr
                    key={g.key}
                    className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors ${
                      i === 0 ? "bg-violet-900/10" : ""
                    }`}
                  >
                    <td className="py-3 px-4 font-medium text-white">{g.key}</td>
                    <td className="py-3 px-4 text-right text-gray-300">{g.count}</td>
                    <td className="py-3 px-4 text-right text-gray-300">
                      ${g.spend >= 1000 ? `${(g.spend / 1000).toFixed(1)}k` : g.spend}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-violet-500 rounded-full"
                            style={{ width: `${Math.min((g.spend / totalSpend) * 100, 100)}%` }}
                          />
                        </div>
                        <span className="text-gray-400 text-xs w-10 text-right">
                          {((g.spend / totalSpend) * 100).toFixed(0)}%
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className={g.roas >= 3 ? "text-emerald-400 font-semibold" : "text-gray-300"}>
                        {g.roas.toFixed(2)}x
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-gray-300">${g.cpa.toFixed(0)}</td>
                    <td className="py-3 px-4 text-right text-gray-300">{g.ctr.toFixed(2)}%</td>
                    <td className="py-3 px-4 text-right">
                      {g.winners > 0 ? (
                        <span className="text-amber-400 font-semibold">{g.winners}</span>
                      ) : (
                        <span className="text-gray-600">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
