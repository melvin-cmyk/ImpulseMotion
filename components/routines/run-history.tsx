"use client";

/**
 * Tab « Historique »: the runs of the routine, most recent first — scheduled,
 * launched by hand, dry runs and missed ones — with their counters and, on
 * demand, the detail of each step.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, History, Loader2 } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { RunSteps } from "@/components/routines/run-steps";
import { RUN_STATUS, RUN_TRIGGER, dateTimeLabel, durationLabel, runCounters, toRunView, type RunCounter, type RunView } from "@/components/routines/routine-model";

const COUNTER_TONE: Record<RunCounter["tone"], string | undefined> = { done: "text-emerald-300", plain: undefined, bad: "text-red-300", wait: "text-amber-300" };

const PAGE_SIZE = 20;

export function RunHistory({ routineId, timezone, refreshKey }: { routineId: string; timezone: string | null; /** changes after a run or a dry run */ refreshKey: number }) {
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (wanted: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/routines/${routineId}/runs?page=${wanted}&pageSize=${PAGE_SIZE}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);
      setRuns((Array.isArray(body.runs) ? body.runs : []).map(toRunView).filter((r: RunView | null): r is RunView => !!r));
      setPage(typeof body.page === "number" ? body.page : wanted);
      setPages(typeof body.pages === "number" ? body.pages : 1);
      setTotal(typeof body.total === "number" ? body.total : 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [routineId]);

  useEffect(() => {
    const t = setTimeout(() => { void load(1); }, 0);
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  if (runs === null && !error) {
    return <div className="p-4 flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement de l&apos;historique…</div>;
  }

  return (
    <div className="p-4 space-y-3">
      {error && (
        <div className="text-sm text-red-400">
          L&apos;historique n&apos;a pas pu être chargé ({error}).{" "}
          <button type="button" onClick={() => void load(page)} className="underline text-red-300">Réessayer</button>
        </div>
      )}

      {runs && runs.length === 0 && !error && (
        <div className="text-center py-8">
          <History className="w-8 h-8 text-gray-700 mx-auto mb-3" />
          <p className="text-sm text-gray-400">Aucune exécution pour l&apos;instant.</p>
          <p className="text-xs text-gray-600 mt-1">Les essais à blanc et les exécutions apparaîtront ici, avec le détail de chaque étape.</p>
        </div>
      )}

      {runs && runs.length > 0 && (
        <ul className="space-y-2">
          {runs.map((run) => {
            const st = RUN_STATUS[run.status] ?? { label: run.status, tone: "default" as const };
            const expanded = open === run.id;
            const dry = run.trigger === "dry_run";
            return (
              <li key={run.id} className="bg-gray-950/50 border border-gray-800 rounded-xl">
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : run.id)}
                  aria-expanded={expanded}
                  className="w-full text-left px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1"
                >
                  {expanded ? <ChevronDown className="w-4 h-4 text-gray-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" />}
                  <span className="text-sm text-white">{dateTimeLabel(run.startedAt, timezone)}</span>
                  <Pill tone={st.tone}>{st.label}</Pill>
                  <span className="text-xs text-gray-500">{RUN_TRIGGER[run.trigger] ?? run.trigger}</span>
                  <span className="text-xs text-gray-400 ml-auto tabular-nums flex flex-wrap gap-x-3">
                    {/* One counter per nature of write, the same for a dry run and a live run. */}
                    {runCounters(run).map((c) => <span key={c.key + c.text} className={COUNTER_TONE[c.tone]}>{c.text}</span>)}
                    {run.timedOut && <span className="text-amber-300">temps écoulé</span>}
                    {run.durationMs > 0 && <span className="text-gray-600">{durationLabel(run.durationMs)}</span>}
                  </span>
                </button>
                {expanded && (
                  <div className="px-3 pb-3 space-y-2 border-t border-gray-800 pt-3">
                    {run.error && <p className="text-xs text-red-300 break-words">{run.error}</p>}
                    <RunSteps steps={run.steps} dryRun={dry} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{total} exécution{total > 1 ? "s" : ""} · page {page} sur {pages}</span>
          <div className="flex gap-2">
            <button type="button" disabled={page <= 1 || loading} onClick={() => void load(page - 1)} className="px-2.5 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-40">Plus récentes</button>
            <button type="button" disabled={page >= pages || loading} onClick={() => void load(page + 1)} className="px-2.5 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-40">Plus anciennes</button>
          </div>
        </div>
      )}
    </div>
  );
}
