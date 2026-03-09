"use client";

import { useMemo, useState } from "react";
import { Creative } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Tag } from "lucide-react";

type Segment = "Angle" | "Format" | "Product";

interface GroupStats {
  key: string;
  count: number;
  spend: number;
  roas: number;
  cpa: number;
  ctr: number;
  winners: number;
}

const COLORS = [
  "#8b5cf6", "#6366f1", "#3b82f6", "#06b6d4", "#10b981",
  "#f59e0b", "#ef4444", "#ec4899", "#a78bfa", "#34d399",
];

function parseSegment(name: string, segment: Segment): string {
  const parts = name.split("_");
  if (segment === "Product") return parts[0] ?? "Unknown";
  if (segment === "Format") return parts[1] ?? "Unknown";
  if (segment === "Angle") return parts[2] ?? "Unknown";
  return "Unknown";
}

function groupBySegment(segment: Segment, creatives: Creative[]): GroupStats[] {
  const map: Record<string, GroupStats> = {};
  for (const c of creatives) {
    const key = parseSegment(c.name, segment);
    if (!map[key]) {
      map[key] = { key, count: 0, spend: 0, roas: 0, cpa: 0, ctr: 0, winners: 0 };
    }
    map[key].count++;
    map[key].spend += c.spend;
    map[key].roas += c.roas;
    map[key].cpa += c.cpa;
    map[key].ctr += c.ctr;
    if (c.status === "Winner") map[key].winners++;
  }
  return Object.values(map).map((g) => ({
    ...g,
    spend: Math.round(g.spend),
    roas: Math.round((g.roas / g.count) * 100) / 100,
    cpa: Math.round((g.cpa / g.count) * 100) / 100,
    ctr: Math.round((g.ctr / g.count) * 100) / 100,
  })).sort((a, b) => b.roas - a.roas);
}

function StatTable({ data }: { data: GroupStats[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 text-xs uppercase tracking-wide border-b border-gray-800">
            <th className="text-left py-2 pr-4">Name</th>
            <th className="text-right py-2 px-3">Creatives</th>
            <th className="text-right py-2 px-3">Spend</th>
            <th className="text-right py-2 px-3">Avg ROAS</th>
            <th className="text-right py-2 px-3">Avg CPA</th>
            <th className="text-right py-2 px-3">Avg CTR</th>
            <th className="text-right py-2 px-3">Winners</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={row.key} className="border-b border-gray-800/50 hover:bg-gray-800/30">
              <td className="py-2.5 pr-4">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: COLORS[i % COLORS.length] }}
                  />
                  <span className="font-mono font-medium text-gray-200">{row.key}</span>
                </div>
              </td>
              <td className="text-right py-2.5 px-3 text-gray-300">{row.count}</td>
              <td className="text-right py-2.5 px-3 text-gray-300">${(row.spend / 1000).toFixed(1)}k</td>
              <td className="text-right py-2.5 px-3">
                <span className={`font-semibold ${row.roas >= 3 ? "text-green-400" : row.roas >= 2 ? "text-yellow-400" : "text-red-400"}`}>
                  {row.roas}x
                </span>
              </td>
              <td className="text-right py-2.5 px-3 text-gray-300">${row.cpa}</td>
              <td className="text-right py-2.5 px-3 text-gray-300">{row.ctr}%</td>
              <td className="text-right py-2.5 px-3">
                {row.winners > 0 ? (
                  <span className="text-green-400 font-semibold">{row.winners} 🏆</span>
                ) : (
                  <span className="text-gray-600">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function NamingPage() {
  const { creatives } = useCreativesContext();
  const [segment, setSegment] = useState<Segment>("Angle");
  const data = useMemo(() => groupBySegment(segment, creatives), [segment, creatives]);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Tag className="w-5 h-5 text-violet-400" />
            <h1 className="text-2xl font-bold text-white">Naming Convention</h1>
          </div>
          <p className="text-gray-400 text-sm">
            Analyze performance by segment — parsed from{" "}
            <span className="font-mono text-gray-300">PRODUCT_FORMAT_ANGLE</span>
          </p>
        </div>

        {/* Segment selector */}
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
          {(["Angle", "Format", "Product"] as Segment[]).map((s) => (
            <button
              key={s}
              onClick={() => setSegment(s)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                segment === s
                  ? "bg-violet-600 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">
          Avg ROAS by {segment}
        </h2>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="key" tick={{ fill: "#9ca3af", fontSize: 12 }} />
            <YAxis tick={{ fill: "#9ca3af", fontSize: 12 }} />
            <Tooltip
              contentStyle={{
                background: "#111827",
                border: "1px solid #374151",
                borderRadius: "8px",
                fontSize: "12px",
                color: "#e5e7eb",
              }}
              formatter={(v: unknown) => [`${v}x`, "Avg ROAS"]}
            />
            <Bar dataKey="roas" radius={[6, 6, 0, 0]}>
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">
          Performance by {segment}
        </h2>
        <StatTable data={data} />
      </div>

      {/* Insights */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">
          Key Insights
        </h2>
        <div className="space-y-3">
          {data.slice(0, 3).map((row, i) => {
            const rank = ["🥇", "🥈", "🥉"][i];
            return (
              <div key={row.key} className="flex items-start gap-3 text-sm">
                <span className="text-lg leading-none">{rank}</span>
                <div>
                  <span className="font-mono font-semibold text-gray-200">{row.key}</span>
                  <span className="text-gray-400">
                    {" "}— {row.roas}x ROAS avg · ${row.cpa} CPA · {row.count} creative{row.count > 1 ? "s" : ""}
                    {row.winners > 0 && ` · ${row.winners} winner${row.winners > 1 ? "s" : ""}`}
                  </span>
                </div>
              </div>
            );
          })}
          {data.at(-1) && data.length > 3 && (
            <div className="flex items-start gap-3 text-sm">
              <span className="text-lg leading-none">⚠️</span>
              <div>
                <span className="font-mono font-semibold text-gray-200">{data.at(-1)!.key}</span>
                <span className="text-gray-400">
                  {" "}— lowest performer at {data.at(-1)!.roas}x ROAS · consider pausing or refreshing these creatives
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
