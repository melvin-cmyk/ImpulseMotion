"use client";

/**
 * Pilotage — the day-by-day figures of one account (spend, conversions, cost
 * per result or ROAS, chosen by the consultant) with its 7-day moving average,
 * and a mark on every day something was changed on it: from Pilotage
 * (violet), by someone else on the platform (amber), by a rule or a script
 * (grey). Hovering a day lists what was changed; clicking a day filters the
 * history to that day. Read only.
 */

import { useMemo } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { money } from "@/lib/pilot/ops";
import { parisDay } from "@/lib/pilot/impact";
import { movingAverage } from "@/lib/pilot/history-stats";
import type { DailyPoint } from "@/lib/pilot/history";

export interface ChartMark { day: string; source: "impulsemotion" | "external" | "automated"; text: string }
export type ChartMetric = "spend" | "conversions" | "cpa" | "roas";
export const METRIC_FR: Record<ChartMetric, string> = { spend: "Dépense", conversions: "Conversions", cpa: "CPA", roas: "ROAS" };

const COLOR: Record<ChartMark["source"], string> = { impulsemotion: "#a78bfa", external: "#fbbf24", automated: "#6b7280" };
const dayFr = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export function marksOf(items: Array<{ at: string; source: ChartMark["source"]; text: string }>): ChartMark[] {
  return items.map((i) => ({ day: parisDay(new Date(i.at)), source: i.source, text: i.text }));
}

const valueOf = (p: DailyPoint, metric: ChartMetric): number | null => {
  if (metric === "cpa") return p.conversions > 0 ? p.spend / p.conversions : null;
  if (metric === "roas") return p.revenue !== null && p.spend > 0 ? p.revenue / p.spend : null;
  return p[metric];
};

export function ChangeChart({ points, currency, marks, metric, onMetric, selectedDay, onDayClick }: {
  points: DailyPoint[];
  currency: string;
  marks: ChartMark[];
  metric: ChartMetric;
  onMetric: (m: ChartMetric) => void;
  selectedDay?: string | null;
  onDayClick?: (day: string | null) => void;
}) {
  const data = useMemo(() => {
    const avg = movingAverage(points, metric, 7);
    return points.map((p, i) => ({ day: p.day, value: valueOf(p, metric), avg: avg[i], spend: p.spend, conversions: p.conversions, revenue: p.revenue }));
  }, [points, metric]);
  const byDay = useMemo(() => {
    const m = new Map<string, ChartMark[]>();
    for (const mk of marks) m.set(mk.day, [...(m.get(mk.day) ?? []), mk]);
    return m;
  }, [marks]);
  const hasRoas = points.some((p) => p.revenue !== null);
  if (!data.length) return <p className="text-sm text-gray-500">Pas de chiffres journaliers pour ce compte.</p>;
  const fmt = (v: number | null) => (v === null ? "—" : metric === "conversions" ? v.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) : metric === "roas" ? `${v.toFixed(2)}×` : money(Math.round(v * 100), currency));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {(["spend", "conversions", "cpa", "roas"] as ChartMetric[]).filter((m) => m !== "roas" || hasRoas).map((m) => (
          <button key={m} type="button" onClick={() => onMetric(m)} className={`px-2 py-1 rounded-md border ${metric === m ? "border-violet-500 text-white" : "border-gray-800 text-gray-400 hover:text-white"}`}>{METRIC_FR[m]}</button>
        ))}
        <span className="text-gray-500">· trait fin = moyenne 7 jours · cliquez un jour pour n&apos;afficher que ses modifications</span>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} onClick={(e) => { const day = (e as { activeLabel?: unknown })?.activeLabel; if (onDayClick && typeof day === "string") onDayClick(day === selectedDay ? null : day); }} style={{ cursor: onDayClick ? "pointer" : undefined }}>
            <defs>
              <linearGradient id="pilotMetric" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="day" tickFormatter={dayFr} tick={{ fill: "#6b7280", fontSize: 10 }} minTickGap={24} />
            <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} width={52} tickFormatter={(v) => (metric === "roas" ? `${Number(v).toFixed(1)}` : `${Math.round(Number(v))}`)} />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as (typeof data)[number];
                const todays = byDay.get(String(label)) ?? [];
                return (
                  <div className="rounded-lg border border-gray-700 bg-gray-950/95 px-3 py-2 text-xs text-gray-200 max-w-xs">
                    <p className="font-semibold text-white">{dayFr(String(label))} — {METRIC_FR[metric]} {fmt(p.value)}{p.avg !== null ? <span className="text-gray-500"> · moy. 7 j {fmt(p.avg)}</span> : null}</p>
                    <p className="text-gray-400">Dépense {money(Math.round(p.spend * 100), currency)} · {p.conversions.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} conv.{p.conversions > 0 ? ` · CPA ${money(Math.round((p.spend / p.conversions) * 100), currency)}` : ""}</p>
                    {todays.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {todays.slice(0, 6).map((m, i) => <li key={i} style={{ color: COLOR[m.source] }}>{m.text}</li>)}
                        {todays.length > 6 && <li className="text-gray-500">… et {todays.length - 6} autre(s)</li>}
                      </ul>
                    )}
                  </div>
                );
              }}
            />
            <Area type="monotone" dataKey="value" name={METRIC_FR[metric]} stroke="#8b5cf6" fill="url(#pilotMetric)" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
            <Line type="monotone" dataKey="avg" name="Moyenne 7 j" stroke="#34d399" strokeWidth={1} dot={false} connectNulls isAnimationActive={false} />
            {[...byDay.entries()].map(([day, list]) => {
              const source = list.some((m) => m.source === "impulsemotion") ? "impulsemotion" : list.some((m) => m.source === "external") ? "external" : "automated";
              return <ReferenceLine key={day} x={day} stroke={COLOR[source]} strokeDasharray={day === selectedDay ? undefined : "4 2"} strokeWidth={day === selectedDay ? 2.5 : list.length > 1 ? 2 : 1} />;
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-gray-500">
        <span className="flex items-center gap-1"><span className="w-3 border-t border-dashed inline-block" style={{ borderColor: COLOR.impulsemotion }} /> depuis ImpulseMotion</span>
        <span className="flex items-center gap-1"><span className="w-3 border-t border-dashed inline-block" style={{ borderColor: COLOR.external }} /> hors ImpulseMotion</span>
        <span className="flex items-center gap-1"><span className="w-3 border-t border-dashed inline-block" style={{ borderColor: COLOR.automated }} /> automatique</span>
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-emerald-400 inline-block" /> moyenne 7 jours</span>
      </div>
    </div>
  );
}
