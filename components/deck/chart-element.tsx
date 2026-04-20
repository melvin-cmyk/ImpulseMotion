"use client";

import {
  Bar, BarChart, CartesianGrid, Cell, Legend,
  Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { SlideElement } from "./slide-editor";
import { DEFAULT_CHART_COLORS } from "./slide-editor";
import { useDeckData, resolveChartSource } from "@/lib/deck-data-context";

interface Props {
  el: SlideElement;
}

export function ChartElement({ el }: Props) {
  const deckData = useDeckData();
  const colors = el.chartColors && el.chartColors.length > 0 ? el.chartColors : DEFAULT_CHART_COLORS;
  // Prefer live-bound data from deckData, fall back to static chartData on element.
  const resolved = el.chartSource ? resolveChartSource(deckData, el.chartSource) : null;
  const data = resolved
    ?? (el.chartData && el.chartData.length > 0 ? el.chartData : [{ label: "—", value: 0 }]);
  const type = el.chartType ?? "bar";

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", gap: 2 }}>
      {el.chartTitle && (
        <div style={{ fontSize: 11, fontWeight: 600, color: "#1a1a1a", padding: "2px 4px", fontFamily: "Inter, sans-serif" }}>
          {el.chartTitle}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          {type === "bar" ? (
            <BarChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Bar dataKey="value" fill={colors[0]}>
                {data.map((_, i) => (
                  <Cell key={i} fill={colors[i % colors.length]} />
                ))}
              </Bar>
            </BarChart>
          ) : type === "line" ? (
            <LineChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Line type="monotone" dataKey="value" stroke={colors[0]} strokeWidth={2} dot={{ fill: colors[0], r: 3 }} />
            </LineChart>
          ) : (
            <PieChart margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Pie data={data} dataKey="value" nameKey="label" outerRadius="80%" innerRadius="40%" label={{ fontSize: 10 }}>
                {data.map((_, i) => (
                  <Cell key={i} fill={colors[i % colors.length]} />
                ))}
              </Pie>
            </PieChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
