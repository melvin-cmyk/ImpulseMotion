"use client";

/** Bar view: one bar per group for the first metric (Motion's comparative / bar chart), top 20 groups. */

import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AdsGroupRow, MetricKey, Metrics } from "@/lib/ads-warehouse/query";
import { METRIC_BY_KEY, fmtMetric } from "@/lib/ads-warehouse/metrics-ui";

export function AdsBar({ rows, metric, benchmark, currency }: { rows: AdsGroupRow[]; metric: MetricKey; benchmark: Metrics; currency: string | null }) {
  const data = rows.slice(0, 20).map((r) => ({ key: r.key, name: r.label.length > 28 ? r.label.slice(0, 27) + "…" : r.label, v: r.metrics[metric], ads: r.adCount }));
  const def = METRIC_BY_KEY[metric];
  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-3">
      <div className="text-xs text-gray-400 mb-2">{def?.label ?? metric} par groupe · moyenne du compte {fmtMetric(metric, benchmark[metric], currency, benchmark)}</div>
      <div style={{ height: Math.max(220, data.length * 34) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 60, left: 8, bottom: 4 }}>
            <CartesianGrid horizontal={false} stroke="#1f2937" />
            <XAxis type="number" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="name" width={190} tick={{ fontSize: 11, fill: "#d1d5db" }} tickLine={false} axisLine={false} />
            <Tooltip cursor={{ fill: "#111827" }} contentStyle={{ background: "#111827", border: "1px solid #374151", fontSize: 11 }} formatter={(v) => [fmtMetric(metric, Number(v ?? 0), currency), def?.label ?? metric]} />
            <Bar dataKey="v" fill="#8b5cf6" radius={[0, 6, 6, 0]}>
              <LabelList dataKey="v" position="right" formatter={(v: unknown) => fmtMetric(metric, Number(v ?? 0), currency)} style={{ fontSize: 10, fill: "#9ca3af" }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
