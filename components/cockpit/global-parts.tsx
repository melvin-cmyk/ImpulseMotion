"use client";

/**
 * Global Cockpit — small visual pieces shared by the table, the priority
 * cards, the budget view and the diagnostic panel.
 */

import type { ReactNode } from "react";
import type { ClientRow, Pacing, Severity } from "@/lib/cockpit/engine";
import { SEVERITY_LABEL, TXT, pacePts, paceTone, pct, tone, type Tone } from "@/lib/cockpit/display";
import type { KpiMode, AccountMode } from "@/lib/cockpit/engine";

const SEVERITY_CLASS: Record<Severity, string> = {
  urgent: "bg-red-500/15 text-red-300 border-red-500/40",
  action: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  watch: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  ok: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
};

export function SeverityBadge({ severity, label }: { severity: Severity; label?: string }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${SEVERITY_CLASS[severity]}`}>
      {label ?? SEVERITY_LABEL[severity]}
    </span>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  bad: "bg-red-500/15 text-red-300",
  warn: "bg-amber-500/15 text-amber-300",
  good: "bg-emerald-500/15 text-emerald-300",
  flat: "bg-gray-800 text-gray-400",
};

/** A delta with its reference (« 8 sem. », « S-1 »), coloured by the cockpit thresholds. */
export function Chip({ d, kind, label, mode }: { d: number | null; kind: "spend" | "perf"; label: string; mode?: KpiMode | AccountMode }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] tabular-nums ${TONE_CLASS[tone(d, kind, mode)]}`}>
      <small className="text-[10px] opacity-70">{label}</small> {pct(d)}
    </span>
  );
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${className ?? "bg-gray-800 text-gray-300"}`}>{children}</span>;
}

export function Badges({ c }: { c: ClientRow & { missing?: string[] } }) {
  const platforms = Object.values(c.platforms);
  return (
    <span className="ml-2 inline-flex flex-wrap items-center gap-1 align-middle">
      {platforms.some((p) => p.plat === "meta") && <Tag className="bg-blue-500/20 text-blue-300">M</Tag>}
      {platforms.some((p) => p.plat === "google") && <Tag className="bg-emerald-500/20 text-emerald-300">G</Tag>}
      <Tag>{c.mixed ? "MIX ¤" : c.ccy ?? "—"}</Tag>
      {platforms.some((p) => p.data_issue) && <Tag className="bg-red-500/20 text-red-300">DONNÉES À VÉRIFIER</Tag>}
      {(c.missing ?? []).map((m) => <Tag key={m} className="bg-amber-500/20 text-amber-300">{m.toUpperCase()} NON RELIÉ</Tag>)}
      {c.blended.n_base < 2 && <Tag className="bg-violet-500/20 text-violet-300">NEW</Tag>}
      {c.kpi_mode === "brand"
        ? <Tag className="bg-violet-500/20 text-violet-300">{TXT.brand.toUpperCase()}</Tag>
        : c.blended.low_vol ? <Tag className="bg-violet-500/20 text-violet-300">{TXT.lowVol.toUpperCase()}</Tag> : null}
    </span>
  );
}

/** Spend of the 9 weeks; the last bar (the week read) is highlighted. */
export function Spark({ weeks, starts, width = 120, height = 26 }: { weeks: number[]; starts: string[]; width?: number; height?: number }) {
  if (!weeks.length) return null;
  const n = weeks.length;
  const max = Math.max(...weeks, 1);
  const bw = width / n - 2;
  return (
    <svg width={width} height={height} role="img" aria-label={`Dépenses hebdomadaires, ${n} semaines`} className="shrink-0">
      {weeks.map((v, i) => {
        const h = Math.max(1, (v / max) * (height - 2));
        return (
          <rect key={i} x={i * (width / n) + 1} y={height - h} width={bw} height={h} rx={1.5} fill={i === n - 1 ? "#8b5cf6" : "#8b5cf64d"}>
            <title>{`${starts[i] ?? ""} : ${Math.round(v).toLocaleString("fr-FR")}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

const PACE_TEXT = { bad: "text-red-300", warn: "text-amber-300", ok: "text-emerald-300" };

/** Share of the monthly budget spent (bar) against the share of the month elapsed (mark). */
export function PaceGauge({ p }: { p: Pacing | null }) {
  if (!p) return <span className="text-xs text-gray-500">{TXT.noBudget}</span>;
  const pts = pacePts(p);
  const spent = Math.round(p.pct_spent * 100);
  const expected = Math.round(p.pct_month * 100);
  return (
    <span className="inline-flex min-w-[170px] flex-col gap-1">
      <span className="relative block h-1.5 w-full rounded-full bg-gray-800" role="img" aria-label={`${spent}% du budget dépensé, attendu ${expected}%`}>
        <span className="absolute inset-y-0 left-0 rounded-full bg-violet-500" style={{ width: `${Math.min(spent, 100)}%` }} />
        <span className="absolute -top-1 h-3.5 w-0.5 rounded bg-white" style={{ left: `${Math.min(expected, 100)}%` }} />
      </span>
      <span className="text-[11px] tabular-nums text-gray-400">
        {spent}% dépensé · attendu {expected}%{" "}
        <span className={`font-semibold ${PACE_TEXT[paceTone(p)]}`}>{pts > 0 ? "+" : ""}{Math.round(pts)} pts</span>{" "}
        <span className="text-gray-500">{Math.abs(pts) < 1 ? "dans les clous" : pts > 0 ? "d'avance" : "de retard"}</span>
      </span>
    </span>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <span className="text-gray-500">{children}</span>;
}
