"use client";

import { useMemo } from "react";
import { useCreativesContext } from "@/lib/creatives-context";
import { Creative, Format } from "@/lib/mock-data";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Layers } from "lucide-react";

type VisualFormat = "Vidéo Portrait" | "Vidéo Landscape" | "Vidéo Carré" | "Image" | "Carousel";

interface FormatGroup {
  format: VisualFormat;
  creatives: Creative[];
  spend: number;
  roas: number;
  ctr: number;
  cpa: number;
  thumbnails: string[];
}

function detectVisualFormat(c: Creative): VisualFormat {
  if (c.format === "Carousel") return "Carousel";
  if (c.format === "Image") return "Image";
  // Video — detect ratio from name heuristics or default to Portrait
  const name = c.name.toLowerCase();
  if (name.includes("landscape") || name.includes("16x9") || name.includes("16-9")) {
    return "Vidéo Landscape";
  }
  if (name.includes("square") || name.includes("1x1") || name.includes("carré")) {
    return "Vidéo Carré";
  }
  // Default video → Portrait (most Meta ads)
  return "Vidéo Portrait";
}

function avg(values: number[]): number {
  const valid = values.filter((v) => v > 0);
  if (valid.length === 0) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

const FORMAT_COLORS: Record<VisualFormat, string> = {
  "Vidéo Portrait": "#7c3aed",
  "Vidéo Landscape": "#2563eb",
  "Vidéo Carré": "#0891b2",
  Image: "#059669",
  Carousel: "#d97706",
};

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#1a1a2e] border border-white/10 rounded-lg px-3 py-2 text-xs">
      <p className="font-semibold text-white mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: {p.name === "Spend" ? `$${p.value.toFixed(0)}` : p.value.toFixed(2)}
        </p>
      ))}
    </div>
  );
};

export default function VisualFormatPage() {
  const { creatives, isLoading } = useCreativesContext();

  const groups = useMemo<FormatGroup[]>(() => {
    const map = new Map<VisualFormat, Creative[]>();

    for (const c of creatives) {
      const fmt = detectVisualFormat(c);
      if (!map.has(fmt)) map.set(fmt, []);
      map.get(fmt)!.push(c);
    }

    return Array.from(map.entries())
      .map(([format, items]) => ({
        format,
        creatives: items,
        spend: items.reduce((s, c) => s + c.spend, 0),
        roas: avg(items.map((c) => c.roas)),
        ctr: avg(items.map((c) => c.ctr)),
        cpa: avg(items.map((c) => c.cpa)),
        thumbnails: items
          .filter((c) => c.thumbnailUrl)
          .slice(0, 4)
          .map((c) => c.thumbnailUrl!),
      }))
      .sort((a, b) => b.spend - a.spend);
  }, [creatives]);

  const chartData = useMemo(
    () =>
      groups.map((g) => ({
        name: g.format,
        Spend: g.spend,
        ROAS: g.roas,
      })),
    [groups]
  );

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
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Layers className="w-5 h-5 text-violet-400" />
          Format Visuel
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Comparez les performances par format de créa
        </p>
      </div>

      {/* Bar chart */}
      <div className="bg-[#0d0d1a] border border-white/5 rounded-xl p-5 mb-5">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold text-white">Spend par format</p>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-violet-600 inline-block" />
              Spend
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-amber-500 inline-block" />
              ROAS
            </span>
          </div>
        </div>

        {/* Thumbnail clusters above bars */}
        <div
          className="flex mb-2"
          style={{ paddingLeft: 60, paddingRight: 20 }}
        >
          {groups.map((g) => (
            <div
              key={g.format}
              className="flex-1 flex justify-center"
            >
              <div className="flex gap-0.5">
                {g.thumbnails.slice(0, 3).map((url, i) => (
                  <img
                    key={i}
                    src={url}
                    alt=""
                    className="w-7 h-7 rounded object-cover opacity-80"
                  />
                ))}
                {g.thumbnails.length === 0 && (
                  <div
                    className="w-7 h-7 rounded"
                    style={{ background: FORMAT_COLORS[g.format] + "33" }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>

        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} barGap={4} barCategoryGap="30%">
            <XAxis
              dataKey="name"
              tick={{ fill: "#6b7280", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              yAxisId="spend"
              orientation="left"
              tick={{ fill: "#6b7280", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
              width={50}
            />
            <YAxis
              yAxisId="roas"
              orientation="right"
              tick={{ fill: "#6b7280", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `${v.toFixed(1)}×`}
              width={40}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
            <Bar yAxisId="spend" dataKey="Spend" radius={[4, 4, 0, 0]}>
              {chartData.map((entry) => (
                <Cell
                  key={entry.name}
                  fill={FORMAT_COLORS[entry.name as VisualFormat] ?? "#7c3aed"}
                />
              ))}
            </Bar>
            <Bar yAxisId="roas" dataKey="ROAS" radius={[4, 4, 0, 0]} fill="#f59e0b" opacity={0.7}>
              {chartData.map((entry) => (
                <Cell key={entry.name} fill="#f59e0b" />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Summary table */}
      <div className="bg-[#0d0d1a] border border-white/5 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5">
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Format</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500">Créas</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500">Spend</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500">CPA moy.</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500">CTR moy.</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500">ROAS moy.</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g, i) => (
              <tr
                key={g.format}
                className={`border-b border-white/5 hover:bg-white/[0.02] transition-colors ${
                  i === groups.length - 1 ? "border-b-0" : ""
                }`}
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: FORMAT_COLORS[g.format] }}
                    />
                    <span className="text-white font-medium">{g.format}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-gray-400">{g.creatives.length}</td>
                <td className="px-4 py-3 text-right text-white font-medium">
                  ${g.spend.toLocaleString("fr-FR", { maximumFractionDigits: 0 })}
                </td>
                <td className="px-4 py-3 text-right text-gray-300">
                  {g.cpa > 0 ? `$${g.cpa.toFixed(2)}` : "—"}
                </td>
                <td className="px-4 py-3 text-right text-gray-300">
                  {g.ctr > 0 ? `${g.ctr.toFixed(2)}%` : "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  <span
                    className={`font-semibold ${
                      g.roas >= 2 ? "text-emerald-400" : g.roas >= 1 ? "text-yellow-400" : "text-red-400"
                    }`}
                  >
                    {g.roas > 0 ? `${g.roas.toFixed(2)}×` : "—"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
