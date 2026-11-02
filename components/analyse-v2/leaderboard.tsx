"use client";

/**
 * Motion's Leaderboard for one client: the week's account KPIs vs the week
 * before, the top creatives by spend with their rank change and weeks in the
 * top, and the creatives that are scaling, declining, new or paused.
 * Data: POST /api/ads/leaderboard (lib/ads-warehouse/leaderboard.ts).
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Minus, Sparkles } from "lucide-react";
import type { AdsGroupRow, AdsQuery, MetricKey } from "@/lib/ads-warehouse/query";
import type { LeaderboardResult, LeaderRow } from "@/lib/ads-warehouse/leaderboard";
import { METRIC_BY_KEY, deltaPct, deltaTone, fmtMetric } from "@/lib/ads-warehouse/metrics-ui";
import { SPEND_STATE_HINT } from "@/lib/ads-warehouse/trends";
import { AdDrawer } from "./ad-drawer";
import { AdMedia, MediaCaption } from "./ad-media";
import { FORMAT_LABEL, ScoreGauge, TrendText, adImageSrc, colorFor } from "./shared";

const fmtDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const DELTA_CLASS = { good: "text-emerald-400", bad: "text-red-400", neutral: "text-gray-500" } as const;

function Delta({ k, cur, prev }: { k: MetricKey; cur: number; prev: number | null | undefined }) {
  const d = deltaPct(cur, prev);
  if (d === null) return null;
  return <span className={`text-xs tabular-nums ${DELTA_CLASS[deltaTone(k, d)]}`}>{d > 0 ? "+" : ""}{d.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} %</span>;
}

function RankMove({ row }: { row: LeaderRow }) {
  if (row.rankChange === null) return <span className="inline-flex items-center gap-0.5 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300" title="Pas dans le top la semaine dernière"><Sparkles className="w-3 h-3" />Entrée</span>;
  if (row.rankChange === 0) return <span className="inline-flex items-center text-gray-500" title="Même place que la semaine dernière"><Minus className="w-3.5 h-3.5" /></span>;
  const up = row.rankChange > 0;
  return <span className={`inline-flex items-center text-xs font-semibold ${up ? "text-emerald-400" : "text-red-400"}`} title={`${up ? "Gagne" : "Perd"} ${Math.abs(row.rankChange)} place(s) vs la semaine dernière`}>{up ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}{Math.abs(row.rankChange)}</span>;
}

const TREND_COLUMNS = [
  { key: "scaling", title: "En hausse", empty: "Aucune créa n'accélère cette semaine." },
  { key: "declining", title: "En baisse", empty: "Aucune créa ne ralentit cette semaine." },
  { key: "new", title: "Nouvelles", empty: "Aucune nouvelle créa n'a dépensé cette semaine." },
  { key: "paused", title: "En pause", empty: "Aucune créa ne s'est arrêtée cette semaine." },
] as const;

interface Props {
  /** The page's query: accounts and platforms are reused; the week ends at range.until. */
  query: AdsQuery;
}

export function Leaderboard({ query }: Props) {
  const body = useMemo(() => JSON.stringify({ platforms: query.platforms, accounts: query.accounts, accountIds: query.accountIds, range: { since: query.range.until, until: query.range.until } }), [query.platforms, query.accounts, query.accountIds, query.range.until]);
  const [state, setState] = useState<{ body: string; data: LeaderboardResult | null; error: string | null } | null>(null);
  const [open, setOpen] = useState<AdsGroupRow | null>(null);
  const current = state && state.body === body ? state : null;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ads/leaderboard", { method: "POST", headers: { "Content-Type": "application/json" }, body })
      .then(async (r) => (r.ok ? ((await r.json()) as LeaderboardResult) : Promise.reject(new Error((await r.json().catch(() => ({}))).error ?? `Erreur ${r.status}`))))
      .then((data) => { if (!cancelled) setState({ body, data, error: null }); })
      .catch((e: Error) => { if (!cancelled) setState({ body, data: null, error: e.message }); });
    return () => { cancelled = true; };
  }, [body]);

  if (!current) return <div className="px-6 py-16 flex items-center justify-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Classement de la semaine…</div>;
  if (current.error || !current.data) return <div className="px-6 py-16 text-center text-sm text-red-300">Leaderboard indisponible : {current.error}</div>;
  const d = current.data;
  const cur = d.overview.current;
  const prev = d.overview.previous;
  const kpis: MetricKey[] = ["spend", "conversions", "cpa", "roas", "ctr", "hookRate"];
  const drawerQuery: AdsQuery = { ...query, groupBy: "creative", filters: {}, range: { since: d.period.since, until: d.period.until }, compare: null };

  return (
    <div className="px-6 pb-10 space-y-6">
      <div className="text-xs text-gray-500">Semaine du {fmtDay(d.period.since)} au {fmtDay(d.period.until)} · comparée au {fmtDay(d.period.previousSince)} – {fmtDay(d.period.previousUntil)}</div>

      {/* Overview */}
      <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {kpis.map((k) => (
          <div key={k} className="rounded-2xl border border-gray-800 bg-gray-900 px-4 py-3">
            <div className="text-xs text-gray-500">{METRIC_BY_KEY[k]?.label}</div>
            <div className="mt-1 text-lg font-semibold text-white tabular-nums">{fmtMetric(k, cur[k], d.overview.currency, cur)}</div>
            <Delta k={k} cur={cur[k]} prev={prev?.[k]} />
          </div>
        ))}
        <div className="rounded-2xl border border-gray-800 bg-gray-900 px-4 py-3">
          <div className="text-xs text-gray-500">Créas lancées</div>
          <div className="mt-1 text-lg font-semibold text-white tabular-nums">{d.overview.launched}</div>
          <span className="text-xs text-gray-500">cette semaine</span>
        </div>
      </section>

      {/* Leaderboard */}
      <section className="rounded-2xl border border-gray-800 bg-gray-900">
        <div className="px-4 py-3 border-b border-gray-800 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-white">Top {d.leaderboard.length || 10} de la semaine</h2>
          <span className="text-xs text-gray-500">par dépense · évolution de place vs la semaine dernière</span>
        </div>
        {d.leaderboard.length === 0 ? <div className="px-4 py-10 text-center text-sm text-gray-500">Aucune dépense cette semaine.</div> : (
          <ol>
            {d.leaderboard.map((r) => {
              const img = adImageSrc(r.sample);
              return (
                <li key={r.key}>
                  <button type="button" onClick={() => setOpen(r)} className="w-full flex items-center gap-4 px-4 py-2.5 border-t border-gray-800 first:border-t-0 hover:bg-gray-800/40 text-left">
                    <span className="w-6 text-right text-sm font-semibold text-gray-300 tabular-nums">{r.rank}</span>
                    <span className="w-14 flex justify-center"><RankMove row={r} /></span>
                    {/* eslint-disable-next-line @next/next/no-img-element -- Meta CDN thumbnails */}
                    {img ? <img src={img} alt="" className="w-11 h-11 rounded-lg object-cover bg-gray-800 shrink-0" /> : <span className={`w-11 h-11 rounded-lg bg-gradient-to-br ${colorFor(r.key)} shrink-0`} />}
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-white truncate" title={r.label}>{r.label}</span>
                      <span className="flex items-center gap-2 text-xs text-gray-500">
                        <span>{r.weeks} sem. dans le top</span>
                        {r.trend && r.trend.state !== "stable" && r.trend.state !== "testing" && <TrendText trend={r.trend} />}
                        {r.adCount > 1 && <span>{r.adCount} annonces</span>}
                      </span>
                    </span>
                    {(["spend", "cpa", "ctr"] as MetricKey[]).map((k) => (
                      <span key={k} className="hidden md:flex w-28 flex-col items-end">
                        <span className="text-[10px] text-gray-500">{METRIC_BY_KEY[k]?.short}</span>
                        <span className="text-sm text-gray-100 tabular-nums">{fmtMetric(k, r.metrics[k], d.overview.currency, r.metrics)}</span>
                        <Delta k={k} cur={r.metrics[k]} prev={r.previous?.[k]} />
                      </span>
                    ))}
                    <span className="hidden lg:flex w-24 flex-col items-end">
                      <span className="text-[10px] text-gray-500">Convert score</span>
                      <ScoreGauge value={r.metrics.convertScore} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* Trends */}
      <section className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-4 gap-4">
        {TREND_COLUMNS.map((col) => {
          const rows = d.trends.rows[col.key];
          return (
            <div key={col.key} className="rounded-2xl border border-gray-800 bg-gray-900 p-3">
              <div className="flex items-baseline justify-between mb-2" title={SPEND_STATE_HINT[col.key]}>
                <h3 className="text-sm font-semibold text-white">{col.title}</h3>
                <span className="text-xs text-gray-500 tabular-nums">{d.trends.counts[col.key]} créa{d.trends.counts[col.key] > 1 ? "s" : ""}</span>
              </div>
              {rows.length === 0 ? <div className="py-6 text-center text-xs text-gray-500">{col.empty}</div> : (
                <div className="grid grid-cols-2 gap-2">
                  {rows.map((r) => (
                    <div key={r.key} role="button" tabIndex={0} onClick={() => setOpen(r)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(r); }} className="text-left rounded-xl border border-gray-800 hover:border-violet-500/50 overflow-hidden cursor-pointer">
                      <AdMedia ad={r.sample} ratio="4:5" onOpen={() => setOpen(r)} caption={<MediaCaption>{r.adCount > 1 ? `${r.adCount} annonces` : FORMAT_LABEL[r.sample?.format ?? "Unknown"]}</MediaCaption>} />
                      <div className="px-2 py-1.5">
                        <div className="text-xs text-white truncate" title={r.label}>{r.label}</div>
                        <div className="text-[11px] text-gray-500 tabular-nums">
                          {r.trend && <TrendText trend={r.trend} />} · {fmtMetric("spend", r.trend?.last7 ?? 0, d.overview.currency)} / 7 j
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </section>

      {open && <AdDrawer row={open} query={drawerQuery} benchmark={cur} currency={d.overview.currency} onClose={() => setOpen(null)} />}
    </div>
  );
}
