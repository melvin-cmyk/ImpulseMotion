"use client";

import { useMemo, useState, useEffect } from "react";
import { Creative } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import { CreativeModal } from "@/components/creative-modal";
import { BarChart2, TrendingUp, Trophy, Shapes } from "lucide-react";
import Link from "next/link";

// ── Naming config (mirrors /naming page) ─────────────────────────────────────

interface SegmentDef {
  label: string;
  position: number;
}

interface NamingConfig {
  separator: string;
  segments: SegmentDef[];
}

const DEFAULT_CONFIG: NamingConfig = {
  separator: "_",
  segments: [
    { label: "Product", position: 0 },
    { label: "Format", position: 1 },
    { label: "Angle", position: 2 },
  ],
};

function parseSegment(name: string, position: number, separator: string): string {
  const parts = name.split(separator).map((p) => p.trim()).filter(Boolean);
  const val = parts[position];
  if (!val || val === "") return "Non catégorisé";
  return val;
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
  topCreatives: Creative[];
}

function groupBySegment(
  seg: SegmentDef,
  separator: string,
  creatives: Creative[]
): GroupStats[] {
  const map: Record<string, { stats: GroupStats; creatives: Creative[] }> = {};

  for (const c of creatives) {
    const key = parseSegment(c.name, seg.position, separator);
    if (!map[key]) {
      map[key] = {
        stats: {
          key,
          count: 0,
          spend: 0,
          roas: 0,
          cpa: 0,
          ctr: 0,
          winners: 0,
          thumbnails: [],
          topCreatives: [],
        },
        creatives: [],
      };
    }
    map[key].stats.count++;
    map[key].stats.spend += c.spend;
    map[key].stats.roas += c.roas;
    map[key].stats.cpa += c.cpa;
    map[key].stats.ctr += c.ctr;
    if (c.status === "Winner") map[key].stats.winners++;
    if (c.thumbnailUrl && map[key].stats.thumbnails.length < 5) {
      map[key].stats.thumbnails.push(c.thumbnailUrl);
    }
    map[key].creatives.push(c);
  }

  return Object.values(map)
    .map(({ stats, creatives: grpCreatives }) => {
      const n = stats.count;
      const topCreatives = [...grpCreatives]
        .sort((a, b) => b.roas - a.roas)
        .slice(0, 3);
      return {
        ...stats,
        spend: Math.round(stats.spend),
        roas: Math.round((stats.roas / n) * 100) / 100,
        cpa: Math.round((stats.cpa / n) * 100) / 100,
        ctr: Math.round((stats.ctr / n) * 100) / 100,
        topCreatives,
      };
    })
    .sort((a, b) => {
      if (a.key === "Non catégorisé") return 1;
      if (b.key === "Non catégorisé") return -1;
      return b.count - a.count;
    });
}

// ── Segment card ──────────────────────────────────────────────────────────────

function SegmentCard({
  seg,
  groups,
  onCreativeClick,
}: {
  seg: SegmentDef;
  groups: GroupStats[];
  onCreativeClick: (c: Creative) => void;
}) {
  const maxCount = Math.max(...groups.map((g) => g.count), 1);
  const top6 = groups.slice(0, 8);

  const hitRate = (g: GroupStats) =>
    g.count > 0 ? Math.round((g.winners / g.count) * 100) : 0;

  const isProven = (g: GroupStats) => hitRate(g) >= 20 && g.winners >= 2;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden flex flex-col">
      {/* Card header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-violet-500/20 flex items-center justify-center">
            <BarChart2 className="w-3.5 h-3.5 text-violet-400" />
          </div>
          <span className="font-semibold text-white text-sm">{seg.label}</span>
          <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">
            {groups.length} valeurs
          </span>
        </div>
        <Link
          href="/naming"
          className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
        >
          Voir rapport →
        </Link>
      </div>

      {/* Rows */}
      <div className="divide-y divide-gray-800/50 flex-1">
        {top6.map((g) => (
          <div key={g.key} className="flex items-center gap-3 px-4 py-3 group hover:bg-gray-800/30 transition-colors">
            {/* Thumbnails */}
            <div className="flex -space-x-2 shrink-0">
              {g.thumbnails.slice(0, 4).map((thumb, i) => (
                <div
                  key={i}
                  className="w-7 h-7 rounded-full border-2 border-gray-900 overflow-hidden bg-gray-800 shrink-0"
                  style={{ zIndex: 4 - i }}
                >
                  <img
                    src={thumb}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                </div>
              ))}
              {g.thumbnails.length === 0 && (
                <div className="w-7 h-7 rounded-full border-2 border-gray-900 bg-gray-700 flex items-center justify-center text-gray-500">
                  <Shapes className="w-3 h-3" />
                </div>
              )}
            </div>

            {/* Label + bar */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm text-gray-200 truncate">{g.key}</span>
                {isProven(g) && (
                  <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 rounded-full font-medium shrink-0">
                    ✓ Proven
                  </span>
                )}
              </div>
              <div className="w-full bg-gray-800 rounded-full h-1.5">
                <div
                  className="bg-violet-500 rounded-full h-1.5 transition-all"
                  style={{ width: `${(g.count / maxCount) * 100}%` }}
                />
              </div>
            </div>

            {/* Count */}
            <span className="text-sm font-semibold text-gray-300 shrink-0 w-6 text-right">
              {g.count}
            </span>
          </div>
        ))}
      </div>

      {/* Footer KPIs */}
      <div className="px-4 py-3 border-t border-gray-800 flex gap-4 text-xs text-gray-500">
        {groups.length > 0 && (
          <>
            <span>
              <span className="text-gray-300 font-medium">
                {groups.reduce((s, g) => s + g.winners, 0)}
              </span>{" "}
              winners
            </span>
            <span>
              Meilleur ROAS:{" "}
              <span className="text-emerald-400 font-medium">
                {Math.max(...groups.map((g) => g.roas)).toFixed(1)}x
              </span>
            </span>
            <span>
              Meilleur CPA:{" "}
              <span className="text-blue-400 font-medium">
                €{Math.min(...groups.filter((g) => g.cpa > 0).map((g) => g.cpa)).toFixed(0)}
              </span>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ── Top creatives per segment ─────────────────────────────────────────────────

function TopWinnersSection({
  config,
  creatives,
  onCreativeClick,
}: {
  config: NamingConfig;
  creatives: Creative[];
  onCreativeClick: (c: Creative) => void;
}) {
  const allGroups = useMemo(() => {
    return config.segments.map((seg) => ({
      seg,
      groups: groupBySegment(seg, config.separator, creatives),
    }));
  }, [config, creatives]);

  // Find segment with most differentiation (highest ROAS spread)
  const bestSeg = useMemo(() => {
    let best = allGroups[0];
    for (const g of allGroups) {
      const roasValues = g.groups.map((gg) => gg.roas).filter((r) => r > 0);
      const spread =
        roasValues.length > 1
          ? Math.max(...roasValues) - Math.min(...roasValues)
          : 0;
      const currentSpread =
        best.groups.map((gg) => gg.roas).filter((r) => r > 0).length > 1
          ? Math.max(...best.groups.map((g) => g.roas)) -
            Math.min(...best.groups.map((g) => g.roas))
          : 0;
      if (spread > currentSpread) best = g;
    }
    return best;
  }, [allGroups]);

  const topItems = useMemo(
    () =>
      bestSeg.groups
        .filter((g) => g.key !== "Non catégorisé" && g.roas > 0)
        .sort((a, b) => b.roas - a.roas)
        .slice(0, 5),
    [bestSeg]
  );

  if (topItems.length === 0) return null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
        <div className="w-8 h-8 rounded-xl bg-amber-500/20 flex items-center justify-center">
          <Trophy className="w-4 h-4 text-amber-400" />
        </div>
        <div>
          <h3 className="font-semibold text-white text-sm">
            Top performers par {bestSeg.seg.label}
          </h3>
          <p className="text-xs text-gray-500">Segmenté par ROAS moyen</p>
        </div>
      </div>
      <div className="divide-y divide-gray-800/50">
        {topItems.map((g, i) => (
          <div key={g.key} className="flex items-center gap-4 px-5 py-3">
            <span className="text-lg font-bold text-gray-600 w-6 shrink-0">
              {i + 1}
            </span>
            <div className="flex -space-x-2 shrink-0">
              {g.thumbnails.slice(0, 3).map((thumb, j) => (
                <div
                  key={j}
                  className="w-8 h-8 rounded-full border-2 border-gray-900 overflow-hidden bg-gray-800"
                  style={{ zIndex: 3 - j }}
                >
                  <img
                    src={thumb}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{g.key}</p>
              <p className="text-xs text-gray-500">
                {g.count} créas · {g.winners} winners
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-bold text-emerald-400">
                {g.roas.toFixed(1)}x
              </p>
              <p className="text-xs text-gray-500">ROAS moyen</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-semibold text-white">
                €{g.spend >= 1000 ? (g.spend / 1000).toFixed(1) + "k" : g.spend}
              </p>
              <p className="text-xs text-gray-500">Spend</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Performance heatmap per segment ──────────────────────────────────────────

function SegmentHeatmap({
  config,
  creatives,
}: {
  config: NamingConfig;
  creatives: Creative[];
}) {
  const metric = useMemo(() => {
    // Show CPA heatmap for all segment combinations
    if (config.segments.length < 2) return null;
    const seg1 = config.segments[0];
    const seg2 = config.segments[1];

    const map: Record<string, Record<string, { cpa: number; count: number }>> =
      {};
    const keys1 = new Set<string>();
    const keys2 = new Set<string>();

    for (const c of creatives) {
      const k1 = parseSegment(c.name, seg1.position, config.separator);
      const k2 = parseSegment(c.name, seg2.position, config.separator);
      if (k1 === "Non catégorisé" || k2 === "Non catégorisé") continue;
      keys1.add(k1);
      keys2.add(k2);
      if (!map[k1]) map[k1] = {};
      if (!map[k1][k2]) map[k1][k2] = { cpa: 0, count: 0 };
      map[k1][k2].cpa += c.cpa;
      map[k1][k2].count++;
    }

    const rows = Array.from(keys1).slice(0, 6);
    const cols = Array.from(keys2).slice(0, 6);

    if (rows.length < 2 || cols.length < 2) return null;

    const cells: { r: string; c: string; avgCpa: number }[] = [];
    for (const r of rows) {
      for (const c of cols) {
        const cell = map[r]?.[c];
        cells.push({
          r,
          c,
          avgCpa: cell && cell.count > 0 ? cell.cpa / cell.count : -1,
        });
      }
    }

    const validCpas = cells.filter((c) => c.avgCpa >= 0).map((c) => c.avgCpa);
    const minCpa = Math.min(...validCpas);
    const maxCpa = Math.max(...validCpas);

    return { rows, cols, cells, minCpa, maxCpa, seg1Label: seg1.label, seg2Label: seg2.label };
  }, [config, creatives]);

  if (!metric) return null;

  function cellColor(cpa: number): string {
    if (cpa < 0) return "bg-gray-800 text-gray-600";
    const { minCpa, maxCpa } = metric!;
    if (maxCpa === minCpa) return "bg-emerald-500/20 text-emerald-300";
    const pct = (cpa - minCpa) / (maxCpa - minCpa); // 0 = best (low CPA), 1 = worst
    if (pct < 0.25) return "bg-emerald-500/30 text-emerald-300";
    if (pct < 0.5) return "bg-blue-500/20 text-blue-300";
    if (pct < 0.75) return "bg-amber-500/20 text-amber-300";
    return "bg-red-500/20 text-red-300";
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
        <div className="w-8 h-8 rounded-xl bg-blue-500/20 flex items-center justify-center">
          <TrendingUp className="w-4 h-4 text-blue-400" />
        </div>
        <div>
          <h3 className="font-semibold text-white text-sm">
            Heatmap CPA — {metric.seg1Label} × {metric.seg2Label}
          </h3>
          <p className="text-xs text-gray-500">
            Vert = CPA bas (meilleur) · Rouge = CPA élevé
          </p>
        </div>
      </div>
      <div className="p-4 overflow-x-auto">
        <table className="text-xs w-full">
          <thead>
            <tr>
              <th className="text-left text-gray-500 pb-2 pr-3 font-medium w-28">
                {metric.seg1Label} \ {metric.seg2Label}
              </th>
              {metric.cols.map((c) => (
                <th key={c} className="text-center pb-2 px-1 text-gray-400 font-medium max-w-20">
                  <span className="block truncate">{c}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metric.rows.map((r) => (
              <tr key={r}>
                <td className="text-gray-400 py-1.5 pr-3 font-medium truncate max-w-28">
                  {r}
                </td>
                {metric.cols.map((c) => {
                  const cell = metric.cells.find(
                    (cell) => cell.r === r && cell.c === c
                  );
                  return (
                    <td key={c} className="px-1 py-1.5 text-center">
                      <span
                        className={`inline-block px-2 py-1 rounded-lg font-semibold ${cellColor(cell?.avgCpa ?? -1)}`}
                      >
                        {cell && cell.avgCpa >= 0
                          ? `€${cell.avgCpa.toFixed(0)}`
                          : "—"}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PatternsPage() {
  const { creatives } = useCreativesContext();
  const [config, setConfig] = useState<NamingConfig>(DEFAULT_CONFIG);
  const [selectedCreative, setSelectedCreative] = useState<Creative | null>(null);

  // Load naming config from localStorage (same as /naming page)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem("namingConfig");
      if (raw) setConfig(JSON.parse(raw));
    } catch {}
  }, []);

  const segmentGroups = useMemo(
    () =>
      config.segments.map((seg) => ({
        seg,
        groups: groupBySegment(seg, config.separator, creatives),
      })),
    [config, creatives]
  );

  const totalCreatives = creatives.length;
  const totalWinners = creatives.filter((c) => c.status === "Winner").length;
  const categorizedCount = creatives.filter((c) => {
    const parts = c.name.split(config.separator).map((p) => p.trim()).filter(Boolean);
    return parts.length >= config.segments.length;
  }).length;
  const healthPct =
    totalCreatives > 0
      ? Math.round((categorizedCount / totalCreatives) * 100)
      : 0;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-violet-500/20 flex items-center justify-center">
            <Shapes className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Patterns</h1>
            <p className="text-gray-400 text-sm mt-0.5">
              Découvrez les tendances de vos créatives
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Health badge */}
          <div
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border font-medium ${
              healthPct >= 70
                ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                : healthPct >= 40
                ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
                : "bg-red-500/10 text-red-300 border-red-500/30"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                healthPct >= 70
                  ? "bg-emerald-400"
                  : healthPct >= 40
                  ? "bg-amber-400"
                  : "bg-red-400"
              }`}
            />
            {healthPct}% catégorisé
          </div>
          <Link
            href="/naming"
            className="text-xs text-violet-400 hover:text-violet-300 border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 rounded-full transition-colors"
          >
            ⚙ Configurer le naming
          </Link>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          {
            label: "Total créatives",
            value: totalCreatives,
            sub: `${categorizedCount} catégorisées`,
            color: "text-white",
          },
          {
            label: "Winners",
            value: totalWinners,
            sub: `${totalCreatives > 0 ? Math.round((totalWinners / totalCreatives) * 100) : 0}% hit rate`,
            color: "text-emerald-400",
          },
          {
            label: "Segments analysés",
            value: config.segments.length,
            sub: config.segments.map((s) => s.label).join(" · "),
            color: "text-violet-400",
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-gray-900 border border-gray-800 rounded-xl p-4"
          >
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">
              {stat.label}
            </p>
            <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            <p className="text-xs text-gray-500 mt-0.5 truncate">{stat.sub}</p>
          </div>
        ))}
      </div>

      {/* Segment cards grid */}
      {creatives.length === 0 ? (
        <div className="text-center py-16 text-gray-500 text-sm">
          Aucune créative disponible. Configurez votre compte Meta dans les{" "}
          <Link href="/settings" className="text-violet-400 hover:underline">
            paramètres
          </Link>
          .
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {segmentGroups.map(({ seg, groups }) => (
              <SegmentCard
                key={seg.label}
                seg={seg}
                groups={groups}
                onCreativeClick={setSelectedCreative}
              />
            ))}
          </div>

          {/* Top winners by best differentiating segment */}
          <TopWinnersSection
            config={config}
            creatives={creatives}
            onCreativeClick={setSelectedCreative}
          />

          {/* CPA heatmap */}
          <SegmentHeatmap config={config} creatives={creatives} />
        </>
      )}

      {/* Creative modal */}
      {selectedCreative && (
        <CreativeModal
          creative={selectedCreative}
          onClose={() => setSelectedCreative(null)}
        />
      )}
    </div>
  );
}
