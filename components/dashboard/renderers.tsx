"use client";

/**
 * Read-only widget renderers for client steering dashboards (/d/[id]).
 * Every renderer takes the resolved payload from /api/dashboards/[id].
 */

import ReactMarkdown from "react-markdown";
import { SAFE_MD_COMPONENTS } from "@/components/ai/safe-image";
import remarkGfm from "remark-gfm";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { Card, Pill } from "@/components/ui/surface";
import { createContext, useContext } from "react";
import type { ResolvedWidget } from "@/lib/dashboard-types";
import { buildPilotHref, platformOfAccountId } from "@/lib/pilot/deep-link";

/** True when the viewer is staff: the widgets then link to /pilotage (a client never sees those links). */
export const PilotLinksContext = createContext(false);
import { fmtMetric, fmtMoney, fmtNumber, fmtPct, fmtRoas } from "@/components/portfolio/format";
import {
  CrmCampaignTable, CrmDiagnosticBlock, CrmFreshness, CrmLevelBadge, CrmPartialBanner, CrmSkeleton, CrmSourceTable, roasTone,
} from "@/components/portfolio/crm-shared";
import type { CrmAttributionData, CrmFunnelData } from "@/components/portfolio/crm-types";
import {
  emptyMessage, kpiValueClass, pacingView, partialNote, sourceLabel,
  type AlertsData, type DemographicsData, type MetaActionsData, type FunnelData, type GeoDeviceData, type KpiData,
  type PacingData, type PlatformTableData, type TableData, type TimeseriesData, type TopCreativesData,
} from "@/components/dashboard/widget-display";
import { METRIC_LABELS } from "@/lib/dashboard-types";
import { VIDEO_METRICS, videoMetricNote } from "@/lib/video-metrics";

const KPI_LABELS: Record<string, string> = METRIC_LABELS;


export function WidgetBody({ widget }: { widget: ResolvedWidget }) {
  if (widget.error) {
    return (
      <div className="text-sm text-ui-warn/90 py-4 px-1">
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
    case "crm_funnel": return <CrmFunnelWidget widget={widget} />;
    case "crm_attribution": return <CrmAttributionWidget widget={widget} />;
    case "meta_actions": return <MetaActionsWidget widget={widget} />;
    default: return <div className="text-sm text-ui-muted">Type inconnu : {widget.type}</div>;
  }
}

// Direction that counts as "good" when the metric goes up; spend is neutral.
const GOOD_WHEN_UP = new Set(["revenue", "roas", "purchases", "clicks", "impressions", "ctr", "cr", ...VIDEO_METRICS]);
const GOOD_WHEN_DOWN = new Set(["cpa", "cpc"]);

function deltaColor(metric: string, deltaPct: number): string {
  if (GOOD_WHEN_UP.has(metric)) return deltaPct >= 0 ? "text-ui-pos" : "text-ui-neg";
  if (GOOD_WHEN_DOWN.has(metric)) return deltaPct <= 0 ? "text-ui-pos" : "text-ui-neg";
  return "text-ui-fg2";
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

function KpiWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as KpiData;
  const bigMove = typeof d.deltaPct === "number" && Math.abs(d.deltaPct) >= BIG_MOVE_PCT;
  const color = typeof d.deltaPct === "number" ? deltaColor(d.metric, d.deltaPct) : "";
  const bigBg = color.includes("pos") ? "bg-ui-pos/10"
    : color.includes("neg") ? "bg-ui-neg/10"
    : "bg-ui-raised";
  const note = partialNote(d);
  return (
    <div className="py-1">
      <div className="flex items-baseline gap-2">
        <span className={`text-3xl font-medium leading-none tabular-nums ${kpiValueClass(d.metric, d.value, d)}`}>
          {fmtMetric(d.metric, d.value, d.currency, { estimated: d.estimated, unavailable: d.unavailable })}
        </span>
        {d.estimated && !d.unavailable && <Pill tone="amber">estimé</Pill>}
        {d.partial && <Pill tone="amber">partiel</Pill>}
      </div>
      {d.unavailable && (
        <div className="text-xs text-ui-muted mt-1">Revenu non tracké et aucun panier moyen configuré</div>
      )}
      {note && <div className="text-xs text-ui-warn/90 mt-1" title={d.errors?.join(" · ")}>{note}</div>}
      {videoMetricNote(d.metric, d.platforms ?? [d.source]) && (
        <div className="text-[11px] text-ui-muted mt-1">{videoMetricNote(d.metric, d.platforms ?? [d.source])}</div>
      )}
      <div className="text-xs text-ui-muted mt-1 flex items-center gap-2 flex-wrap">
        <span>
          {KPI_LABELS[d.metric] ?? d.metric}
          {d.conversionLabel && <span className="text-ui-fg2"> ({d.conversionLabel})</span>}
          {" · "}{sourceLabel(d.source, d.platforms)}
        </span>
        {!d.unavailable && typeof d.deltaPct === "number" && (
          <span
            className={`font-medium tabular-nums ${color} ${bigMove ? `px-1.5 py-0.5 rounded-md ${bigBg}` : ""}`}
            title={bigMove ? "Variation importante" : undefined}
          >
            {d.deltaPct >= 0 ? "▲" : "▼"} {Math.abs(d.deltaPct).toLocaleString("fr-FR")}%
            <span className="text-ui-muted font-normal"> {compareLabel(d)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

// Column spec for the platform overview table — order mirrors the classic
// media report: Cost, Impr., CTR, Clicks, CPC, CR%, Conversions, CPA.
const PLATFORM_COLUMNS: Array<{ key: string; label: string; goodUp: boolean | null; fmt: (v: number, currency?: string) => string }> = [
  { key: "cost", label: "Cost", goodUp: null, fmt: (v, c) => fmtMoney(v, c, { digits: 0 }) },
  { key: "impressions", label: "Impr.", goodUp: true, fmt: (v) => fmtNumber(v) },
  { key: "ctr", label: "CTR", goodUp: true, fmt: (v) => fmtPct(v, 2) },
  { key: "clicks", label: "Clicks", goodUp: true, fmt: (v) => fmtNumber(v) },
  { key: "cpc", label: "CPC", goodUp: false, fmt: (v, c) => fmtMoney(v, c, { digits: 2 }) },
  { key: "cr", label: "CR%", goodUp: true, fmt: (v) => fmtPct(v, 2) },
  { key: "conversions", label: "Conv.", goodUp: true, fmt: (v) => fmtNumber(v, 1) },
  { key: "cpa", label: "CPA", goodUp: false, fmt: (v, c) => fmtMoney(v, c, { digits: 0 }) },
];

function DeltaCell({ deltaPct, goodUp }: { deltaPct: number | null; goodUp: boolean | null }) {
  if (deltaPct === null || deltaPct === undefined) return null;
  const color =
    goodUp === null ? "text-ui-muted"
    : (deltaPct >= 0) === goodUp ? "text-ui-pos" : "text-ui-neg";
  const big = goodUp !== null && Math.abs(deltaPct) >= BIG_MOVE_PCT;
  return (
    <span className={`block tabular-nums ${color} ${big ? "text-[11px] font-medium" : "text-[10px]"}`}>
      {deltaPct >= 0 ? "▲" : "▼"} {Math.abs(deltaPct).toLocaleString("fr-FR")}%
    </span>
  );
}

function PlatformTableWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as PlatformTableData;
  if (!d.rows?.length) return <div className="text-sm text-ui-muted py-4">{emptyMessage(d)}</div>;
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-sm min-w-[640px]">
        <thead>
          <tr className="text-ui-muted text-xs border-b border-ui-line">
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
              className={`border-b border-ui-line ${row.platform === "Total" ? "bg-ui-raised font-medium" : ""}`}
            >
              <td className="py-2 px-1 text-left text-ui-fg">{String(row.platform)}</td>
              {PLATFORM_COLUMNS.map((c) => (
                <td key={c.key} className="py-2 px-1 text-right text-ui-fg2 tabular-nums align-top">
                  {c.fmt(Number(row[c.key] ?? 0), (row.currency as string | undefined) ?? d.currency)}
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
  const d = widget.data as TimeseriesData;
  if (!d.points?.length) return <div className="text-sm text-ui-muted py-4">{emptyMessage(d)}</div>;
  const money = d.metric === "spend" || d.metric === "revenue";
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={d.points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`grad-${widget.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--ui-accent)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--ui-accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--ui-line)" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: "var(--ui-muted)", fontSize: 11, fontFamily: "var(--font-geist-mono)" }}
            tickFormatter={(v: string) => v?.slice(5)}
            axisLine={false} tickLine={false}
          />
          <YAxis
            tick={{ fill: "var(--ui-muted)", fontSize: 11, fontFamily: "var(--font-geist-mono)" }}
            tickFormatter={(v: number) => (money ? fmtMoney(v, d.currency, { digits: 0 }) : String(v))}
            axisLine={false} tickLine={false} width={48}
          />
          <Tooltip
            contentStyle={{ background: "var(--ui-card)", border: "1px solid var(--ui-line-strong)", borderRadius: 8, fontSize: 12, color: "var(--ui-fg)" }}
            labelStyle={{ color: "var(--ui-fg2)" }}
            itemStyle={{ color: "var(--ui-fg)" }}
            formatter={(value) => [fmtMetric(d.metric, Number(value ?? 0), d.currency), KPI_LABELS[d.metric] ?? d.metric]}
          />
          <Area type="monotone" dataKey="value" stroke="var(--ui-accent)" strokeWidth={2} fill={`url(#grad-${widget.id})`} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function TableWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as TableData;
  const pilotLinks = useContext(PilotLinksContext);
  const linkable = pilotLinks && d.kind === "campaigns" && (d.source === "meta" || d.source === "google") && !!d.accountId;
  const pilotHref = (row: Record<string, unknown>, action: "pause" | "activate" | null) =>
    linkable && typeof row.id === "string" && row.id
      ? buildPilotHref({ platform: d.source as "meta" | "google", account: d.accountId!, object: { type: "campaign", id: row.id }, do: action })
      : null;
  if (!d.rows?.length) return <div className="text-sm text-ui-muted py-4">{emptyMessage(d)}</div>;
  const spendCol = (label: string) => ({ key: "spend", label, fmt: (v: unknown) => fmtMoney(Number(v), d.currency, { digits: 0 }) });
  const clicksCol = { key: "clicks", label: "Clics", fmt: (v: unknown) => fmtNumber(Number(v)) };
  const cols: Array<{ key: string; label: string; fmt?: (v: unknown) => string; cellClass?: (row: Record<string, unknown>) => string }> =
    d.kind === "campaigns"
      ? [
          { key: "name", label: "Campagne" },
          spendCol("Dépenses"),
          clicksCol,
          { key: "conversions", label: "Conv." },
          { key: "roas", label: "ROAS", fmt: (v) => fmtRoas(Number(v)), cellClass: (row) => roasTone(Number(row.roas)) },
        ]
      : d.kind === "keywords"
        ? [
            { key: "name", label: "Mot-clé" },
            spendCol("Dépenses"),
            clicksCol,
            { key: "conversions", label: "Conv." },
            { key: "ctr", label: "CTR", fmt: (v) => fmtPct(Number(v), 1) },
          ]
        : [
            { key: "name", label: "Terme de recherche" },
            spendCol("Dépenses"),
            clicksCol,
            { key: "conversions", label: "Conv." },
          ];
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-ui-muted text-xs border-b border-ui-line">
            {cols.map((c, i) => (
              <th key={c.key} className={`py-2 px-1 font-medium ${i === 0 ? "text-left" : "text-right"}`}>{c.label}</th>
            ))}
            {linkable && <th className="py-2 px-1 font-medium text-right" aria-label="Pilotage" />}
          </tr>
        </thead>
        <tbody>
          {d.rows.map((row, ri) => {
            // Money spent with zero conversions on the period — worth an alert tint.
            const burning =
              Number(row.spend ?? 0) > 50 && "conversions" in row && Number(row.conversions ?? 0) === 0;
            return (
              <tr key={ri} className={`border-b border-ui-line ${burning ? "bg-red-950/25" : ""}`}>
                {cols.map((c, i) => (
                  <td
                    key={c.key}
                    className={`py-2 px-1 ${i === 0 ? "text-left text-ui-fg max-w-[220px] truncate" : "text-right text-ui-fg2 tabular-nums"} ${c.cellClass?.(row) ?? ""}`}
                    title={burning && i === 0 ? "Dépense sans conversion sur la période" : undefined}
                  >
                    {c.fmt ? c.fmt(row[c.key]) : String(row[c.key] ?? "—")}
                  </td>
                ))}
                {linkable && (
                  <td className="py-2 px-1 text-right whitespace-nowrap">
                    {pilotHref(row, null) ? (
                      <span className="inline-flex items-center gap-2 text-[11px]">
                        <a href={pilotHref(row, burning ? "pause" : null)!} className="text-ui-accent-ink hover:text-ui-fg" title={burning ? "Mettre en pause dans le Pilotage" : "Modifier dans le Pilotage"}>
                          {burning ? "Pause ↗" : "Modifier ↗"}
                        </a>
                      </span>
                    ) : null}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TopCreativesWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as TopCreativesData;
  if (!d.creatives?.length) return <div className="text-sm text-ui-muted py-4">{emptyMessage(d, "Pas de créas actives sur la période")}</div>;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {d.creatives.map((c) => (
        <div key={c.adId} className="bg-ui-bg border border-ui-line rounded-xl overflow-hidden">
          <div className="aspect-square bg-ui-card">
            {c.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/media/proxy-image?url=${encodeURIComponent(c.imageUrl)}&upgrade=1`}
                alt={c.name}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-ui-muted text-xs">no image</div>
            )}
          </div>
          <div className="p-2">
            <div className="text-[11px] text-ui-fg2 truncate" title={c.name}>{c.name}</div>
            <div className="flex justify-between mt-1 text-[11px]">
              <span className="text-ui-muted">{fmtMoney(c.spend, d.currency, { digits: 0 })}</span>
              <span className={roasTone(c.unavailable ? null : c.roas)} title={c.unavailable ? "Revenu non tracké et aucun panier moyen configuré" : undefined}>
                {fmtRoas(c.roas, { estimated: c.estimated, unavailable: c.unavailable })}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PacingWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as PacingData;
  const info = pacingView(d);
  // "unknown" means Meta did not answer: the 0 it carries is not a spend.
  const pct = info.unknown ? 0 : Math.min(Math.max(d.monthlyTarget > 0 ? (d.mtdSpend / d.monthlyTarget) * 100 : 0, 0), 130);
  return (
    <div className="py-1 space-y-3">
      <div className="flex items-baseline justify-between">
        <div>
          <span className={`text-2xl font-medium tabular-nums ${info.unknown ? "text-ui-muted" : "text-ui-fg"}`}>
            {info.unknown ? "—" : fmtMoney(d.mtdSpend, d.currency, { digits: 0 })}
          </span>
          <span className="text-sm text-ui-muted"> / {fmtMoney(d.monthlyTarget, d.currency, { digits: 0 })} ce mois</span>
        </div>
        <Pill tone={info.tone}>{info.label}</Pill>
      </div>
      <div className="h-2 rounded-full bg-ui-raised overflow-hidden">
        <div
          className={`h-full rounded-full ${info.unknown ? "bg-ui-line-strong" : d.status.includes("critical") ? "bg-ui-neg" : d.status === "on_track" ? "bg-ui-pos" : "bg-ui-warn"}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      {info.reason ? (
        <div className="text-xs text-ui-warn/90">Dépense du mois indisponible — {info.reason}</div>
      ) : (
        <div className="text-xs text-ui-muted">
          Projection fin de mois : <span className="text-ui-fg2">{fmtMoney(d.projectedSpend, d.currency, { digits: 0 })}</span> ({Math.round(d.pacingPct)}% de l&apos;objectif)
        </div>
      )}
    </div>
  );
}

function TextWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as { markdown: string };
  if (!d.markdown) return <div className="text-sm text-ui-muted py-2">Texte vide</div>;
  return (
    <div className="prose prose-invert prose-sm max-w-none text-ui-fg2 [&_a]:text-ui-accent-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={SAFE_MD_COMPONENTS}>{d.markdown}</ReactMarkdown>
    </div>
  );
}

function FunnelWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as FunnelData | undefined;
  if (!d?.steps?.length || d.steps.every((s) => !s.value)) {
    return <div className="text-sm text-ui-muted py-4">{emptyMessage(d ?? {})}</div>;
  }
  // A platform missing from the sum makes every rate below mechanically wrong.
  const note = partialNote(d);
  const max = Math.max(...d.steps.map((s) => s.value), 1);
  // Impressions dwarf conversions by orders of magnitude — clamp so every bar stays visible.
  const widthPct = (v: number) => Math.max((v / max) * 100, 2.5);
  const stepBar = ["bg-ui-muted/45", "bg-ui-muted/45", "bg-ui-accent"];
  return (
    <div className="py-1">
      <div className="text-xs text-ui-muted mb-2">
        {sourceLabel(d.source)}
        {note && <span className="text-ui-warn/90"> · partiel</span>}
      </div>
      {note && <div className="text-xs text-ui-warn/90 mb-2" title={d.errors?.join(" · ")}>{note}</div>}
      <div className="space-y-1">
        {d.steps.map((s, i) => (
          <div key={s.label}>
            {i > 0 && d.rates?.[i - 1] && (
              <div className="text-xs text-ui-muted font-mono tabular-nums pl-28 py-0.5">
                ↓ {d.rates[i - 1].label} : {d.rates[i - 1].pct.toLocaleString("fr-FR")}%
              </div>
            )}
            <div className="flex items-center gap-3">
              <div className="w-24 shrink-0 text-xs text-ui-fg2">{s.label}</div>
              <div className="flex-1 h-6 rounded-md bg-ui-raised overflow-hidden">
                <div
                  className={`h-full rounded-md ${stepBar[i] ?? "bg-ui-muted/45"}`}
                  style={{ width: `${widthPct(s.value)}%` }}
                />
              </div>
              <div className="w-20 shrink-0 text-right text-sm font-medium text-ui-fg tabular-nums">
                {fmtNumber(s.value, s.label === "Conversions" ? 1 : 0)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const GENDER_INFO: Record<string, { label: string; bar: string }> = {
  female: { label: "Femmes", bar: "bg-ui-accent" },
  male: { label: "Hommes", bar: "bg-ui-fg2" },
  unknown: { label: "Inconnu", bar: "bg-ui-line-strong" },
};
const GENDER_ORDER = ["female", "male", "unknown"] as const;

function DemographicsWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as DemographicsData | undefined;
  if (!d?.rows?.length) return <div className="text-sm text-ui-muted py-4">{emptyMessage(d ?? {})}</div>;
  const fmt = (v: number) =>
    d.metric === "spend" ? fmtMoney(v, d.currency, { digits: 0 }) : fmtNumber(v, d.metric === "purchases" ? 1 : 0);
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
      <div className="flex items-center gap-4 mb-3 text-[11px] text-ui-fg2">
        <span className="text-ui-muted">{KPI_LABELS[d.metric] ?? d.metric} · par âge et genre</span>
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
            <div className="w-14 shrink-0 text-xs text-ui-fg2 tabular-nums">{age}</div>
            <div className="flex-1 space-y-1">
              {genders.map((g) => {
                const v = values[g] ?? 0;
                return (
                  <div key={g} className="flex items-center gap-2">
                    <div className="flex-1 h-3 rounded-sm bg-ui-raised overflow-hidden">
                      <div className={`h-full rounded-sm ${GENDER_INFO[g].bar}`} style={{ width: `${(v / max) * 100}%` }} />
                    </div>
                    <span className="w-16 shrink-0 text-right text-[11px] text-ui-fg2 tabular-nums">{fmt(v)}</span>
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
  const d = widget.data as GeoDeviceData | undefined;
  if (!d?.rows?.length) return <div className="text-sm text-ui-muted py-4">{emptyMessage(d ?? {})}</div>;
  const rows = d.rows.slice(0, 8); // trié spend desc côté serveur
  const max = Math.max(...rows.map((r) => r.spend), 1);
  return (
    <div className="py-1">
      <div className="flex items-center text-[11px] text-ui-muted border-b border-ui-line pb-1.5 mb-1">
        <span className="flex-1">{d.dimension === "country" ? "Pays" : "Appareil"} · {sourceLabel(d.source)}</span>
        <span className="w-16 text-right">Dépenses</span>
        <span className="w-14 text-right">Clics</span>
        <span className="w-12 text-right">Conv.</span>
      </div>
      <div className="divide-y divide-ui-line">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center py-1.5 text-sm">
            <div className="flex-1 min-w-0 pr-3">
              <div className="text-ui-fg text-xs truncate" title={r.key}>{geoDeviceLabel(d.dimension, r.key)}</div>
              <div className="h-1.5 rounded-full bg-ui-raised mt-1 overflow-hidden">
                <div className="h-full rounded-full bg-ui-accent-soft" style={{ width: `${(r.spend / max) * 100}%` }} />
              </div>
            </div>
            <span className="w-16 text-right text-ui-fg2 tabular-nums text-xs">{fmtMoney(r.spend, d.currency, { digits: 0 })}</span>
            <span className="w-14 text-right text-ui-fg2 tabular-nums text-xs">{fmtNumber(r.clicks)}</span>
            <span className="w-12 text-right text-ui-fg2 tabular-nums text-xs">{fmtNumber(r.conversions, 1)}</span>
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
  const d = widget.data as AlertsData | undefined;
  const pilotLinks = useContext(PilotLinksContext);
  if (!d?.events?.length) {
    return <div className="text-sm text-ui-pos/80 py-4">Aucune alerte récente ✓</div>;
  }
  return (
    <ul className="divide-y divide-ui-line">
      {d.events.map((e) => (
        <li key={e.id} className="py-2 flex items-start gap-2.5">
          <span
            className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${e.acknowledged ? "bg-ui-line-strong" : "bg-ui-neg"}`}
            title={e.acknowledged ? "Acquittée" : "Non acquittée"}
          />
          <div className="min-w-0 flex-1">
            <div className={`text-sm leading-snug ${e.acknowledged ? "text-ui-fg2" : "text-ui-fg"}`}>{e.message}</div>
            <div className="text-[11px] text-ui-muted mt-0.5 tabular-nums">
              {relativeDateFr(e.triggeredAt)} · {KPI_LABELS[e.metric] ?? e.metric} {fmtMetric(e.metric, e.value, d.currency)}
              <span className="text-ui-muted"> vs seuil {fmtMetric(e.metric, e.threshold, d.currency)}</span>
              {pilotLinks && e.accountId && (platformOfAccountId(e.accountId) === "meta" || platformOfAccountId(e.accountId) === "google") && (
                <> · <a href={buildPilotHref({ platform: platformOfAccountId(e.accountId) as "meta" | "google", account: e.accountId })} className="text-ui-accent-ink hover:text-ui-fg">Pilotage ↗</a></>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Meta actions ─────────────────────────────────────────────────────────────

function MetaActionsWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as MetaActionsData | undefined;
  if (!d?.rows?.length) return <div className="text-sm text-ui-muted py-4">{emptyMessage(d ?? {}, "Aucune action Meta sur la période")}</div>;
  const showValue = d.rows.some((r) => r.value !== null && r.value > 0);
  const max = Math.max(...d.rows.map((r) => r.count), 1);
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-ui-muted text-xs border-b border-ui-line">
            <th className="py-2 px-1 font-medium text-left">Action</th>
            <th className="py-2 px-1 font-medium text-right">Volume</th>
            <th className="py-2 px-1 font-medium text-right">Coût / action</th>
            {showValue && <th className="py-2 px-1 font-medium text-right">Valeur</th>}
          </tr>
        </thead>
        <tbody>
          {d.rows.map((r) => (
            <tr key={r.actionType} className="border-b border-ui-line">
              <td className="py-2 px-1 text-left max-w-[260px]">
                <div className="text-ui-fg truncate" title={r.actionType}>{r.label}</div>
                <div className="h-1 rounded-full bg-ui-raised mt-1 overflow-hidden">
                  <div className="h-full rounded-full bg-ui-accent-soft" style={{ width: `${(r.count / max) * 100}%` }} />
                </div>
              </td>
              <td className="py-2 px-1 text-right text-ui-fg2 tabular-nums align-top">
                {fmtNumber(r.count, r.count % 1 ? 1 : 0)}
                <DeltaCell deltaPct={r.deltaPct} goodUp />
              </td>
              <td className="py-2 px-1 text-right text-ui-fg2 tabular-nums align-top">
                {r.costPer === null ? "—" : fmtMoney(r.costPer, d.currency, { digits: 2 })}
              </td>
              {showValue && (
                <td className="py-2 px-1 text-right text-ui-fg2 tabular-nums align-top">
                  {r.value === null || r.value === 0 ? "—" : fmtMoney(r.value, d.currency, { digits: 0 })}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {d.compareKind && <div className="text-[11px] text-ui-muted mt-1.5 px-1">Variations {compareLabel(d)}</div>}
    </div>
  );
}

// ── CRM (HubSpot) ────────────────────────────────────────────────────────────

const CRM_STEP_BAR = ["bg-ui-muted/45", "bg-ui-muted/45", "bg-ui-muted/45", "bg-ui-accent"];

/** Shared header line: level badge · freshness, then the partial/warnings banner. */
function CrmWidgetHeader({ level, fetchedAt, partial, warnings }: Pick<CrmFunnelData, "level" | "fetchedAt" | "partial" | "warnings">) {
  return (
    <div className="space-y-2 mb-3">
      <div className="flex items-center gap-2 flex-wrap">
        <CrmLevelBadge level={level} withTitle />
        <CrmFreshness fetchedAt={fetchedAt} />
      </div>
      <CrmPartialBanner partial={partial} warnings={warnings} />
    </div>
  );
}

/**
 * Funnel « dépense → leads → qualifiés → deals → gagnés » with the real-business
 * ratios (CPL, CPL qualifié, coût / deal, coût / deal gagné, ROAS réel, taux de gain).
 * Spend is money, the other steps are counts: bars are scaled on counts only.
 */
function CrmFunnelWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as CrmFunnelData | undefined;
  if (!d) return <CrmSkeleton rows={5} />;
  const spend = d.steps.find((s) => s.key === "spend") ?? null;
  const counts = d.steps.filter((s) => s.unit === "count");
  const leads = counts.find((s) => s.key === "leads")?.value ?? 0;
  const noContacts = leads === 0 && counts.every((s) => !s.value);
  const max = Math.max(...counts.map((s) => s.value), 1);
  const widthPct = (v: number) => (v > 0 ? Math.max((v / max) * 100, 2.5) : 0);
  const stepRate = (i: number): number | null => {
    if (i === 0) return null;
    const prev = counts[i - 1]?.value ?? 0;
    return prev > 0 ? (counts[i].value / prev) * 100 : null;
  };
  const ratios: Array<{ label: string; value: string; tone?: string; title: string }> = [
    { label: "CPL", value: fmtMoney(d.ratios.cpl, d.currency, { digits: 2 }), title: "Dépense pub ÷ contacts créés" },
    { label: "CPL qualifié", value: fmtMoney(d.ratios.cplQualified, d.currency, { digits: 2 }), title: "Dépense pub ÷ contacts qualifiés (étapes qualifiées du pipeline)" },
    { label: "Coût / deal", value: fmtMoney(d.ratios.costPerDeal, d.currency, { digits: 2 }), title: "Dépense pub ÷ deals créés" },
    { label: "Coût / deal gagné", value: fmtMoney(d.ratios.costPerWon, d.currency, { digits: 2 }), title: "Dépense pub ÷ deals gagnés" },
    { label: "ROAS réel", value: d.ratios.realRoas === null ? "—" : fmtRoas(d.ratios.realRoas), tone: roasTone(d.ratios.realRoas), title: "Montant des deals gagnés ÷ dépense pub (vs ROAS plateforme)" },
    { label: "Taux de gain", value: fmtPct(d.ratios.winRate, 1), title: "Deals gagnés ÷ deals créés" },
  ];
  return (
    <div className="py-1">
      <CrmWidgetHeader level={d.level} fetchedAt={d.fetchedAt} partial={d.partial} warnings={d.warnings} />
      {d.level === 0 && noContacts ? (
        <div className="text-sm text-ui-muted py-4">Aucun contact sur la période</div>
      ) : (
        <>
          {spend && (
            <div className="flex items-center gap-3 mb-2">
              <div className="w-24 shrink-0 text-xs text-ui-fg2">{spend.label}</div>
              <div className="flex-1 text-[11px] text-ui-muted">Meta + Google</div>
              <div className="shrink-0 text-right text-sm font-medium text-ui-fg tabular-nums">{fmtMoney(spend.value, d.currency, { digits: 0 })}</div>
            </div>
          )}
          <div className="space-y-1">
            {counts.map((s, i) => {
              const rate = stepRate(i);
              return (
                <div key={s.key}>
                  {rate !== null && (
                    <div className="text-xs text-ui-muted font-mono tabular-nums pl-28 py-0.5">↓ {fmtPct(rate, 1)}</div>
                  )}
                  <div className="flex items-center gap-3">
                    <div className="w-24 shrink-0 text-xs text-ui-fg2">{s.label}</div>
                    <div className="flex-1 h-6 rounded-md bg-ui-raised overflow-hidden">
                      <div className={`h-full rounded-md ${CRM_STEP_BAR[i] ?? "bg-ui-muted/45"}`} style={{ width: `${widthPct(s.value)}%` }} />
                    </div>
                    <div className="w-20 shrink-0 text-right text-sm font-medium text-ui-fg tabular-nums">{fmtNumber(s.value)}</div>
                  </div>
                </div>
              );
            })}
          </div>
          {!spend && (
            <div className="text-[11px] text-ui-muted mt-2">Dépense publicitaire indisponible sur la période : les ratios coût / contact ne peuvent pas être calculés.</div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
            {ratios.map((r) => (
              <div key={r.label} className="bg-ui-bg border border-ui-line rounded-xl px-3 py-2 min-w-0" title={r.title}>
                <div className="text-[10px] text-ui-muted font-medium truncate">{r.label}</div>
                <div className={`text-base font-medium tabular-nums mt-0.5 ${r.value === "—" ? "text-ui-muted" : r.tone ?? "text-ui-fg"}`}>{r.value}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Per-source table, then top campaigns (utm) with their Meta / Google match; diagnostic when level < 2. */
function CrmAttributionWidget({ widget }: { widget: ResolvedWidget }) {
  const d = widget.data as CrmAttributionData | undefined;
  if (!d) return <CrmSkeleton rows={6} />;
  const limit = Math.max(1, Number(widget.config.limit ?? 10) || 10);
  const empty = d.diagnostic.contactsTotal === 0 && d.bySource.length === 0;
  return (
    <div className="py-1 space-y-4">
      <CrmWidgetHeader level={d.level} fetchedAt={d.fetchedAt} partial={d.partial} warnings={d.warnings} />
      {empty ? (
        <div className="text-sm text-ui-muted py-2">Aucun contact sur la période</div>
      ) : (
        <>
          {d.bySource.length > 0 && (
            <div>
              <div className="text-[11px] font-medium text-ui-fg2 mb-1">Par source d&apos;origine</div>
              <div className="-mx-1 rounded-lg border border-ui-line overflow-hidden">
                <CrmSourceTable rows={d.bySource} currency={d.currency} dense />
              </div>
            </div>
          )}
          {d.byCampaign.length > 0 && (
            <div>
              <div className="text-[11px] font-medium text-ui-fg2 mb-1">Top campagnes (utm_campaign)</div>
              <div className="-mx-1 rounded-lg border border-ui-line overflow-hidden">
                <CrmCampaignTable rows={d.byCampaign} currency={d.currency} limit={limit} dense />
              </div>
            </div>
          )}
        </>
      )}
      {(d.level < 2 || d.diagnostic.recommendations.length > 0) && (
        <div className="rounded-xl border border-ui-line bg-ui-bg px-3 py-3">
          <div className="text-[11px] font-medium text-ui-fg2 mb-2">Diagnostic d&apos;attribution</div>
          <CrmDiagnosticBlock diagnostic={d.diagnostic} compact />
        </div>
      )}
    </div>
  );
}

export function WidgetFrame({ widget, children, editControls, sortableRef, sortableStyle, dragging }: {
  widget: ResolvedWidget;
  children: React.ReactNode;
  editControls?: React.ReactNode;
  /**
   * Edit-mode only: wiring handed down by a `useSortable` caller (see
   * SortableWidgetFrame in editor.tsx). When `sortableRef` is absent the frame
   * renders exactly as the read-only client view — no wrapper, no transform.
   */
  sortableRef?: (el: HTMLElement | null) => void;
  sortableStyle?: React.CSSProperties;
  dragging?: boolean;
}) {
  const span =
    widget.width === "full" ? "lg:col-span-6"
    : widget.width === "half" ? "lg:col-span-3"
    : "lg:col-span-2";
  const header = (
    <div className="flex items-center justify-between mb-2">
      <h3 className="text-sm font-medium text-ui-fg">{widget.title ?? ""}</h3>
      {editControls}
    </div>
  );
  const body = <div className="flex-1 min-h-0">{children}</div>;

  if (!sortableRef) {
    return (
      <Card padded className={`${span} col-span-6 flex flex-col`}>
        {header}
        {body}
      </Card>
    );
  }

  // Sortable: the grid item is a plain div carrying the dnd-kit ref/transform
  // (Card does not forward refs); the card fills it so the layout is unchanged.
  return (
    <div
      ref={sortableRef}
      style={sortableStyle}
      className={`${span} col-span-6 rounded-xl ${dragging ? "relative z-10 opacity-60 ring-2 ring-ui-accent/70" : ""}`}
    >
      <Card padded className="h-full flex flex-col">
        {header}
        {body}
      </Card>
    </div>
  );
}
