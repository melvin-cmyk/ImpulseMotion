"use client";

import { useMemo, useState, useEffect } from "react";
import { Creative } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import { MessageSquare, ChevronUp, ChevronDown, Trophy, Flame, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { loadNamingConfig, NamingConfig, parseSegmentValue } from "@/lib/naming-config";

type SortKey = "spend" | "cpa" | "ctr" | "roas" | "hitRate" | "count";

interface AngleStats {
  angle: string;
  count: number;
  winners: number;
  totalSpend: number;
  avgCpa: number;
  avgCtr: number;
  avgRoas: number;
  hitRate: number;
}

function buildAngleStats(creatives: Creative[], config: NamingConfig): AngleStats[] {
  const angleSegment = config.segments[config.segments.length - 1] ?? { label: "Angle", position: 2 };

  const map = new Map<string, Creative[]>();
  for (const c of creatives) {
    const angle = parseSegmentValue(c.name, angleSegment.position, config.separator);
    if (!map.has(angle)) map.set(angle, []);
    map.get(angle)!.push(c);
  }

  return Array.from(map.entries()).map(([angle, items]) => {
    const totalSpend = items.reduce((s, c) => s + c.spend, 0);
    const avgCpa = items.reduce((s, c) => s + c.cpa, 0) / items.length;
    const avgCtr = items.reduce((s, c) => s + c.ctr, 0) / items.length;
    const avgRoas = items.reduce((s, c) => s + c.roas, 0) / items.length;
    const winners = items.filter(c => c.status === "Winner").length;
    const hitRate = items.length > 0 ? (winners / items.length) * 100 : 0;
    return { angle, count: items.length, winners, totalSpend, avgCpa, avgCtr, avgRoas, hitRate };
  });
}

function HitBadge({ rate }: { rate: number }) {
  if (rate >= 30)
    return <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-semibold"><Trophy className="w-3 h-3" />Proven</span>;
  if (rate < 10)
    return <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 font-semibold"><Flame className="w-3 h-3" />Weak</span>;
  return <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-400 border border-gray-600 font-semibold"><Activity className="w-3 h-3" />Testing</span>;
}

export default function AnglesPage() {
  const { creatives } = useCreativesContext();
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortAsc, setSortAsc] = useState(false);
  const [namingConfig, setNamingConfig] = useState<NamingConfig | null>(null);

  useEffect(() => {
    setNamingConfig(loadNamingConfig());
  }, []);

  const angleStats = useMemo(() => {
    if (!namingConfig) return [];
    return buildAngleStats(creatives, namingConfig);
  }, [creatives, namingConfig]);

  const sorted = useMemo(() => {
    return [...angleStats].sort((a, b) => {
      let diff = 0;
      if (sortKey === "spend") diff = a.totalSpend - b.totalSpend;
      else if (sortKey === "cpa") diff = a.avgCpa - b.avgCpa;
      else if (sortKey === "ctr") diff = a.avgCtr - b.avgCtr;
      else if (sortKey === "roas") diff = a.avgRoas - b.avgRoas;
      else if (sortKey === "hitRate") diff = a.hitRate - b.hitRate;
      else if (sortKey === "count") diff = a.count - b.count;
      return sortAsc ? diff : -diff;
    });
  }, [angleStats, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(false); }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <ChevronUp className="w-3 h-3 opacity-30" />;
    return sortAsc ? <ChevronUp className="w-3 h-3 text-violet-400" /> : <ChevronDown className="w-3 h-3 text-violet-400" />;
  }

  const totalSpend = angleStats.reduce((s, a) => s + a.totalSpend, 0);
  const provenAngles = angleStats.filter(a => a.hitRate >= 30);
  const bestAngle = [...angleStats].sort((a, b) => b.avgRoas - a.avgRoas)[0];
  const segmentLabel = namingConfig?.segments[namingConfig.segments.length - 1]?.label ?? "Angle";

  return (
    <div className="flex-1 overflow-auto bg-gray-950 p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 bg-violet-600/20 rounded-xl flex items-center justify-center">
          <MessageSquare className="w-5 h-5 text-violet-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Angles</h1>
          <p className="text-xs text-gray-500">Performance par angle de messaging · segment «{segmentLabel}»</p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Angles testés</p>
          <p className="text-2xl font-bold text-gray-100">{angleStats.length}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Angles Proven</p>
          <p className="text-2xl font-bold text-emerald-400">{provenAngles.length}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Total Spend</p>
          <p className="text-2xl font-bold text-gray-100">${totalSpend.toLocaleString()}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Meilleur ROAS</p>
          <p className="text-lg font-bold text-violet-300 truncate">{bestAngle?.angle ?? "—"}</p>
          {bestAngle && <p className="text-xs text-gray-500">{bestAngle.avgRoas.toFixed(2)}x</p>}
        </div>
      </div>

      {/* Proven angles highlight */}
      {provenAngles.length > 0 && (
        <div className="bg-emerald-950/40 border border-emerald-500/20 rounded-xl p-4 mb-6">
          <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wide mb-3 flex items-center gap-1.5">
            <Trophy className="w-3.5 h-3.5" /> Angles Proven (Hit Rate ≥ 30%)
          </p>
          <div className="flex flex-wrap gap-2">
            {provenAngles.map(a => (
              <div key={a.angle} className="bg-emerald-900/30 border border-emerald-500/30 rounded-lg px-3 py-1.5">
                <span className="text-emerald-300 font-semibold text-sm">{a.angle}</span>
                <span className="text-emerald-500 text-xs ml-2">{a.hitRate.toFixed(0)}% · ROAS {a.avgRoas.toFixed(2)}x</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500 text-xs">
              <th className="text-left px-4 py-3 font-medium">Angle</th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("count")}>
                <span className="flex items-center justify-end gap-1"># Ads <SortIcon k="count" /></span>
              </th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("spend")}>
                <span className="flex items-center justify-end gap-1">Spend <SortIcon k="spend" /></span>
              </th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("roas")}>
                <span className="flex items-center justify-end gap-1">ROAS <SortIcon k="roas" /></span>
              </th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("cpa")}>
                <span className="flex items-center justify-end gap-1">Avg CPA <SortIcon k="cpa" /></span>
              </th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("ctr")}>
                <span className="flex items-center justify-end gap-1">CTR <SortIcon k="ctr" /></span>
              </th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("hitRate")}>
                <span className="flex items-center justify-end gap-1">Hit Rate <SortIcon k="hitRate" /></span>
              </th>
              <th className="text-right px-4 py-3 font-medium">Statut</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a, i) => (
              <tr key={a.angle} className={cn("border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors", i === sorted.length - 1 && "border-0")}>
                <td className="px-4 py-3 text-gray-200 font-medium">{a.angle}</td>
                <td className="px-4 py-3 text-right text-gray-400">{a.count}</td>
                <td className="px-4 py-3 text-right text-gray-200">${a.totalSpend.toLocaleString()}</td>
                <td className="px-4 py-3 text-right">
                  <span className={cn("font-semibold", a.avgRoas >= 3 ? "text-emerald-400" : a.avgRoas >= 2 ? "text-blue-400" : "text-gray-400")}>
                    {a.avgRoas.toFixed(2)}x
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-gray-200">${a.avgCpa.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-gray-200">{a.avgCtr.toFixed(2)}%</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div className={cn("h-full rounded-full", a.hitRate >= 30 ? "bg-emerald-500" : a.hitRate >= 10 ? "bg-amber-500" : "bg-red-500")} style={{ width: `${Math.min(100, a.hitRate)}%` }} />
                    </div>
                    <span className={cn("font-semibold text-xs w-8 text-right", a.hitRate >= 30 ? "text-emerald-400" : a.hitRate < 10 ? "text-red-400" : "text-gray-400")}>
                      {a.hitRate.toFixed(0)}%
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <HitBadge rate={a.hitRate} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-600">
            <MessageSquare className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">Aucun angle trouvé</p>
            <p className="text-xs mt-1">Configure ton naming convention sur la page Naming</p>
          </div>
        )}
      </div>
    </div>
  );
}
