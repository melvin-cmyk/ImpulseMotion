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
const num1 = (v: number) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(v);

function kpiDisplay(metric: string, value: number): string {
  switch (metric) {
    case "spend": case "revenue": case "cpa": return eur(value);
    case "cpc": return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(value);
    case "roas": return `${value.toFixed(2)}x`;
    case "ctr": case "cr": return `${value.toFixed(2)}%`;
    default: return num(value);
  }
}

const KPI_LABELS: Record<string, string> = {
  spend: "Dépenses", revenue: "Revenu", roas: "ROAS", ctr: "CTR", cpa: "CPA",
  cpc: "CPC", cr: "Taux de conv.",
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
    case "platform_table": return <PlatformTableWidget widget={widget} />;
    case "timeseries": return <TimeseriesWidget widget={widget} />;
    case "table": return <TableWidget widget={widget} />;
    case "top_creatives": return <TopCreativesWidget widget={widget} />;
    case "pacing": return <PacingWidget widget={widget} />;
    case "text": return <TextWidget widget={widget} />;
    case "funnel": return <FunnelWidget widget={widget} />;
    case "demographics": return <DemographicsWidget widget={widget} />;
    case "geo_device": return <GeoDeviceWidget widget={widget} />;
    case "alerts": return <AlertsWidget widget={widget} />;
    default: return <div className="text-sm text-gray-500">Type inconnu : {widget.type}</div>;
  }
}

// Direction that counts as "good" when the metric goes up; spend is neutral.
const GOOD_WHEN_UP = new Set(["revenue", "roas", "purchases", "clicks", "impressions", "ctr", "cr"]);
const GOOD_WHEN_DOWN = new Set(["cpa", "cpc"]);

function deltaColor(metric: string, deltaPct: number): string {
  if (GOOD_WHEN_UP.has(metric)) return deltaPct >= 0 ? "text-emerald-400" : "text-red-400";
  if (GOOD_WHEN_DOWN.has(metric)) return deltaPct <= 0 ? "text-emerald-400" : "text-red-400";
  return "text-gray-400";
}

function fmtShortDate(iso: string): string {
  const [, m, day] = iso.split("-");
  return `${day}/${m}`;
}

function compareLabel(d: { compareKind?: string | null; compareSince?: string | null; compareUntil?: string | null }): string {
  switch (d.compareKind) {
    case "year": return "vs année préc.";
    case "custom":
      return d.compareSince && d.compareUntil
        ? `vs ${fmtShortDate(d.compareSince)}→${fmtShortDate(d.compareUntil)}`
        : "vs période comparée";
    default: return "vs période préc.";
  }
}

/** A move of ±20% (or more) is what a consultant must not miss. */
const BIG_MOVE_PCT = 20;

/** Semantic color for the KPI value itself: only ROAS carries an absolute
 *  judgement (≥2 healthy, <1 losing money) — other metrics are contextual. */
function kpiValueColor(metric: string, value: number): string {
  if (metric === "roas" && value > 0) {
    if (value >= 2) return "text-emerald-400";
    if (value < 1) return "text-red-400";
  }
  return "text-white";
}

function KpiWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as {
    metric: string; source: string; value: number; estimated: boolean;
    previous?: number | null; deltaPct?: number | null;
    compareKind?: string | null; compareSince?: string | null; compareUntil?: string | null;
  };
  const bigMove = typeof d.deltaPct === "number" && Math.abs(d.deltaPct) >= BIG_MOVE_PCT;
  const color = typeof d.deltaPct === "number" ? deltaColor(d.metric, d.deltaPct) : "";
  const bigBg = color.includes("emerald") ? "bg-emerald-950/60 border border-emerald-900/50"
    : color.includes("red") ? "bg-red-950/60 border border-red-900/50"
    : "bg-gray-800/60 border border-gray-700/50";
  return (
    <div className="py-1">
      <div className="flex items-baseline gap-2">
        <span className={`text-3xl font-bold tabular-nums ${kpiValueColor(d.metric, d.value)}`}>
          {kpiDisplay(d.metric, d.value)}
        </span>
        {d.estimated && <Pill tone="amber">estimé</Pill>}
      </div>
      <div className="text-xs text-gray-500 mt-1 flex items-center gap-2 flex-wrap">
        <span>{KPI_LABELS[d.metric] ?? d.metric} · {SOURCE_LABELS[d.source] ?? d.source}</span>
        {typeof d.deltaPct === "number" && (
          <span
            className={`font-semibold tabular-nums ${color} ${bigMove ? `px-1.5 py-0.5 rounded-md ${bigBg}` : ""}`}
            title={bigMove ? "Variation importante" : undefined}
          >
            {d.deltaPct >= 0 ? "▲" : "▼"} {Math.abs(d.deltaPct).toLocaleString("fr-FR")}%
            <span className="text-gray-600 font-normal"> {compareLabel(d)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

// Column spec for the platform overview table — order mirrors the classic
// media report: Cost, Impr., CTR, Clicks, CPC, CR%, Conversions, CPA.
const PLATFORM_COLUMNS: Array<{ key: string; label: string; goodUp: boolean | null; fmt: (v: number) => string }> = [
  { key: "cost", label: "Cost", goodUp: null, fmt: eur },
  { key: "impressions", label: "Impr.", goodUp: true, fmt: num },
  { key: "ctr", label: "CTR", goodUp: true, fmt: (v) => `${v.toFixed(2)}%` },
  { key: "clicks", label: "Clicks", goodUp: true, fmt: num },
  { key: "cpc", label: "CPC", goodUp: false, fmt: (v) => `${v.toFixed(2)}€` },
  { key: "cr", label: "CR%", goodUp: true, fmt: (v) => `${v.toFixed(2)}%` },
  { key: "conversions", label: "Conv.", goodUp: true, fmt: (v) => num(Math.round(v * 10) / 10) },
  { key: "cpa", label: "CPA", goodUp: false, fmt: eur },
];

function DeltaCell({ deltaPct, goodUp }: { deltaPct: number | null; goodUp: boolean | null }) {
  if (deltaPct === null || deltaPct === undefined) return null;
  const color =
    goodUp === null ? "text-gray-500"
    : (deltaPct >= 0) === goodUp ? "text-emerald-400" : "text-red-400";
  const big = goodUp !== null && Math.abs(deltaPct) >= BIG_MOVE_PCT;
  return (
    <span className={`block tabular-nums ${color} ${big ? "text-[11px] font-bold" : "text-[10px]"}`}>
      {deltaPct >= 0 ? "▲" : "▼"} {Math.abs(deltaPct).toLocaleString("fr-FR")}%
    </span>
  );
}

function PlatformTableWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as { rows: Array<Record<string, number | string | null>> };
  if (!d.rows?.length) return <div className="text-sm text-gray-500 py-4">Pas de données sur la période</div>;
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-sm min-w-[640px]">
        <thead>
          <tr className="text-gray-500 text-xs uppercase tracking-wide border-b border-gray-800">
            <th className="py-2 px-1 font-medium text-left">Platform</th>
            {PLATFORM_COLUMNS.map((c) => (
              <th key={c.key} className="py-2 px-1 font-medium text-right">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.rows.map((row) => (
            <tr
              key={String(row.platform)}
              className={`border-b border-gray-800/40 ${row.platform === "Total" ? "bg-gray-800/20 font-semibold" : ""}`}
            >
              <td className="py-2 px-1 text-left text-gray-200">{String(row.platform)}</td>
              {PLATFORM_COLUMNS.map((c) => (
                <td key={c.key} className="py-2 px-1 text-right text-gray-300 tabular-nums align-top">
                  {c.fmt(Number(row[c.key] ?? 0))}
                  <DeltaCell deltaPct={row[`${c.key}DeltaPct`] as number | null} goodUp={c.goodUp} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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

/** Cell emphasis: a healthy ROAS pops green, money burned with zero return pops red. */
function roasCellClass(v: number): string {
  if (v >= 2) return "text-emerald-400 font-semibold";
  if (v > 0 && v < 1) return "text-red-400";
  return "";
}

function TableWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as { kind: string; rows: Array<Record<string, unknown>> };
  if (!d.rows?.length) return <div className="text-sm text-gray-500 py-4">Pas de données sur la période</div>;
  const cols: Array<{ key: string; label: string; fmt?: (v: unknown) => string; cellClass?: (row: Record<string, unknown>) => string }> =
    d.kind === "campaigns"
      ? [
          { key: "name", label: "Campagne" },
          { key: "spend", label: "Dépenses", fmt: (v) => eur(Number(v)) },
          { key: "clicks", label: "Clics", fmt: (v) => num(Number(v)) },
          { key: "conversions", label: "Conv." },
          { key: "roas", label: "ROAS", fmt: (v) => `${Number(v).toFixed(2)}x`, cellClass: (row) => roasCellClass(Number(row.roas)) },
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
          {d.rows.map((row, ri) => {
            // Money spent with zero conversions on the period — worth an alert tint.
            const burning =
              Number(row.spend ?? 0) > 50 && "conversions" in row && Number(row.conversions ?? 0) === 0;
            return (
              <tr key={ri} className={`border-b border-gray-800/40 ${burning ? "bg-red-950/25" : ""}`}>
                {cols.map((c, i) => (
                  <td
                    key={c.key}
                    className={`py-2 px-1 ${i === 0 ? "text-left text-gray-200 max-w-[220px] truncate" : "text-right text-gray-300 tabular-nums"} ${c.cellClass?.(row) ?? ""}`}
                    title={burning && i === 0 ? "Dépense sans conversion sur la période" : undefined}
                  >
                    {c.fmt ? c.fmt(row[c.key]) : String(row[c.key] ?? "—")}
                  </td>
                ))}
              </tr>
            );
          })}
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
              <span className={c.roas >= 2 ? "text-emerald-400 font-semibold" : c.roas > 0 && c.roas < 1 ? "text-red-400" : "text-gray-300"}>
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

function FunnelWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as {
    source: string;
    steps: Array<{ label: string; value: number }>;
    rates: Array<{ label: string; pct: number }>;
  } | undefined;
  if (!d?.steps?.length || d.steps.every((s) => !s.value)) {
    return <div className="text-sm text-gray-500 py-4">Pas de données sur la période</div>;
  }
  const max = Math.max(...d.steps.map((s) => s.value), 1);
  // Impressions dwarf conversions by orders of magnitude — clamp so every bar stays visible.
  const widthPct = (v: number) => Math.max((v / max) * 100, 2.5);
  const stepBar = ["bg-violet-500/80", "bg-violet-500/55", "bg-violet-400/40"];
  return (
    <div className="py-1">
      <div className="text-xs text-gray-500 mb-2">{SOURCE_LABELS[d.source] ?? d.source}</div>
      <div className="space-y-1">
        {d.steps.map((s, i) => (
          <div key={s.label}>
            {i > 0 && d.rates?.[i - 1] && (
              <div className="text-[11px] text-violet-300/90 tabular-nums pl-28 py-0.5">
                ↓ {d.rates[i - 1].label} : {d.rates[i - 1].pct.toLocaleString("fr-FR")}%
              </div>
            )}
            <div className="flex items-center gap-3">
              <div className="w-24 shrink-0 text-xs text-gray-400">{s.label}</div>
              <div className="flex-1 h-6 rounded-md bg-gray-800/50 overflow-hidden">
                <div
                  className={`h-full rounded-md ${stepBar[i] ?? "bg-violet-400/40"}`}
                  style={{ width: `${widthPct(s.value)}%` }}
                />
              </div>
              <div className="w-20 shrink-0 text-right text-sm font-semibold text-gray-200 tabular-nums">
                {s.label === "Conversions" ? num1(s.value) : num(s.value)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const GENDER_INFO: Record<string, { label: string; bar: string }> = {
  female: { label: "Femmes", bar: "bg-violet-500" },
  male: { label: "Hommes", bar: "bg-blue-500" },
  unknown: { label: "Inconnu", bar: "bg-gray-600" },
};
const GENDER_ORDER = ["female", "male", "unknown"] as const;

function DemographicsWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as {
    metric: string;
    rows: Array<{ age: string; gender: string; value: number }>;
  } | undefined;
  if (!d?.rows?.length) return <div className="text-sm text-gray-500 py-4">Pas de données sur la période</div>;
  const fmt = d.metric === "spend" ? eur : d.metric === "purchases" ? num1 : num;
  const byAge = new Map<string, Record<string, number>>();
  for (const r of d.rows) {
    const g = byAge.get(r.age) ?? {};
    g[r.gender] = (g[r.gender] ?? 0) + r.value;
    byAge.set(r.age, g);
  }
  const genders = GENDER_ORDER.filter((g) => d.rows.some((r) => r.gender === g && r.value > 0));
  const ages = [...byAge.entries()]
    .map(([age, values]) => ({ age, values, total: Object.values(values).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);
  const max = Math.max(...d.rows.map((r) => r.value), 1);
  return (
    <div className="py-1">
      <div className="flex items-center gap-4 mb-3 text-[11px] text-gray-400">
        <span className="text-gray-500">{KPI_LABELS[d.metric] ?? d.metric} · par âge et genre</span>
        {genders.map((g) => (
          <span key={g} className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${GENDER_INFO[g].bar}`} />
            {GENDER_INFO[g].label}
          </span>
        ))}
      </div>
      <div className="space-y-2.5">
        {ages.map(({ age, values }) => (
          <div key={age} className="flex items-center gap-3">
            <div className="w-14 shrink-0 text-xs text-gray-400 tabular-nums">{age}</div>
            <div className="flex-1 space-y-1">
              {genders.map((g) => {
                const v = values[g] ?? 0;
                return (
                  <div key={g} className="flex items-center gap-2">
                    <div className="flex-1 h-3 rounded-sm bg-gray-800/50 overflow-hidden">
                      <div className={`h-full rounded-sm ${GENDER_INFO[g].bar}`} style={{ width: `${(v / max) * 100}%` }} />
                    </div>
                    <span className="w-16 shrink-0 text-right text-[11px] text-gray-300 tabular-nums">{fmt(v)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const DEVICE_LABELS: Record<string, string> = {
  mobile_app: "App mobile",
  mobile_web: "Web mobile",
  desktop: "Ordinateur",
  mobile: "Mobile",
  tablet: "Tablette",
  connected_tv: "TV connectée",
  other: "Autre",
  unknown: "Inconnu",
};

function geoDeviceLabel(dimension: string, key: string): string {
  if (dimension === "country") {
    try {
      return new Intl.DisplayNames(["fr"], { type: "region" }).of(key.toUpperCase()) ?? key;
    } catch {
      return key;
    }
  }
  return DEVICE_LABELS[key] ?? key.replace(/_/g, " ");
}

function GeoDeviceWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as {
    dimension: string;
    source: string;
    rows: Array<{ key: string; spend: number; clicks: number; conversions: number }>;
  } | undefined;
  if (!d?.rows?.length) return <div className="text-sm text-gray-500 py-4">Pas de données sur la période</div>;
  const rows = d.rows.slice(0, 8); // trié spend desc côté serveur
  const max = Math.max(...rows.map((r) => r.spend), 1);
  return (
    <div className="py-1">
      <div className="flex items-center text-[11px] text-gray-500 uppercase tracking-wide border-b border-gray-800 pb-1.5 mb-1">
        <span className="flex-1">{d.dimension === "country" ? "Pays" : "Appareil"} · {SOURCE_LABELS[d.source] ?? d.source}</span>
        <span className="w-16 text-right">Dépenses</span>
        <span className="w-14 text-right">Clics</span>
        <span className="w-12 text-right">Conv.</span>
      </div>
      <div className="divide-y divide-gray-800/40">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center py-1.5 text-sm">
            <div className="flex-1 min-w-0 pr-3">
              <div className="text-gray-200 text-xs truncate" title={r.key}>{geoDeviceLabel(d.dimension, r.key)}</div>
              <div className="h-1.5 rounded-full bg-gray-800/50 mt-1 overflow-hidden">
                <div className="h-full rounded-full bg-violet-500/70" style={{ width: `${(r.spend / max) * 100}%` }} />
              </div>
            </div>
            <span className="w-16 text-right text-gray-300 tabular-nums text-xs">{eur(r.spend)}</span>
            <span className="w-14 text-right text-gray-400 tabular-nums text-xs">{num(r.clicks)}</span>
            <span className="w-12 text-right text-gray-400 tabular-nums text-xs">{num1(r.conversions)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function relativeDateFr(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const j = Math.round(h / 24);
  if (j < 30) return `il y a ${j} j`;
  return `il y a ${Math.round(j / 30)} mois`;
}

function AlertsWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as {
    events: Array<{
      id: string; metric: string; value: number; threshold: number;
      message: string; acknowledged: boolean; triggeredAt: string;
    }>;
  } | undefined;
  if (!d?.events?.length) {
    return <div className="text-sm text-emerald-400/80 py-4">Aucune alerte récente ✓</div>;
  }
  return (
    <ul className="divide-y divide-gray-800/60">
      {d.events.map((e) => (
        <li key={e.id} className="py-2 flex items-start gap-2.5">
          <span
            className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${e.acknowledged ? "bg-gray-600" : "bg-red-500"}`}
            title={e.acknowledged ? "Acquittée" : "Non acquittée"}
          />
          <div className="min-w-0 flex-1">
            <div className={`text-sm leading-snug ${e.acknowledged ? "text-gray-400" : "text-gray-200"}`}>{e.message}</div>
            <div className="text-[11px] text-gray-500 mt-0.5 tabular-nums">
              {relativeDateFr(e.triggeredAt)} · {KPI_LABELS[e.metric] ?? e.metric} {kpiDisplay(e.metric, e.value)}
              <span className="text-gray-600"> vs seuil {kpiDisplay(e.metric, e.threshold)}</span>
            </div>
          </div>
        </li>
      ))}
    </ul>
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
