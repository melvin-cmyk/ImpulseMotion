"use client";

import { useMemo } from "react";
import { Creative, Format } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import { Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHelp } from "@/components/ui/page-help";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from "recharts";

interface FormatStats {
  format: Format;
  count: number;
  totalSpend: number;
  avgCpa: number;
  avgCtr: number;
  avgRoas: number;
  bestCreative?: Creative;
  color: string;
}

const FORMAT_COLORS: Record<Format, string> = {
  Video: "#8b5cf6",
  Image: "#60a5fa",
  Carousel: "#34d399",
};

function buildFormatStats(creatives: Creative[]): FormatStats[] {
  const map = new Map<Format, Creative[]>();
  for (const c of creatives) {
    if (!map.has(c.format)) map.set(c.format, []);
    map.get(c.format)!.push(c);
  }

  return Array.from(map.entries())
    .map(([format, items]) => {
      const totalSpend = items.reduce((s, c) => s + c.spend, 0);
      const avgCpa = items.reduce((s, c) => s + c.cpa, 0) / items.length;
      const avgCtr = items.reduce((s, c) => s + c.ctr, 0) / items.length;
      const avgRoas = items.reduce((s, c) => s + c.roas, 0) / items.length;
      const bestCreative = [...items].sort((a, b) => b.roas - a.roas)[0];
      return { format, count: items.length, totalSpend, avgCpa, avgCtr, avgRoas, bestCreative, color: FORMAT_COLORS[format] };
    })
    .sort((a, b) => b.totalSpend - a.totalSpend);
}

interface TooltipEntry {
  dataKey: string;
  name: string;
  value: number;
  fill: string;
}

interface TooltipProps {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}

const CustomTooltip = ({ active, payload, label }: TooltipProps) => {
  if (!active || !payload) return null;
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-gray-200 font-semibold mb-2">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex justify-between gap-4">
          <span style={{ color: p.fill }}>{p.name}</span>
          <span className="text-gray-200 font-medium">{p.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
};

export default function VisualFormatPage() {
  const { creatives } = useCreativesContext();
  const formatStats = useMemo(() => buildFormatStats(creatives), [creatives]);

  const spendChartData = formatStats.map(f => ({ name: f.format, Spend: Math.round(f.totalSpend), color: f.color }));
  const perfChartData = formatStats.map(f => ({ name: f.format, "Avg CPA": parseFloat(f.avgCpa.toFixed(2)), "Avg CTR (%)": parseFloat(f.avgCtr.toFixed(2)), color: f.color }));

  return (
    <div className="flex-1 overflow-auto bg-gray-950 p-6">
      {/* Page Help */}
      <PageHelp
        title="Visual Format — Vidéo vs Image vs Carrousel"
        description="Compare les performances par format créatif (Vidéo, Image, Carrousel). Identifie quel format génère le meilleur ROAS et le CPA le plus bas pour allouer ton budget de production intelligemment."
        steps={[
          "Consulte les graphiques en haut : Spend par format à gauche, CPA & CTR par format à droite.",
          "Lis le tableau récapitulatif pour comparer ROAS moyen, CPA et nombre de créas par format.",
          "Identifie la 'Meilleure créa' par format dans la dernière colonne pour t'inspirer des templates qui marchent.",
        ]}
        tip="Si la Vidéo a un ROAS bien supérieur à l'Image mais représente moins de 30% de ton budget, c'est un signal fort pour réorienter ta production créa."
      />
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 bg-violet-600/20 rounded-xl flex items-center justify-center">
          <Monitor className="w-5 h-5 text-violet-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Visual Format</h1>
          <p className="text-xs text-gray-500">Comparaison de performance par format créatif</p>
        </div>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Spend by format */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-200 mb-4">Spend par format</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={spendChartData} barSize={40}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="name" tick={{ fill: "#9ca3af", fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="Spend" radius={[4, 4, 0, 0]}>
                {spendChartData.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* CPA & CTR by format */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-200 mb-4">CPA & CTR par format</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={perfChartData} barSize={20}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="name" tick={{ fill: "#9ca3af", fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12, color: "#9ca3af" }} />
              <Bar dataKey="Avg CPA" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
              <Bar dataKey="Avg CTR (%)" fill="#60a5fa" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Summary table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-200">Récap par format</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500 text-xs">
              <th className="text-left px-4 py-3 font-medium">Format</th>
              <th className="text-right px-4 py-3 font-medium"># Créas</th>
              <th className="text-right px-4 py-3 font-medium">Total Spend</th>
              <th className="text-right px-4 py-3 font-medium">Avg CPA</th>
              <th className="text-right px-4 py-3 font-medium">Avg CTR</th>
              <th className="text-right px-4 py-3 font-medium">Avg ROAS</th>
              <th className="text-right px-4 py-3 font-medium">Meilleure créa</th>
            </tr>
          </thead>
          <tbody>
            {formatStats.map((f, i) => (
              <tr key={f.format} className={cn("hover:bg-gray-800/30 transition-colors", i < formatStats.length - 1 && "border-b border-gray-800/50")}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: f.color }} />
                    <span className="text-gray-200 font-medium">{f.format}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-gray-400">{f.count}</td>
                <td className="px-4 py-3 text-right text-gray-200">${f.totalSpend.toLocaleString()}</td>
                <td className="px-4 py-3 text-right text-gray-200">${f.avgCpa.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-gray-200">{f.avgCtr.toFixed(2)}%</td>
                <td className="px-4 py-3 text-right">
                  <span className={cn("font-semibold", f.avgRoas >= 2 ? "text-emerald-400" : f.avgRoas >= 1 ? "text-yellow-400" : "text-red-400")}>
                    {f.avgRoas.toFixed(2)}x
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  {f.bestCreative ? (
                    <div className="flex items-center justify-end gap-2">
                      <span className="text-xs text-gray-400 truncate max-w-[120px]">{f.bestCreative.name}</span>
                      {f.bestCreative.thumbnailUrl ? (
                        <img src={f.bestCreative.thumbnailUrl} alt="" className="w-7 h-7 rounded-md object-cover" />
                      ) : (
                        <div className="w-7 h-7 rounded-md" style={{ background: f.bestCreative.thumbnailColor }} />
                      )}
                    </div>
                  ) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
