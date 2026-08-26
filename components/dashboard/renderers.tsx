"use client";

/**
 * Read-only widget renderers for client steering dashboards (/d/[id]).
 * Every renderer takes the resolved payload from /api/dashboards/[id].
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { Card, Pill } from "@/components/ui/surface";
import type { ResolvedWidget } from "@/lib/dashboard-types";

const eur = (v: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
const num = (v: number) => new Intl.NumberFormat("fr-FR").format(Math.round(v));

function kpiDisplay(metric: string, value: number): string {
  switch (metric) {
    case "spend": case "revenue": case "cpa": return eur(value);
    case "roas": return `${value.toFixed(2)}x`;
    case "ctr": return `${value.toFixed(2)}%`;
    default: return num(value);
  }
}

const KPI_LABELS: Record<string, string> = {
  spend: "Dépenses", revenue: "Revenu", roas: "ROAS", ctr: "CTR", cpa: "CPA",
  purchases: "Conversions", clicks: "Clics", impressions: "Impressions",
};

const SOURCE_LABELS: Record<string, string> = { meta: "Meta", google: "Google", combined: "Meta + Google" };

export function WidgetBody({ widget }: { widget: ResolvedWidget }) {
  if (widget.error) {
    return (
      <div className="text-sm text-amber-400/90 py-4 px-1">
        {widget.error}
      </div>
    );
  }
  switch (widget.type) {
    case "kpi": return <KpiWidget widget={widget} />;
    case "timeseries": return <TimeseriesWidget widget={widget} />;
    case "table": return <TableWidget widget={widget} />;
    case "top_creatives": return <TopCreativesWidget widget={widget} />;
    case "pacing": return <PacingWidget widget={widget} />;
    case "text": return <TextWidget widget={widget} />;
    default: return <div className="text-sm text-gray-500">Type inconnu : {widget.type}</div>;
  }
}

// Direction that counts as "good" when the metric goes up; spend is neutral.
const GOOD_WHEN_UP = new Set(["revenue", "roas", "purchases", "clicks", "impressions", "ctr"]);
const GOOD_WHEN_DOWN = new Set(["cpa"]);

function deltaColor(metric: string, deltaPct: number): string {
  if (GOOD_WHEN_UP.has(metric)) return deltaPct >= 0 ? "text-emerald-400" : "text-red-400";
  if (GOOD_WHEN_DOWN.has(metric)) return deltaPct <= 0 ? "text-emerald-400" : "text-red-400";
  return "text-gray-400";
}

function KpiWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as {
    metric: string; source: string; value: number; estimated: boolean;
    previous?: number | null; deltaPct?: number | null;
  };
  return (
    <div className="py-1">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold text-white tabular-nums">{kpiDisplay(d.metric, d.value)}</span>
        {d.estimated && <Pill tone="amber">estimé</Pill>}
      </div>
      <div className="text-xs text-gray-500 mt-1 flex items-center gap-2 flex-wrap">
        <span>{KPI_LABELS[d.metric] ?? d.metric} · {SOURCE_LABELS[d.source] ?? d.source}</span>
        {typeof d.deltaPct === "number" && (
          <span className={`font-semibold tabular-nums ${deltaColor(d.metric, d.deltaPct)}`}>
            {d.deltaPct >= 0 ? "▲" : "▼"} {Math.abs(d.deltaPct).toLocaleString("fr-FR")}%
            <span className="text-gray-600 font-normal"> vs période préc.</span>
          </span>
        )}
      </div>
    </div>
  );
}

function TimeseriesWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as { metric: string; points: Array<{ date: string; value: number }>; estimated: boolean };
  if (!d.points?.length) return <div className="text-sm text-gray-500 py-4">Pas de données sur la période</div>;
  const money = d.metric === "spend" || d.metric === "revenue";
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={d.points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`grad-${widget.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: "#6b7280", fontSize: 11 }}
            tickFormatter={(v: string) => v?.slice(5)}
            axisLine={false} tickLine={false}
          />
          <YAxis
            tick={{ fill: "#6b7280", fontSize: 11 }}
            tickFormatter={(v: number) => (money ? `${Math.round(v)}€` : String(v))}
            axisLine={false} tickLine={false} width={48}
          />
          <Tooltip
            contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "#9ca3af" }}
            formatter={(value) => [money ? eur(Number(value ?? 0)) : String(value ?? ""), KPI_LABELS[d.metric] ?? d.metric]}
          />
          <Area type="monotone" dataKey="value" stroke="#8b5cf6" strokeWidth={2} fill={`url(#grad-${widget.id})`} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function TableWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as { kind: string; rows: Array<Record<string, unknown>> };
  if (!d.rows?.length) return <div className="text-sm text-gray-500 py-4">Pas de données sur la période</div>;
  const cols: Array<{ key: string; label: string; fmt?: (v: unknown) => string }> =
    d.kind === "campaigns"
      ? [
          { key: "name", label: "Campagne" },
          { key: "spend", label: "Dépenses", fmt: (v) => eur(Number(v)) },
          { key: "clicks", label: "Clics", fmt: (v) => num(Number(v)) },
          { key: "conversions", label: "Conv." },
          { key: "roas", label: "ROAS", fmt: (v) => `${Number(v).toFixed(2)}x` },
        ]
      : d.kind === "keywords"
        ? [
            { key: "name", label: "Mot-clé" },
            { key: "spend", label: "Dépenses", fmt: (v) => eur(Number(v)) },
            { key: "clicks", label: "Clics", fmt: (v) => num(Number(v)) },
            { key: "conversions", label: "Conv." },
            { key: "ctr", label: "CTR", fmt: (v) => `${Number(v).toFixed(1)}%` },
          ]
        : [
            { key: "name", label: "Terme de recherche" },
            { key: "spend", label: "Dépenses", fmt: (v) => eur(Number(v)) },
            { key: "clicks", label: "Clics", fmt: (v) => num(Number(v)) },
            { key: "conversions", label: "Conv." },
          ];
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 text-xs uppercase tracking-wide border-b border-gray-800">
            {cols.map((c, i) => (
              <th key={c.key} className={`py-2 px-1 font-medium ${i === 0 ? "text-left" : "text-right"}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.rows.map((row, ri) => (
            <tr key={ri} className="border-b border-gray-800/40">
              {cols.map((c, i) => (
                <td key={c.key} className={`py-2 px-1 ${i === 0 ? "text-left text-gray-200 max-w-[220px] truncate" : "text-right text-gray-300 tabular-nums"}`}>
                  {c.fmt ? c.fmt(row[c.key]) : String(row[c.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopCreativesWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as {
    creatives: Array<{ adId: string; name: string; imageUrl: string | null; spend: number; ctr: number; hookRate: number; roas: number; estimated: boolean }>;
  };
  if (!d.creatives?.length) return <div className="text-sm text-gray-500 py-4">Pas de créas actives sur la période</div>;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {d.creatives.map((c) => (
        <div key={c.adId} className="bg-gray-950/60 border border-gray-800 rounded-xl overflow-hidden">
          <div className="aspect-square bg-gray-900">
            {c.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/deck/proxy-image?url=${encodeURIComponent(c.imageUrl)}&upgrade=1`}
                alt={c.name}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-700 text-xs">no image</div>
            )}
          </div>
          <div className="p-2">
            <div className="text-[11px] text-gray-400 truncate" title={c.name}>{c.name}</div>
            <div className="flex justify-between mt-1 text-[11px]">
              <span className="text-gray-500">{eur(c.spend)}</span>
              <span className={c.roas >= 2 ? "text-emerald-400" : "text-gray-300"}>
                {c.roas.toFixed(1)}x{c.estimated ? "*" : ""}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PacingWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as {
    monthlyTarget: number; mtdSpend: number; projectedSpend: number; pacingPct: number;
    status: string; currency: string; daysRemaining?: number;
  };
  const statusInfo: Record<string, { label: string; tone: "amber" | "red" | "emerald" | "blue" }> = {
    critical_under: { label: "Sous-consommation critique", tone: "red" },
    under: { label: "Sous-consommation", tone: "amber" },
    on_track: { label: "Sur la trajectoire", tone: "emerald" },
    over: { label: "Sur-consommation", tone: "amber" },
    critical_over: { label: "Sur-consommation critique", tone: "red" },
  };
  const info = statusInfo[d.status] ?? { label: d.status, tone: "blue" as const };
  const pct = Math.min(Math.max(d.monthlyTarget > 0 ? (d.mtdSpend / d.monthlyTarget) * 100 : 0, 0), 130);
  return (
    <div className="py-1 space-y-3">
      <div className="flex items-baseline justify-between">
        <div>
          <span className="text-2xl font-bold text-white tabular-nums">{eur(d.mtdSpend)}</span>
          <span className="text-sm text-gray-500"> / {eur(d.monthlyTarget)} ce mois</span>
        </div>
        <Pill tone={info.tone}>{info.label}</Pill>
      </div>
      <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
        <div
          className={`h-full rounded-full ${d.status.includes("critical") ? "bg-red-500" : d.status === "on_track" ? "bg-emerald-500" : "bg-amber-500"}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <div className="text-xs text-gray-500">
        Projection fin de mois : <span className="text-gray-300">{eur(d.projectedSpend)}</span> ({Math.round(d.pacingPct)}% de l&apos;objectif)
      </div>
    </div>
  );
}

function TextWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as { markdown: string };
  if (!d.markdown) return <div className="text-sm text-gray-600 italic py-2">Texte vide</div>;
  return (
    <div className="prose prose-invert prose-sm max-w-none text-gray-300 [&_a]:text-violet-400">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{d.markdown}</ReactMarkdown>
    </div>
  );
}

export function WidgetFrame({ widget, children, editControls }: {
  widget: ResolvedWidget;
  children: React.ReactNode;
  editControls?: React.ReactNode;
}) {
  const span =
    widget.width === "full" ? "lg:col-span-6"
    : widget.width === "half" ? "lg:col-span-3"
    : "lg:col-span-2";
  return (
    <Card padded className={`${span} col-span-6 flex flex-col`}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-200">{widget.title ?? ""}</h3>
        {editControls}
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </Card>
  );
}
