"use client";

/**
 * Tab « Essai à blanc »: runs the routine on the real data without writing
 * anything, and lists what would be written, item by item. A successful dry
 * run on the current definition is what opens the activation.
 *
 * Shows the dry run just launched, otherwise the last one of the history.
 */

import { useEffect, useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { RunSteps } from "@/components/routines/run-steps";
import {
  RUN_STATUS, actionBlocked, dateTimeLabel, durationLabel, emptyDryRunWarning, plannedWrites, runCounters, toRunView, type RoutineView, type RunView,
} from "@/components/routines/routine-model";

export function DryRunPanel({ routine, onDone }: { routine: RoutineView; onDone: (routine: unknown) => void }) {
  const [run, setRun] = useState<RunView | null>(null);
  const [fromHistory, setFromHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = actionBlocked("dry_run", routine);

  // The last dry run of the history, until one is launched from here.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/routines/${routine.id}/runs?pageSize=20`)
      .then((r) => (r.ok ? r.json() : { runs: [] }))
      .then((j) => {
        if (cancelled) return;
        const runs: RunView[] = (Array.isArray(j.runs) ? j.runs : []).map(toRunView).filter((r: RunView | null): r is RunView => !!r);
        const last = runs.find((r) => r.trigger === "dry_run") ?? null;
        setRun((current) => current ?? last);
        setFromHistory((current) => current || !!last);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [routine.id]);

  async function launch() {
    if (busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/routines/${routine.id}/dry-run`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);
      const view = toRunView({ trigger: "dry_run", startedAt: Date.now(), ...(body.result ?? body.run ?? {}) });
      if (!view) throw new Error("Réponse illisible du serveur");
      setRun(view);
      setFromHistory(false);
      onDone(body.routine);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const outdated = !!run && !!routine.definitionHash && !!run.definitionHash && run.definitionHash !== routine.definitionHash;
  const planned = run ? plannedWrites(run) : [];
  const st = run ? RUN_STATUS[run.status] ?? { label: run.status, tone: "default" as const } : null;
  const nothingSeen = outdated ? null : emptyDryRunWarning(run, routine);

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={launch}
          disabled={busy || !!blocked}
          title={blocked ?? undefined}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
          {busy ? "Essai en cours…" : "Lancer l'essai à blanc"}
        </button>
        <p className="text-xs text-gray-500 flex-1 min-w-[12rem]">
          {blocked ?? "Lit les vraies données et liste ce qui serait écrit. Rien n'est créé, envoyé ni modifié."}
        </p>
      </div>

      {busy && <p className="text-xs text-gray-500">L&apos;essai lit les sources une à une : il peut durer une à deux minutes. Laissez cette page ouverte.</p>}
      {error && <div className="text-sm text-red-400 break-words">{error}</div>}

      {!run && !busy && !error && (
        <div className="text-center py-8">
          <FlaskConical className="w-8 h-8 text-gray-700 mx-auto mb-3" />
          <p className="text-sm text-gray-400">Aucun essai à blanc pour l&apos;instant.</p>
          <p className="text-xs text-gray-600 mt-1">L&apos;activation exige un essai réussi sur la définition actuelle.</p>
        </div>
      )}

      {run && st && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
            <Pill tone={st.tone}>{st.label}</Pill>
            <span>{fromHistory ? "Dernier essai" : "Essai"} du {dateTimeLabel(run.startedAt, routine.timezone)}</span>
            {run.durationMs > 0 && <span>· {durationLabel(run.durationMs)}</span>}
            {runCounters(run).map((c) => <span key={c.key + c.text}>· {c.text}</span>)}
          </div>

          {nothingSeen && (
            <div role="alert" className="text-sm text-amber-200 bg-amber-950/40 border border-amber-700/60 rounded-lg px-3 py-2 font-semibold">
              {nothingSeen}
              <span className="block mt-1 text-xs font-normal text-amber-300">
                L&apos;activation reste possible, mais aucune publicité n&apos;a été montrée : relisez la définition, ou ajoutez une ligne au Sheet et relancez l&apos;essai.
              </span>
            </div>
          )}

          {outdated && (
            <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2">
              Cet essai porte sur une ancienne définition : relancez-le pour pouvoir activer la routine.
            </div>
          )}
          {!outdated && run.status === "success" && routine.dryRunValid && !nothingSeen && (
            <div className="text-xs text-emerald-300 bg-emerald-950/30 border border-emerald-900/40 rounded-lg px-3 py-2">
              Essai réussi sur la définition actuelle. Relisez la liste ci-dessous : si elle vous convient, vous pouvez activer la routine.
            </div>
          )}
          {run.status !== "success" && (
            <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2">
              L&apos;essai n&apos;a pas abouti : l&apos;activation reste fermée. Corrigez avec l&apos;IA (décrivez-lui l&apos;erreur), puis relancez.
              {run.error && <span className="block mt-1 break-words">{run.error}</span>}
            </div>
          )}
          {run.timedOut && <div className="text-xs text-amber-300">Le budget de temps a été atteint avant la fin.</div>}

          <div>
            <h3 className="text-xs font-semibold text-white mb-1.5">Ce qui serait écrit ({planned.length})</h3>
            {planned.length === 0 ? (
              <p className="text-xs text-gray-500">Rien : avec les données d&apos;aujourd&apos;hui, cette routine n&apos;écrirait rien.</p>
            ) : (
              <p className="text-xs text-gray-500">Le détail de chaque élément figure sous l&apos;étape qui l&apos;écrit.</p>
            )}
          </div>

          <RunSteps steps={run.steps} dryRun />
        </>
      )}
    </div>
  );
}
