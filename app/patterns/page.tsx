"use client";

import { useMemo, useState } from "react";
import { Creative } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import { Layers, TrendingUp, DollarSign, Users } from "lucide-react";
import { cn } from "@/lib/utils";

type SegmentTab = "all" | "product" | "format" | "angle";

interface SegmentStats {
  value: string;
  segment: string;
  count: number;
  winners: number;
  totalSpend: number;
  avgCpa: number;
  avgCtr: number;
  thumbnails: string[];
  colors: string[];
}

function parseSegments(name: string): { product: string; format: string; angle: string } {
  const parts = name.split("_");
  return {
    product: parts[0] || "Unknown",
    format: parts[1] || "Unknown",
    angle: parts[2] || "Unknown",
  };
}

function buildSegmentStats(creatives: Creative[], segmentKey: "product" | "format" | "angle"): SegmentStats[] {
  const map = new Map<string, Creative[]>();
  for (const c of creatives) {
    const segs = parseSegments(c.name);
    const val = segs[segmentKey];
    if (!map.has(val)) map.set(val, []);
    map.get(val)!.push(c);
  }

  return Array.from(map.entries())
    .map(([value, items]) => {
      const totalSpend = items.reduce((s, c) => s + c.spend, 0);
      const avgCpa = items.reduce((s, c) => s + c.cpa, 0) / items.length;
      const avgCtr = items.reduce((s, c) => s + c.ctr, 0) / items.length;
      const winners = items.filter(c => c.status === "Winner").length;
      const thumbnails = items
        .filter(c => c.thumbnailUrl)
        .slice(0, 3)
        .map(c => c.thumbnailUrl!);
      const colors = items.slice(0, 3).map(c => c.thumbnailColor);
      return { value, segment: segmentKey, count: items.length, winners, totalSpend, avgCpa, avgCtr, thumbnails, colors };
    })
    .sort((a, b) => b.totalSpend - a.totalSpend);
}

function ThumbnailCluster({ thumbnails, colors }: { thumbnails: string[]; colors: string[] }) {
  const items = thumbnails.length > 0 ? thumbnails : [];
  return (
    <div className="flex -space-x-2 mb-3">
      {items.slice(0, 3).map((url, i) => (
        <div key={i} className="w-10 h-10 rounded-lg border-2 border-gray-900 overflow-hidden">
          <img src={url} alt="" className="w-full h-full object-cover" />
        </div>
      ))}
      {items.length === 0 && colors.slice(0, 3).map((color, i) => (
        <div key={i} className="w-10 h-10 rounded-lg border-2 border-gray-900" style={{ background: color }} />
      ))}
    </div>
  );
}

export default function PatternsPage() {
  const { creatives } = useCreativesContext();
  const [activeTab, setActiveTab] = useState<SegmentTab>("product");

  const tabs: { key: SegmentTab; label: string }[] = [
    { key: "product", label: "Product" },
    { key: "format", label: "Format" },
    { key: "angle", label: "Angle" },
  ];

  const segmentStats = useMemo(() => {
    if (activeTab === "all") {
      return buildSegmentStats(creatives, "product");
    }
    return buildSegmentStats(creatives, activeTab as "product" | "format" | "angle");
  }, [creatives, activeTab]);

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

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 rounded-xl p-1 mb-6 w-fit">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
              activeTab === tab.key
                ? "bg-violet-600 text-white"
                : "text-gray-400 hover:text-gray-200"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {segmentStats.map(seg => (
          <div key={seg.value} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-start justify-between mb-1">
              <ThumbnailCluster thumbnails={seg.thumbnails} colors={seg.colors} />
              {seg.winners >= 3 && (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  Proven
                </span>
              )}
            </div>
            <div className="text-sm font-semibold text-gray-100 truncate mb-0.5">{seg.value}</div>
            <div className="text-xs text-gray-500 mb-3">{seg.count} créas · {seg.winners} winner{seg.winners !== 1 ? "s" : ""}</div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500 flex items-center gap-1"><DollarSign className="w-3 h-3" />Spend</span>
                <span className="text-gray-200 font-medium">${seg.totalSpend.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500 flex items-center gap-1"><TrendingUp className="w-3 h-3" />CPA</span>
                <span className="text-gray-200 font-medium">${seg.avgCpa.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500 flex items-center gap-1"><Users className="w-3 h-3" />CTR</span>
                <span className="text-gray-200 font-medium">{seg.avgCtr.toFixed(2)}%</span>
              </div>
            </div>

            {/* Spend bar */}
            <div className="mt-3">
              <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-violet-500 rounded-full"
                  style={{ width: `${Math.min(100, (seg.totalSpend / (segmentStats[0]?.totalSpend || 1)) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {segmentStats.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-gray-600">
          <Layers className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">Aucun pattern trouvé</p>
        </div>
      )}
    </div>
  );
}
