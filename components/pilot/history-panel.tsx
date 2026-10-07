"use client";

/**
 * Pilotage — the whole « Historique & impact » block, the same in /pilotage
 * and in a client's dashboard: the period in figures (who changed what, how
 * the last seven days compare, what the analyses say), the curve of the
 * account with every change marked, the filters, the history itself, and a
 * CSV of it. Read only here; the actions on cards (undo, HQ, « pourquoi »)
 * are those of the cards.
 */

import { useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { PLATFORM_FR, money } from "@/lib/pilot/ops";
import { CATEGORIES, deltaPct, historyCsv, historyStats, type ChangeCategory, type Figures } from "@/lib/pilot/history-stats";
import type { HistoryView, PlatformChangeView } from "@/lib/pilot/history";
import type { PilotActionView } from "@/lib/pilot/service";
import { ChangeChart, marksOf, type ChartMetric } from "@/components/pilot/change-chart";
import { HistoryTimeline, NO_FILTER, type HistoryFilter, type SourceFilter } from "@/components/pilot/timeline";

const VERDICT_TONE: Record<string, "emerald" | "red" | "amber" | "default"> = { improved: "emerald", worse: "red", mixed: "amber" };

function Delta({ before, after, lowerIsBetter = false, fmt }: { before: number | null; after: number | null; lowerIsBetter?: boolean; fmt: (v: number | null) => string }) {
  const d = deltaPct(before, after);
  const good = d === null ? null : lowerIsBetter ? d < 0 : d > 0;
  return (
    <span className="tabular-nums">
      <span className="text-white font-semibold">{fmt(after)}</span>
      {d !== null && Math.abs(d) >= 1 && <span className={`ml-1 text-[11px] ${good ? "text-emerald-300" : "text-red-300"}`}>{d > 0 ? "+" : ""}{Math.round(d)} %</span>}
      <span className="block text-[10px] text-gray-500">7 j d&apos;avant : {fmt(before)}</span>
    </span>
  );
}

function Week({ last7, prev7, currency }: { last7: Figures; prev7: Figures; currency: string }) {
  const m = (v: number | null) => (v === null ? "—" : money(Math.round(v * 100), currency));
  const n = (v: number | null) => (v === null ? "—" : v.toLocaleString("fr-FR", { maximumFractionDigits: 1 }));
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
      <div><p className="text-gray-500 mb-0.5">Dépense 7 j</p><Delta before={prev7.spend} after={last7.spend} fmt={m} /></div>
      <div><p className="text-gray-500 mb-0.5">Conversions 7 j</p><Delta before={prev7.conversions} after={last7.conversions} fmt={n} /></div>
      <div><p className="text-gray-500 mb-0.5">CPA 7 j</p><Delta before={prev7.cpa} after={last7.cpa} lowerIsBetter fmt={m} /></div>
      {(last7.roas !== null || prev7.roas !== null) && <div><p className="text-gray-500 mb-0.5">ROAS 7 j</p><Delta before={prev7.roas} after={last7.roas} fmt={(v) => (v === null ? "—" : `${v.toFixed(2)}×`)} /></div>}
    </div>
  );
}

export function HistoryPanel({ actions, changes, series, sync, loading, days, onDays, onReload, showClient, clientNames, onUndo, onActionChanged, onChangeChanged, accountName }: {
  actions: PilotActionView[];
  changes: PlatformChangeView[];
  series: HistoryView["series"];
  sync: HistoryView["sync"];
  loading: boolean;
  days: number;
  onDays: (d: number) => void;
  onReload?: () => void;
  showClient?: boolean;
  clientNames?: Record<string, string>;
  accountName?: string | null;
  onUndo: (preview: PilotActionView) => void;
  onActionChanged: (action: PilotActionView) => void;
  onChangeChanged: (change: PlatformChangeView) => void;
}) {
  const [filter, setFilter] = useState<HistoryFilter>(NO_FILTER);
  const [metric, setMetric] = useState<ChartMetric>("spend");
  const stats = useMemo(() => historyStats(actions, changes, series?.points ?? null), [actions, changes, series]);
  const total = stats.bySource.impulsemotion + stats.bySource.external + stats.bySource.automated;
  const marks = useMemo(() => {
    if (!series) return [];
    const shownIds = new Set(actions.map((a) => a.id));
    return marksOf([
      ...actions.filter((a) => a.executedAt && a.platform === series.platform && a.accountId === series.accountId).map((a) => ({ at: a.executedAt!, source: "impulsemotion" as const, text: `${a.createdByName} : ${a.operations.map((o) => o.line).join(" ; ")}` })),
      ...changes.filter((c) => c.platform === series.platform && c.accountId === series.accountId && !(c.pilotActionId && shownIds.has(c.pilotActionId))).map((c) => ({ at: c.at, source: c.source, text: `${c.actorName} : ${c.line}` })),
    ]);
  }, [actions, changes, series]);
  const categories = useMemo(() => CATEGORIES.filter((c) => stats.byCategory.some((b) => b.category === c)), [stats]);

  function exportCsv() {
    const blob = new Blob([historyCsv(actions, changes)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `historique-pilotage-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const input = "bg-gray-950 border border-gray-700 rounded-md px-2 py-1 text-xs text-gray-200";

  return (
    <div className="space-y-4">
      {/* The period in figures */}
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-white font-semibold text-sm">{total} modification{total > 1 ? "s" : ""} en {days} jours</span>
            {stats.bySource.impulsemotion > 0 && <Pill tone="violet" className="text-[10px]">{stats.bySource.impulsemotion} ImpulseMotion</Pill>}
            {stats.bySource.external > 0 && <Pill tone="amber" className="text-[10px]">{stats.bySource.external} hors ImpulseMotion</Pill>}
            {stats.bySource.automated > 0 && <Pill className="text-[10px]">{stats.bySource.automated} automatiques</Pill>}
            {stats.verdicts.map((v) => <Pill key={v.verdict} tone={VERDICT_TONE[v.verdict] ?? "default"} className="text-[10px]">{v.count} {v.label}</Pill>)}
          </div>
          {stats.actors.length > 0 && (
            <p className="text-gray-400"><span className="text-gray-500">Qui :</span> {stats.actors.map((a) => <button key={a.name} type="button" onClick={() => setFilter({ ...filter, query: filter.query === a.name ? "" : a.name })} className={`mr-2 hover:text-white ${filter.query === a.name ? "text-white underline" : ""}`}>{a.name} <span className="text-gray-600">({a.count})</span></button>)}</p>
          )}
          {stats.objects.length > 0 && (
            <p className="text-gray-400 truncate"><span className="text-gray-500">Le plus touché :</span> {stats.objects.map((o) => <button key={o.name} type="button" onClick={() => setFilter({ ...filter, query: filter.query === o.name ? "" : o.name })} className={`mr-2 hover:text-white ${filter.query === o.name ? "text-white underline" : ""}`} title={o.name}>{o.name.length > 36 ? `${o.name.slice(0, 35)}…` : o.name} <span className="text-gray-600">({o.count})</span></button>)}</p>
          )}
          {stats.byCategory.length > 0 && (
            <p className="text-gray-400"><span className="text-gray-500">Quoi :</span> {stats.byCategory.map((c) => <button key={c.category} type="button" onClick={() => setFilter({ ...filter, category: filter.category === c.category ? "all" : c.category })} className={`mr-2 hover:text-white ${filter.category === c.category ? "text-white underline" : ""}`}>{c.category} <span className="text-gray-600">({c.count})</span></button>)}</p>
          )}
        </div>
        {stats.last7 && stats.prev7 && series ? <Week last7={stats.last7} prev7={stats.prev7} currency={series.currency} /> : <p className="text-xs text-gray-500 self-center">Les 7 derniers jours se comparent aux 7 d&apos;avant dès que la courbe couvre 15 jours.</p>}
      </div>

      {/* The curve */}
      {series && (
        <div>
          <p className="text-xs text-gray-500 mb-1">{PLATFORM_FR[series.platform]} · compte « {accountName || series.accountId} » par jour, chaque modification marquée.</p>
          {series.error ? <p className="text-xs text-amber-300">Courbe indisponible : {series.error}</p> : (
            <ChangeChart points={series.points} currency={series.currency} marks={marks} metric={metric} onMetric={setMetric} selectedDay={filter.day} onDayClick={(day) => setFilter({ ...filter, day })} />
          )}
        </div>
      )}
      {sync.some((s) => s.lastError) && <p className="text-xs text-amber-300">{sync.filter((s) => s.lastError).map((s) => `${PLATFORM_FR[s.platform]} ${s.accountId} : ${s.lastError}`).join(" · ")}</p>}
      {!sync.length && !loading && <p className="text-xs text-gray-500">Les journaux des plateformes n&apos;ont pas encore été lus pour ce client.</p>}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {([["all", "Tout"], ["impulsemotion", "ImpulseMotion"], ["external", "Hors ImpulseMotion"], ["automated", "Automatique"]] as Array<[SourceFilter, string]>).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setFilter({ ...filter, source: k })} className={`px-2 py-1 rounded-md border ${filter.source === k ? "border-violet-500 text-white" : "border-gray-800 text-gray-400 hover:text-white"}`}>{l}</button>
        ))}
        <select value={filter.category} onChange={(e) => setFilter({ ...filter, category: e.target.value as ChangeCategory | "all" })} className={input}>
          <option value="all">Tous les réglages</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input value={filter.query} onChange={(e) => setFilter({ ...filter, query: e.target.value })} placeholder="Chercher (objet, personne, texte)" className={`${input} w-56`} />
        {filter.day && <button type="button" onClick={() => setFilter({ ...filter, day: null })} className="px-2 py-1 rounded-md border border-violet-500 text-white">{filter.day.slice(8, 10)}/{filter.day.slice(5, 7)} ×</button>}
        {(filter.query || filter.category !== "all" || filter.source !== "all" || filter.day) && <button type="button" onClick={() => setFilter(NO_FILTER)} className="text-gray-400 hover:text-white">Effacer les filtres</button>}
        <span className="flex-1" />
        <select value={days} onChange={(e) => onDays(Number(e.target.value))} className={input}>
          {[14, 30, 60, 90, 120].map((d) => <option key={d} value={d}>{d} jours</option>)}
        </select>
        {onReload && (
          <button type="button" onClick={onReload} className="text-gray-400 hover:text-white flex items-center gap-1">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Relire les journaux
          </button>
        )}
        <button type="button" onClick={exportCsv} className="text-gray-400 hover:text-white flex items-center gap-1" title="Exporter l'historique (CSV, Excel)"><Download className="w-3.5 h-3.5" /> CSV</button>
      </div>

      <HistoryTimeline actions={actions} changes={changes} loading={loading} filter={filter} showClient={showClient} clientNames={clientNames} onUndo={onUndo} onActionChanged={onActionChanged} onChangeChanged={onChangeChanged} />
    </div>
  );
}
