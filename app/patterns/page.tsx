"use client";

import { useMemo, useState, useEffect } from "react";
import { Creative } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import { Layers, TrendingUp, DollarSign, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { loadNamingConfig, NamingConfig, parseSegmentValue, SegmentDef } from "@/lib/naming-config";

interface SegmentStats {
  value: string;
  count: number;
  winners: number;
  totalSpend: number;
  avgCpa: number;
  avgCtr: number;
  avgRoas: number;
  hitRate: number;
  thumbnails: string[];
  colors: string[];
}

function buildSegmentStats(creatives: Creative[], seg: SegmentDef, separator: string): SegmentStats[] {
  const map = new Map<string, Creative[]>();
  for (const c of creatives) {
    const val = parseSegmentValue(c.name, seg.position, separator);
    if (!map.has(val)) map.set(val, []);
    map.get(val)!.push(c);
  }

  return Array.from(map.entries())
    .map(([value, items]) => {
      const totalSpend = items.reduce((s, c) => s + c.spend, 0);
      const avgCpa = items.reduce((s, c) => s + c.cpa, 0) / items.length;
      const avgCtr = items.reduce((s, c) => s + c.ctr, 0) / items.length;
      const avgRoas = items.reduce((s, c) => s + c.roas, 0) / items.length;
      const winners = items.filter(c => c.status === "Winner").length;
      const hitRate = items.length > 0 ? (winners / items.length) * 100 : 0;
      const thumbnails = items.filter(c => c.thumbnailUrl).slice(0, 3).map(c => c.thumbnailUrl!);
      const colors = items.slice(0, 3).map(c => c.thumbnailColor);
      return { value, count: items.length, winners, totalSpend, avgCpa, avgCtr, avgRoas, hitRate, thumbnails, colors };
    })
    .sort((a, b) => b.totalSpend - a.totalSpend);
}

function ThumbnailCluster({ thumbnails, colors }: { thumbnails: string[]; colors: string[] }) {
  return (
    <div className="flex -space-x-2 mb-3">
      {thumbnails.slice(0, 3).map((url, i) => (
        <div key={i} className="w-10 h-10 rounded-lg border-2 border-gray-900 overflow-hidden">
          <img src={url} alt="" className="w-full h-full object-cover" />
        </div>
      ))}
      {thumbnails.length === 0 && colors.slice(0, 3).map((color, i) => (
        <div key={i} className="w-10 h-10 rounded-lg border-2 border-gray-900" style={{ background: color }} />
      ))}
    </div>
  );
}

export default function PatternsPage() {
  const { creatives } = useCreativesContext();
  const [namingConfig, setNamingConfig] = useState<NamingConfig | null>(null);
  const [activeSegmentIdx, setActiveSegmentIdx] = useState(0);

  useEffect(() => {
    setNamingConfig(loadNamingConfig());
  }, []);

  const activeSegment = namingConfig?.segments[activeSegmentIdx];

  const segmentStats = useMemo(() => {
    if (!namingConfig || !activeSegment) return [];
    return buildSegmentStats(creatives, activeSegment, namingConfig.separator);
  }, [creatives, namingConfig, activeSegment]);

  const maxSpend = segmentStats[0]?.totalSpend || 1;

  return (
    <div className="flex-1 overflow-auto bg-gray-950 p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 bg-violet-600/20 rounded-xl flex items-center justify-center">
          <Layers className="w-5 h-5 text-violet-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Patterns</h1>
          <p className="text-xs text-gray-500">Analyse de tes créas par segment de naming</p>
        </div>
      </div>

      {/* Segment tabs from naming config */}
      {namingConfig && (
        <div className="flex gap-1 bg-gray-900 rounded-xl p-1 mb-6 w-fit">
          {namingConfig.segments.map((seg, idx) => (
            <button
              key={seg.label}
              onClick={() => setActiveSegmentIdx(idx)}
              className={cn(
                "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                activeSegmentIdx === idx
                  ? "bg-violet-600 text-white"
                  : "text-gray-400 hover:text-gray-200"
              )}
            >
              {seg.label}
            </button>
          ))}
        </div>
      )}

      {/* Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {segmentStats.map(seg => (
          <div key={seg.value} className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition-colors">
            <div className="flex items-start justify-between mb-1">
              <ThumbnailCluster thumbnails={seg.thumbnails} colors={seg.colors} />
              {seg.hitRate >= 30 && (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                  <Trophy className="w-3 h-3" />Proven
                </span>
              )}
            </div>
            <div className="text-sm font-semibold text-gray-100 truncate mb-0.5">{seg.value}</div>
            <div className="text-xs text-gray-500 mb-3">{seg.count} créas · {seg.winners} winner{seg.winners !== 1 ? "s" : ""}</div>

            <div className="space-y-1.5 mb-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500 flex items-center gap-1"><DollarSign className="w-3 h-3" />Spend</span>
                <span className="text-gray-200 font-medium">${seg.totalSpend.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500 flex items-center gap-1"><TrendingUp className="w-3 h-3" />ROAS</span>
                <span className={cn("font-semibold", seg.avgRoas >= 3 ? "text-emerald-400" : seg.avgRoas >= 2 ? "text-blue-400" : "text-gray-400")}>
                  {seg.avgRoas.toFixed(2)}x
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">CPA</span>
                <span className="text-gray-200 font-medium">${seg.avgCpa.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">CTR</span>
                <span className="text-gray-200 font-medium">{seg.avgCtr.toFixed(2)}%</span>
              </div>
            </div>

            {/* Hit rate bar */}
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-gray-500">Hit Rate</span>
              <span className={cn("font-semibold", seg.hitRate >= 30 ? "text-emerald-400" : seg.hitRate < 10 ? "text-red-400" : "text-amber-400")}>
                {seg.hitRate.toFixed(0)}%
              </span>
            </div>
            <div className="h-1 bg-gray-800 rounded-full overflow-hidden mb-2">
              <div
                className={cn("h-full rounded-full", seg.hitRate >= 30 ? "bg-emerald-500" : seg.hitRate >= 10 ? "bg-amber-500" : "bg-red-500")}
                style={{ width: `${Math.min(100, seg.hitRate)}%` }}
              />
            </div>

            {/* Spend share bar */}
            <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-500 rounded-full"
                style={{ width: `${Math.min(100, (seg.totalSpend / maxSpend) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {segmentStats.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-gray-600">
          <Layers className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">Aucun pattern trouvé</p>
          {!namingConfig && <p className="text-xs mt-1">Configure ton naming convention sur la page Naming</p>}
        </div>
      )}
    </div>
  );
}
