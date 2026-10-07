"use client";

/**
 * Pilotage — the day-by-day spend and cost per result of one account, with a
 * mark on every day something was changed on it: from Pilotage (violet),
 * by someone else on the platform (amber), by a rule or a script (grey).
 * Hovering a day lists what was changed that day. Read only.
 */

import { useMemo } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { money } from "@/lib/pilot/ops";
import { parisDay } from "@/lib/pilot/impact";
import type { DailyPoint } from "@/lib/pilot/history";

export interface ChartMark { day: string; source: "impulsemotion" | "external" | "automated"; text: string }

const COLOR: Record<ChartMark["source"], string> = { impulsemotion: "#a78bfa", external: "#fbbf24", automated: "#6b7280" };

const dayFr = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export function marksOf(items: Array<{ at: string; source: ChartMark["source"]; text: string }>): ChartMark[] {
  return items.map((i) => ({ day: parisDay(new Date(i.at)), source: i.source, text: i.text }));
}

export function ChangeChart({ points, currency, marks }: { points: DailyPoint[]; currency: string; marks: ChartMark[] }) {
  const data = useMemo(() => points.map((p) => ({ ...p, cpa: p.conversions > 0 ? p.spend / p.conversions : null })), [points]);
  const byDay = useMemo(() => {
    const m = new Map<string, ChartMark[]>();
    for (const mk of marks) m.set(mk.day, [...(m.get(mk.day) ?? []), mk]);
    return m;
  }, [marks]);
  if (!data.length) return <p className="text-sm text-gray-500">Pas de chiffres journaliers pour ce compte.</p>;
  const minor = (v: number) => money(Math.round(v * 100), currency);

  return (
    <div className="space-y-2">
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="pilotSpend" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="day" tickFormatter={dayFr} tick={{ fill: "#6b7280", fontSize: 10 }} minTickGap={24} />
            <YAxis yAxisId="spend" tick={{ fill: "#6b7280", fontSize: 10 }} width={48} tickFormatter={(v) => `${Math.round(Number(v))}`} />
            <YAxis yAxisId="cpa" orientation="right" tick={{ fill: "#6b7280", fontSize: 10 }} width={44} tickFormatter={(v) => `${Math.round(Number(v))}`} />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as DailyPoint & { cpa: number | null };
                const todays = byDay.get(String(label)) ?? [];
                return (
                  <div className="rounded-lg border border-gray-700 bg-gray-950/95 px-3 py-2 text-xs text-gray-200 max-w-xs">
                    <p className="font-semibold text-white">{dayFr(String(label))}</p>
                    <p>Dépense {minor(p.spend)} · {p.conversions} conv.{p.cpa !== null ? ` · CPA ${minor(p.cpa)}` : ""}</p>
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
            <Area yAxisId="spend" type="monotone" dataKey="spend" name="Dépense" stroke="#8b5cf6" fill="url(#pilotSpend)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <Line yAxisId="cpa" type="monotone" dataKey="cpa" name="CPA" stroke="#34d399" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
            {[...byDay.entries()].map(([day, list]) => {
              const source = list.some((m) => m.source === "impulsemotion") ? "impulsemotion" : list.some((m) => m.source === "external") ? "external" : "automated";
              return <ReferenceLine key={day} yAxisId="spend" x={day} stroke={COLOR[source]} strokeDasharray="4 2" strokeWidth={list.length > 1 ? 2 : 1} />;
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-gray-500">
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-violet-500 inline-block" /> dépense</span>
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-emerald-400 inline-block" /> CPA (échelle de droite)</span>
        <span className="flex items-center gap-1"><span className="w-3 border-t border-dashed inline-block" style={{ borderColor: COLOR.impulsemotion }} /> modification depuis ImpulseMotion</span>
        <span className="flex items-center gap-1"><span className="w-3 border-t border-dashed inline-block" style={{ borderColor: COLOR.external }} /> hors ImpulseMotion</span>
        <span className="flex items-center gap-1"><span className="w-3 border-t border-dashed inline-block" style={{ borderColor: COLOR.automated }} /> automatique</span>
      </div>
    </div>
  );
}
