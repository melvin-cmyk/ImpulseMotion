"use client";

import { useState } from "react";
import { mockCreatives } from "@/lib/mock-data";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { ArrowRight, TrendingUp, TrendingDown, Minus } from "lucide-react";

type Creative = (typeof mockCreatives)[0];

interface Metric {
  key: keyof Creative;
  label: string;
  format: (v: number) => string;
  higherIsBetter: boolean;
  chartScale?: number;
}

const METRICS: Metric[] = [
  {
    key: "spend",
    label: "Spend",
    format: (v) => `$${(v / 1000).toFixed(1)}k`,
    higherIsBetter: true,
  },
  {
    key: "roas",
    label: "ROAS",
    format: (v) => `${v}x`,
    higherIsBetter: true,
  },
  {
    key: "cpa",
    label: "CPA",
    format: (v) => `$${v}`,
    higherIsBetter: false,
  },
  {
    key: "ctr",
    label: "CTR",
    format: (v) => `${v}%`,
    higherIsBetter: true,
  },
  {
    key: "hookRate",
    label: "Hook Rate",
    format: (v) => (v > 0 ? `${v}%` : "—"),
    higherIsBetter: true,
  },
  {
    key: "holdRate",
    label: "Hold Rate",
    format: (v) => (v > 0 ? `${v}%` : "—"),
    higherIsBetter: true,
  },
];

function PlatformBadge({ platform }: { platform: string }) {
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
        platform === "Meta"
          ? "bg-blue-900/70 text-blue-300 border border-blue-800"
          : "bg-pink-900/70 text-pink-300 border border-pink-800"
      }`}
    >
      {platform}
    </span>
  );
}

function CreativeCard({ creative }: { creative: Creative }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={`w-12 h-12 rounded-xl bg-gradient-to-br ${creative.thumbnailColor} flex items-center justify-center shrink-0`}
      >
        <span className="text-white/30 text-lg font-black">
          {creative.format === "Video" ? "▶" : creative.format === "Image" ? "◼" : "⊞"}
        </span>
      </div>
      <div>
        <p className="text-sm font-mono text-gray-100 truncate max-w-[180px]">
          {creative.name}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <PlatformBadge platform={creative.platform} />
          <span className="text-[10px] text-gray-500 uppercase">{creative.format}</span>
        </div>
      </div>
    </div>
  );
}

function WinnerIcon({
  winner,
}: {
  winner: "a" | "b" | "tie";
}) {
  if (winner === "tie")
    return <Minus className="w-4 h-4 text-gray-500" />;
  if (winner === "a")
    return <TrendingUp className="w-4 h-4 text-emerald-400" />;
  return <TrendingUp className="w-4 h-4 text-violet-400" />;
}

export default function ComparePage() {
  const [idA, setIdA] = useState<string>(mockCreatives[0].id);
  const [idB, setIdB] = useState<string>(mockCreatives[1].id);

  const creativeA = mockCreatives.find((c) => c.id === idA) ?? mockCreatives[0];
  const creativeB = mockCreatives.find((c) => c.id === idB) ?? mockCreatives[1];

  function getWinner(
    a: number,
    b: number,
    higherIsBetter: boolean
  ): "a" | "b" | "tie" {
    if (a === b || (a === 0 && b === 0)) return "tie";
    if (higherIsBetter) return a > b ? "a" : "b";
    return a < b ? "a" : "b";
  }

  // Count wins
  let winsA = 0;
  let winsB = 0;
  METRICS.forEach((m) => {
    const va = creativeA[m.key] as number;
    const vb = creativeB[m.key] as number;
    if (va === 0 && vb === 0) return;
    const w = getWinner(va, vb, m.higherIsBetter);
    if (w === "a") winsA++;
    else if (w === "b") winsB++;
  });

  const overallWinner: "a" | "b" | "tie" =
    winsA > winsB ? "a" : winsB > winsA ? "b" : "tie";

  // Chart data — normalise spend for readability
  const chartData = METRICS.map((m) => ({
    name: m.label,
    [creativeA.name.slice(0, 12)]: creativeA[m.key] as number,
    [creativeB.name.slice(0, 12)]: creativeB[m.key] as number,
  }));

  const aName = creativeA.name.slice(0, 12);
  const bName = creativeB.name.slice(0, 12);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">A/B Comparison</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          Select two creatives to compare head-to-head
        </p>
      </div>

      {/* Selectors */}
      <div className="grid grid-cols-2 gap-4">
        {[
          {
            label: "Creative A",
            id: idA,
            setId: setIdA,
            color: "border-violet-600",
            accent: "text-violet-400",
          },
          {
            label: "Creative B",
            id: idB,
            setId: setIdB,
            color: "border-emerald-600",
            accent: "text-emerald-400",
          },
        ].map(({ label, id, setId, color, accent }) => {
          const sel = mockCreatives.find((c) => c.id === id)!;
          return (
            <div
              key={label}
              className={`bg-gray-900 border-2 ${color} rounded-2xl p-4 space-y-3`}
            >
              <div className="flex items-center justify-between">
                <p className={`text-xs font-bold uppercase tracking-widest ${accent}`}>
                  {label}
                </p>
                <select
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded-lg px-2 py-1.5 outline-none cursor-pointer max-w-[220px]"
                >
                  {mockCreatives.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <CreativeCard creative={sel} />
            </div>
          );
        })}
      </div>

      {/* Overall Winner Banner */}
      {overallWinner !== "tie" && (
        <div
          className={`flex items-center gap-3 rounded-2xl px-5 py-4 ${
            overallWinner === "a"
              ? "bg-violet-950/50 border border-violet-700/60"
              : "bg-emerald-950/50 border border-emerald-700/60"
          }`}
        >
          <span className="text-2xl">🏆</span>
          <div>
            <p
              className={`font-bold ${
                overallWinner === "a" ? "text-violet-300" : "text-emerald-300"
              }`}
            >
              Creative {overallWinner.toUpperCase()} wins!
            </p>
            <p className="text-gray-400 text-xs mt-0.5">
              {overallWinner === "a" ? creativeA.name : creativeB.name} leads on{" "}
              {overallWinner === "a" ? winsA : winsB} of {METRICS.length} metrics.
            </p>
          </div>
          <div className="ml-auto flex gap-4">
            <div className="text-center">
              <p className="text-violet-400 font-bold text-lg">{winsA}</p>
              <p className="text-gray-500 text-xs">A wins</p>
            </div>
            <ArrowRight className="w-5 h-5 text-gray-600 self-center" />
            <div className="text-center">
              <p className="text-emerald-400 font-bold text-lg">{winsB}</p>
              <p className="text-gray-500 text-xs">B wins</p>
            </div>
          </div>
        </div>
      )}
      {overallWinner === "tie" && (
        <div className="flex items-center gap-3 rounded-2xl px-5 py-4 bg-gray-800/50 border border-gray-700">
          <span className="text-2xl">🤝</span>
          <p className="text-gray-300 font-medium">
            It&apos;s a tie — both creatives are evenly matched across metrics.
          </p>
        </div>
      )}

      {/* Head-to-Head Metric Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        <div className="grid grid-cols-[1fr_120px_40px_120px] gap-0 border-b border-gray-800">
          <div className="px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Metric
          </div>
          <div className="px-4 py-3 text-xs font-semibold text-violet-400 uppercase tracking-wide text-center">
            A — {creativeA.name.slice(0, 14)}
          </div>
          <div className="py-3 text-xs font-semibold text-gray-600 uppercase text-center">
            vs
          </div>
          <div className="px-4 py-3 text-xs font-semibold text-emerald-400 uppercase tracking-wide text-center">
            B — {creativeB.name.slice(0, 14)}
          </div>
        </div>

        {METRICS.map((m, i) => {
          const va = creativeA[m.key] as number;
          const vb = creativeB[m.key] as number;
          const winner = getWinner(va, vb, m.higherIsBetter);
          const skip = va === 0 && vb === 0;

          return (
            <div
              key={m.key}
              className={`grid grid-cols-[1fr_120px_40px_120px] gap-0 ${
                i < METRICS.length - 1 ? "border-b border-gray-800/70" : ""
              }`}
            >
              <div className="px-5 py-4 flex items-center">
                <span className="text-sm text-gray-400 font-medium">{m.label}</span>
              </div>
              {/* A */}
              <div
                className={`px-4 py-4 flex items-center justify-center ${
                  winner === "a" && !skip
                    ? "bg-violet-950/30"
                    : ""
                }`}
              >
                <span
                  className={`text-sm font-bold ${
                    skip
                      ? "text-gray-600"
                      : winner === "a"
                      ? "text-violet-300"
                      : winner === "tie"
                      ? "text-gray-400"
                      : "text-gray-500"
                  }`}
                >
                  {skip ? "—" : m.format(va)}
                </span>
                {winner === "a" && !skip && (
                  <TrendingUp className="w-3.5 h-3.5 text-violet-400 ml-1.5" />
                )}
              </div>
              {/* VS */}
              <div className="py-4 flex items-center justify-center">
                <WinnerIcon winner={winner} />
              </div>
              {/* B */}
              <div
                className={`px-4 py-4 flex items-center justify-center ${
                  winner === "b" && !skip ? "bg-emerald-950/30" : ""
                }`}
              >
                {winner === "b" && !skip && (
                  <TrendingUp className="w-3.5 h-3.5 text-emerald-400 mr-1.5" />
                )}
                <span
                  className={`text-sm font-bold ${
                    skip
                      ? "text-gray-600"
                      : winner === "b"
                      ? "text-emerald-300"
                      : winner === "tie"
                      ? "text-gray-400"
                      : "text-gray-500"
                  }`}
                >
                  {skip ? "—" : m.format(vb)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bar Chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-300 mb-4">
          Visual Comparison
        </h2>
        <p className="text-xs text-gray-500 mb-4">
          Note: Spend is shown in $k, CPA in $, rates as percentages. Values are not
          normalised — use the table above for exact comparison.
        </p>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart
            data={chartData}
            margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
            barCategoryGap="30%"
            barGap={4}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis
              dataKey="name"
              tick={{ fill: "#9ca3af", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: "#9ca3af", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                background: "#111827",
                border: "1px solid #374151",
                borderRadius: "8px",
                fontSize: "12px",
                color: "#e5e7eb",
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: "12px", color: "#9ca3af" }}
            />
            <Bar dataKey={aName} fill="#7c3aed" radius={[4, 4, 0, 0]} />
            <Bar dataKey={bName} fill="#059669" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
