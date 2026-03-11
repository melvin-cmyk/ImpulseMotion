"use client";

import { useMemo, useState } from "react";
import { Creative } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import { MessageSquare, TrendingUp, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type SortKey = "spend" | "cpa" | "ctr" | "hitRate" | "count";

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

function buildAngleStats(creatives: Creative[]): AngleStats[] {
  const map = new Map<string, Creative[]>();
  for (const c of creatives) {
    const parts = c.name.split("_");
    const angle = parts[2] || parts[1] || parts[0] || "Unknown";
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
    return <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-semibold">Proven</span>;
  if (rate < 10)
    return <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 font-semibold">Weak</span>;
  return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-400 border border-gray-600 font-semibold">Testing</span>;
}

export default function AnglesPage() {
  const { creatives } = useCreativesContext();
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortAsc, setSortAsc] = useState(false);

  const angleStats = useMemo(() => buildAngleStats(creatives), [creatives]);

  const sorted = useMemo(() => {
    return [...angleStats].sort((a, b) => {
      let diff = 0;
      if (sortKey === "spend") diff = a.totalSpend - b.totalSpend;
      else if (sortKey === "cpa") diff = a.avgCpa - b.avgCpa;
      else if (sortKey === "ctr") diff = a.avgCtr - b.avgCtr;
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

  return (
    <div className="flex-1 overflow-auto bg-gray-950 p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 bg-violet-600/20 rounded-xl flex items-center justify-center">
          <MessageSquare className="w-5 h-5 text-violet-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Angles</h1>
          <p className="text-xs text-gray-500">Performance par angle de messaging (3e segment du naming)</p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Angles testés</p>
          <p className="text-2xl font-bold text-gray-100">{angleStats.length}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Angles Proven</p>
          <p className="text-2xl font-bold text-emerald-400">{angleStats.filter(a => a.hitRate >= 30).length}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Total Spend</p>
          <p className="text-2xl font-bold text-gray-100">${totalSpend.toLocaleString()}</p>
        </div>
      </div>

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
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("cpa")}>
                <span className="flex items-center justify-end gap-1">Avg CPA <SortIcon k="cpa" /></span>
              </th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("ctr")}>
                <span className="flex items-center justify-end gap-1">CTR <SortIcon k="ctr" /></span>
              </th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("hitRate")}>
                <span className="flex items-center justify-end gap-1">Hit Rate <SortIcon k="hitRate" /></span>
              </th>
              <th className="text-right px-4 py-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a, i) => (
              <tr key={a.angle} className={cn("border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors", i === sorted.length - 1 && "border-0")}>
                <td className="px-4 py-3 text-gray-200 font-medium">{a.angle}</td>
                <td className="px-4 py-3 text-right text-gray-400">{a.count}</td>
                <td className="px-4 py-3 text-right text-gray-200">${a.totalSpend.toLocaleString()}</td>
                <td className="px-4 py-3 text-right text-gray-200">${a.avgCpa.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-gray-200">{a.avgCtr.toFixed(2)}%</td>
                <td className="px-4 py-3 text-right">
                  <span className={cn(
                    "font-semibold",
                    a.hitRate >= 30 ? "text-emerald-400" : a.hitRate < 10 ? "text-red-400" : "text-gray-400"
                  )}>
                    {a.hitRate.toFixed(0)}%
                  </span>
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
          </div>
        )}
      </div>
    </div>
  );
}
