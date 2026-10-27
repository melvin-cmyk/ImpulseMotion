"use client";

/**
 * Right-hand drawer of a creative group: large visual, copy / headline /
 * landing page, metrics (current vs previous), day-by-day trend (spend +
 * one metric), and the ads of the group ("ad breakdown") with their links.
 */

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2, X } from "lucide-react";
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AdsGroupRow, AdsQuery, DailyPoint, MetricKey, Metrics } from "@/lib/ads-warehouse/query";
import { METRICS, METRIC_BY_KEY, TONE_CLASS, deltaPct, deltaTone, fmtMetric, toneVs } from "@/lib/ads-warehouse/metrics-ui";
import { AdVisual, FormatBadge, StatusDot, TagChips, isActive, relativeDay } from "./shared";
import { AdPreviewPane } from "./ad-preview";
import { AdNotes } from "./ad-notes";

interface Props {
  row: AdsGroupRow;
  query: AdsQuery;
  benchmark: Metrics;
  currency: string | null;
  onClose: () => void;
}

const fmtDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });

export function AdDrawer({ row, query, benchmark, currency, onClose }: Props) {
  const [loaded, setLoaded] = useState<{ key: string; points: DailyPoint[] } | null>(null);
  const [metric, setMetric] = useState<MetricKey>("cpc");
  const [tab, setTab] = useState<"apercu" | "performance" | "notes">("apercu");
  const ad = row.sample;
  const points = loaded && loaded.key === row.key ? loaded.points : null;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ads/daily", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...query, accounts: query.accountIds.map((id) => ({ platform: query.platforms[0], id })), key: row.key }) })
      .then((r) => (r.ok ? r.json() : { points: [] }))
      .then((j: { points: DailyPoint[] }) => { if (!cancelled) setLoaded({ key: row.key, points: j.points ?? [] }); })
      .catch(() => { if (!cancelled) setLoaded({ key: row.key, points: [] }); });
    return () => { cancelled = true; };
  }, [query, row.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const chart = useMemo(() => (points ?? []).map((p) => ({ date: fmtDay(p.date), spend: p.metrics.spend, m: p.metrics[metric] })), [points, metric]);
  const shown: MetricKey[] = ["spend", "impressions", "ctr", "cpc", "cpm", "conversions", "cpa", "cvr", "roas", "hookRate", "holdRate", "p100Rate"];

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="relative w-full max-w-xl h-full bg-gray-950 border-l border-gray-800 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-3 bg-gray-950/95 border-b border-gray-800">
          <div className="min-w-0">
            <div className="flex items-center gap-2"><StatusDot status={ad?.status} /><h2 className="text-sm font-semibold text-white truncate" title={row.label}>{row.label}</h2></div>
            <div className="text-[11px] text-gray-500 truncate">{ad?.campaignName ?? ""}{ad?.adsetName ? ` · ${ad.adsetName}` : ""}{row.launch ? ` · lancée ${relativeDay(row.launch)} (${new Date(row.launch + "T00:00:00Z").toLocaleDateString("fr-FR")})` : ""}</div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800" aria-label="Fermer"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-4 pt-3 flex gap-1 border-b border-gray-800">
          {([["apercu", "Aperçu"], ["performance", "Performance"], ["notes", "Notes & tags"]] as const).map(([id, l]) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={`px-3 py-1.5 text-xs rounded-t-md border-b-2 ${tab === id ? "border-violet-500 text-white" : "border-transparent text-gray-400 hover:text-white"}`}>{l}</button>
          ))}
        </div>
        {tab === "notes" && ad && <div className="p-4"><AdNotes platform={ad.platform} adId={ad.adId} /></div>}
        <div className={`p-4 space-y-5 ${tab === "notes" ? "hidden" : ""}`}>
          <div className={`grid grid-cols-5 gap-4 ${tab !== "apercu" ? "hidden" : ""}`}>
            <div className="col-span-2">{ad ? <AdPreviewPane ad={ad} /> : <div className="relative"><AdVisual ad={ad} className="aspect-[4/5]" /><FormatBadge ad={ad} /></div>}</div>
            <div className="col-span-3 space-y-2 text-xs">
              {ad?.title && <div><div className="text-[10px] uppercase tracking-wide text-gray-500">Titre</div><div className="text-gray-200">{ad.title}</div></div>}
              {ad?.body && <div><div className="text-[10px] uppercase tracking-wide text-gray-500">Texte</div><div className="text-gray-300 whitespace-pre-line max-h-32 overflow-y-auto">{ad.body}</div></div>}
              {ad?.landingUrl && <div><div className="text-[10px] uppercase tracking-wide text-gray-500">Landing page</div><a href={ad.landingUrl} target="_blank" rel="noopener noreferrer" className="text-violet-300 hover:text-white break-all inline-flex items-center gap-1">{ad.landingUrl.replace(/^https?:\/\//, "").slice(0, 60)} <ExternalLink className="w-3 h-3" /></a></div>}
              {ad && <TagChips tags={ad.tags} max={8} />}
              {ad?.previewUrl && <a href={ad.previewUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-white">Voir dans la bibliothèque Meta <ExternalLink className="w-3 h-3" /></a>}
            </div>
          </div>

          <div className={tab !== "performance" && tab !== "apercu" ? "hidden" : ""}>
            <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Période {query.range.since} → {query.range.until}{query.compare ? ` · vs ${query.compare.since} → ${query.compare.until}` : ""}</div>
            <div className="grid grid-cols-3 gap-2">
              {shown.map((k) => {
                const def = METRIC_BY_KEY[k];
                if (def.video && ad && ad.format !== "Video" && row.metrics.videoPlays === 0) return null;
                const v = row.metrics[k];
                const d = row.previous ? deltaPct(v, row.previous[k]) : null;
                return (
                  <div key={k} className="rounded-xl border border-gray-800 bg-gray-900 p-2">
                    <div className="text-[10px] text-gray-500" title={def.hint}>{def.label}</div>
                    <div className={`inline-block mt-0.5 rounded-md px-1.5 py-0.5 text-sm font-semibold tabular-nums ${TONE_CLASS[toneVs(k, v, benchmark[k])]}`}>{fmtMetric(k, v, currency, row.metrics)}</div>
                    <div className="text-[10px] text-gray-500">moy. {fmtMetric(k, benchmark[k], currency, benchmark)}{d !== null && <span className={`ml-1 ${deltaTone(k, d) === "good" ? "text-emerald-400" : deltaTone(k, d) === "bad" ? "text-red-400" : ""}`}>{d > 0 ? "+" : ""}{d.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} %</span>}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={tab !== "performance" ? "hidden" : ""}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Jour par jour — dépenses et</div>
              <select value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)} className="bg-gray-900 border border-gray-800 rounded-md px-2 py-1 text-[11px] text-gray-200">
                {METRICS.filter((m) => m.key !== "spend").map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            </div>
            <div className="h-44 rounded-xl border border-gray-800 bg-gray-900 p-2">
              {points === null ? <div className="h-full flex items-center justify-center text-gray-500 text-xs"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Chargement…</div> : chart.length === 0 ? <div className="h-full flex items-center justify-center text-gray-500 text-xs">Aucune livraison sur la période.</div> : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chart} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} />
                    <YAxis yAxisId="l" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} />
                    <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ background: "#111827", border: "1px solid #374151", fontSize: 11 }} formatter={(v, name) => [String(name) === "spend" ? fmtMetric("spend", Number(v ?? 0), currency) : fmtMetric(metric, Number(v ?? 0), currency), String(name) === "spend" ? "Dépenses" : METRIC_BY_KEY[metric].label]} />
                    <Area yAxisId="l" type="monotone" dataKey="spend" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.15} strokeWidth={2} />
                    <Line yAxisId="r" type="monotone" dataKey="m" stroke="#f59e0b" strokeWidth={2} dot={false} strokeDasharray="4 3" />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {row.ads.length > 1 && (
            <div className={tab !== "apercu" ? "hidden" : ""}>
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">{row.adCount} annonces dans ce groupe</div>
              <div className="rounded-xl border border-gray-800 bg-gray-900 divide-y divide-gray-800">
                {row.ads.map((a) => (
                  <div key={a.adId} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <div className="min-w-0 flex items-center gap-2">
                      <StatusDot status={a.status} />
                      <div className="min-w-0">
                        <div className="text-gray-200 truncate" title={a.name}>{a.name}</div>
                        <div className="text-[10px] text-gray-500 truncate">{a.adsetName ?? a.campaignName ?? a.adId}{a.createdTime ? ` · ${new Date(a.createdTime + "T00:00:00Z").toLocaleDateString("fr-FR")}` : ""}{isActive(a.status) ? "" : " · en pause"}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="tabular-nums text-gray-300">{fmtMetric("spend", a.spend, currency)}</span>
                      {a.previewUrl && <a href={a.previewUrl} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-white" title="Ouvrir"><ExternalLink className="w-3 h-3" /></a>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
