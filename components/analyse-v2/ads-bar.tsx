"use client";

/**
 * Bar view (Motion's comparative chart): one group per column, metric 1 on
 * the left axis and metric 2 on the right axis, the group's visual under its
 * bars when there are few groups (≤ 10), horizontal bars beyond that.
 */

import { adImageSrc } from "./shared";
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AdsGroupRow, MetricKey, Metrics } from "@/lib/ads-warehouse/query";
import { METRIC_BY_KEY, fmtMetric } from "@/lib/ads-warehouse/metrics-ui";

export function AdsBar({ rows, metrics, benchmark, currency }: { rows: AdsGroupRow[]; metrics: MetricKey[]; benchmark: Metrics; currency: string | null }) {
  const m1 = metrics[0] ?? "spend";
  const m2 = metrics[1] && metrics[1] !== m1 ? metrics[1] : null;
  const top = rows.slice(0, 20);
  const data = top.map((r) => ({ key: r.key, name: r.label.length > 22 ? r.label.slice(0, 21) + "…" : r.label, a: r.metrics[m1], b: m2 ? r.metrics[m2] : 0, ads: r.adCount }));
  const few = top.length <= 10;
  const d1 = METRIC_BY_KEY[m1], d2 = m2 ? METRIC_BY_KEY[m2] : null;
  const tip = { background: "var(--ui-card)", border: "1px solid var(--ui-line-strong)", fontSize: 11 } as const;
  return (
    <div className="rounded-xl border border-ui-line bg-ui-card p-3">
      <div className="flex items-center justify-between text-xs text-ui-fg2 mb-2">
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-ui-accent" /> {d1?.label ?? m1} <span className="text-ui-muted">· moy. {fmtMetric(m1, benchmark[m1], currency, benchmark)}</span></span>
        {d2 && <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-rose-400" /> {d2.label} <span className="text-ui-muted">· moy. {fmtMetric(m2!, benchmark[m2!], currency, benchmark)}</span></span>}
      </div>
      {few ? (
        <>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 16, right: 8, left: -8, bottom: 0 }} barGap={4}>
                <CartesianGrid vertical={false} stroke="var(--ui-line)" strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={false} axisLine={false} tickLine={false} height={4} />
                <YAxis yAxisId="l" tick={{ fontSize: 10, fill: "var(--ui-muted)" }} tickLine={false} axisLine={false} />
                {d2 && <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: "var(--ui-muted)" }} tickLine={false} axisLine={false} />}
                <Tooltip cursor={{ fill: "var(--ui-card)" }} contentStyle={tip} formatter={(v, name) => [fmtMetric(name === "a" ? m1 : m2!, Number(v ?? 0), currency), name === "a" ? d1?.label : d2?.label]} labelFormatter={(l) => String(l)} />
                <Bar yAxisId="l" dataKey="a" fill="var(--ui-accent-ink)" radius={[6, 6, 0, 0]}><LabelList dataKey="a" position="top" formatter={(v: unknown) => fmtMetric(m1, Number(v ?? 0), currency)} style={{ fontSize: 10, fill: "var(--ui-fg2)" }} /></Bar>
                {d2 && <Bar yAxisId="r" dataKey="b" fill="#fda4af" radius={[6, 6, 0, 0]}><LabelList dataKey="b" position="top" formatter={(v: unknown) => fmtMetric(m2!, Number(v ?? 0), currency)} style={{ fontSize: 10, fill: "var(--ui-fg2)" }} /></Bar>}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="grid gap-2 mt-1" style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}>
            {top.map((r) => {
              const img = adImageSrc(r.sample);
              return (
                <div key={r.key} className="flex flex-col items-center text-center">
                  {/* eslint-disable-next-line @next/next/no-img-element -- Meta CDN */}
                  {img ? <img src={img} alt="" className="w-14 h-14 rounded-lg object-cover border border-ui-line" /> : <div className="w-14 h-14 rounded-lg bg-ui-raised" />}
                  <div className="mt-1 text-[11px] text-ui-fg2 truncate w-full" title={r.label}>{r.label}</div>
                  <div className="text-[10px] text-ui-muted">{r.adCount} ann.</div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div style={{ height: Math.max(220, data.length * 34) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 60, left: 8, bottom: 4 }}>
              <CartesianGrid horizontal={false} stroke="var(--ui-line)" />
              <XAxis type="number" tick={{ fontSize: 10, fill: "var(--ui-muted)" }} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="name" width={190} tick={{ fontSize: 11, fill: "var(--ui-fg2)" }} tickLine={false} axisLine={false} />
              <Tooltip cursor={{ fill: "var(--ui-card)" }} contentStyle={tip} formatter={(v) => [fmtMetric(m1, Number(v ?? 0), currency), d1?.label ?? m1]} />
              <Bar dataKey="a" fill="var(--ui-accent-ink)" radius={[0, 6, 6, 0]}><LabelList dataKey="a" position="right" formatter={(v: unknown) => fmtMetric(m1, Number(v ?? 0), currency)} style={{ fontSize: 10, fill: "var(--ui-fg2)" }} /></Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
