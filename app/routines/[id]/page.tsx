"use client";

/**
 * One routine: the conversation with the AI that writes it, then what is
 * stored (Définition), what it would write (Essai à blanc) and what it did
 * (Historique). Every button goes through the routes of the engine, which
 * decide; the reasons shown next to a greyed button only avoid a doomed click.
 */

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Archive, ArrowLeft, CalendarClock, Loader2, Pause, Play, Power, Zap } from "lucide-react";
import { Card, Kpi, PageHeader, Pill } from "@/components/ui/surface";
import { RoutineChat } from "@/components/routines/routine-chat";
import { DefinitionView } from "@/components/routines/definition-view";
import { DryRunPanel } from "@/components/routines/dry-run-panel";
import { RunHistory } from "@/components/routines/run-history";
import { ItemsToCheck } from "@/components/routines/items-to-check";
import { scheduleTitle } from "@/components/routines/schedule-label";
import {
  ROUTINE_STATUS, RUN_STATUS, actionBlocked, dateTimeLabel, degradedBanner, exampleByKey, hasDefinition, runCounters, toRoutineView, toRunView,
  type RoutineAction, type RoutineView,
} from "@/components/routines/routine-model";

type Tab = "definition" | "dry_run" | "history";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "definition", label: "Définition" },
  { key: "dry_run", label: "Essai à blanc" },
  { key: "history", label: "Historique" },
];

const BUTTON = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed";

export default function RoutinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const example = exampleByKey(useSearchParams().get("exemple"));

  const [routine, setRoutine] = useState<RoutineView | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [tab, setTab] = useState<Tab>("definition");
  const [pending, setPending] = useState<RoutineAction | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [historyKey, setHistoryKey] = useState(0);

  const accept = useCallback((raw: unknown) => {
    const view = toRoutineView(raw);
    if (view) setRoutine(view);
    return view;
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/routines/${id}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setLoadError({ status: res.status, message: body.error ?? `Erreur ${res.status}` }); return; }
      if (!accept(body.routine)) { setLoadError({ status: 500, message: "Réponse illisible du serveur" }); return; }
      setLoadError(null);
    } catch (e) {
      setLoadError({ status: 0, message: e instanceof Error ? e.message : String(e) });
    }
  }, [id, accept]);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  async function act(action: Exclude<RoutineAction, "dry_run">) {
    if (!routine || pending) return;
    if (action === "archive" && !window.confirm(`Archiver la routine « ${routine.name} » ? Elle ne s'exécutera plus. Son historique est conservé.`)) return;
    if (action === "run" && !window.confirm(
      routine.writesPlatform
        ? `Exécuter maintenant « ${routine.name} » ? Des publicités Meta seront créées EN PAUSE sur le compte ${routine.metaAccountId ?? "de la routine"}.`
        : `Exécuter maintenant « ${routine.name} » ? Les écritures et les envois seront faits pour de bon.`,
    )) return;

    setPending(action);
    setNotice(null);
    try {
      const res = action === "activate" || action === "run"
        ? await fetch(`/api/routines/${id}/${action}`, { method: "POST" })
        : await fetch(`/api/routines/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          });
      const body = await res.json().catch(() => ({}));
      if (body.routine) accept(body.routine);
      if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);

      if (action === "run") {
        const view = toRunView({ trigger: "manual", ...(body.result ?? body.run ?? {}) });
        const st = RUN_STATUS[String(view?.status)]?.label ?? String(view?.status ?? "terminée");
        const said = view ? runCounters(view).map((c) => c.text).join(", ") : "résultat illisible";
        setNotice({ ok: body.ok !== false, text: `Exécution ${st.toLowerCase()} : ${said}. Détail dans l'historique.` });
        setHistoryKey((k) => k + 1);
        setTab("history");
      } else {
        setNotice({
          ok: true,
          text: action === "activate" ? "Routine activée." : action === "pause" ? "Routine mise en pause." : action === "resume" ? "Routine reprise." : "Routine archivée.",
        });
      }
      // Always read again: the health of the routine and its rows to check come with the routine itself.
      await load();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setPending(null);
    }
  }

  if (loadError && !routine) {
    return (
      <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-4">
        <Link href="/routines" className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-white"><ArrowLeft className="w-3.5 h-3.5" /> Routines</Link>
        <Card padded className="border-red-900/40">
          <p className="text-sm text-red-400">
            {loadError.status === 404 ? "Cette routine n'existe pas ou a été supprimée."
              : loadError.status === 403 ? "Cette routine porte sur un compte qui n'est pas dans votre périmètre."
              : `La routine n'a pas pu être chargée (${loadError.message}).`}
          </p>
          {loadError.status !== 404 && loadError.status !== 403 && (
            <button type="button" onClick={() => void load()} className="mt-2 text-xs underline text-gray-300">Réessayer</button>
          )}
        </Card>
      </div>
    );
  }

  if (!routine) {
    return <div className="p-6 flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement de la routine…</div>;
  }

  const st = ROUTINE_STATUS[routine.status] ?? { label: routine.status, tone: "default" as const };
  const last = routine.lastRunStatus ? RUN_STATUS[routine.lastRunStatus] ?? { label: routine.lastRunStatus, tone: "default" as const } : null;
  const archived = routine.status === "archived";
  const blocked = {
    activate: actionBlocked("activate", routine),
    pause: actionBlocked("pause", routine),
    resume: actionBlocked("resume", routine),
    run: actionBlocked("run", routine),
  };
  const spinner = (a: RoutineAction) => (pending === a ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-5">
      <Link href="/routines" className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-white">
        <ArrowLeft className="w-3.5 h-3.5" /> Routines
      </Link>

      <div className="space-y-2">
        <PageHeader title={routine.name} subtitle={<span className="text-violet-300">{routine.clientName}</span>} />
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
          <Pill tone={st.tone}>{st.label}</Pill>
          {routine.running && <Pill tone="blue">Exécution en cours</Pill>}
          <span className="inline-flex items-center gap-1"><CalendarClock className="w-3.5 h-3.5" />{hasDefinition(routine) ? scheduleTitle(routine.schedule, routine.timezone) : "Pas encore de définition"}</span>
          {routine.metaAccountId && <span className="font-mono">Meta {routine.metaAccountId}</span>}
          {routine.googleCustomerId && <span className="font-mono">Google {routine.googleCustomerId}</span>}
        </div>
      </div>

      {routine.writesPlatform && (
        <div role="note" className="flex items-start gap-2 text-sm text-amber-200 bg-amber-950/30 border border-amber-900/50 rounded-xl px-4 py-3">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Cette routine <strong>crée des publicités Meta en pause</strong> sur le compte <span className="font-mono">{routine.metaAccountId ?? "—"}</span>.
            Elle n&apos;active rien : chaque publicité reste en pause jusqu&apos;à ce que vous l&apos;activiez dans Meta.
          </span>
        </div>
      )}

      {(() => {
        const degraded = degradedBanner(routine);
        return degraded && (
          <div role="alert" className="text-sm text-amber-200 bg-amber-950/30 border border-amber-900/50 rounded-xl px-4 py-3">
            <strong>{degraded.title}</strong> Elle continue de s&apos;exécuter. Consultez l&apos;historique et corrigez avec l&apos;IA.
            {degraded.error && <span className="block mt-1 text-xs text-amber-300 break-words">Dernière erreur : {degraded.error}</span>}
          </div>
        );
      })()}

      <ItemsToCheck routineId={routine.id} timezone={routine.timezone} refreshKey={historyKey} readOnly={archived} onChanged={() => { void load(); }} />

      {routine.status === "error" && (
        <div className="text-sm text-red-300 bg-red-950/30 border border-red-900/50 rounded-xl px-4 py-3">
          Routine arrêtée après {routine.consecutiveFailures || "plusieurs"} échecs de suite. Consultez l&apos;historique, corrigez avec l&apos;IA, refaites un essai à blanc, puis activez-la de nouveau.
        </div>
      )}

      {/* Actions */}
      <Card padded className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {routine.status === "paused" ? (
            <button type="button" onClick={() => void act("resume")} disabled={!!blocked.resume || !!pending} title={blocked.resume ?? undefined} className={`${BUTTON} bg-emerald-600 hover:bg-emerald-500 text-white`}>
              {spinner("resume") ?? <Play className="w-3.5 h-3.5" />} Reprendre
            </button>
          ) : (
            <button type="button" onClick={() => void act("activate")} disabled={!!blocked.activate || !!pending} title={blocked.activate ?? undefined} className={`${BUTTON} bg-emerald-600 hover:bg-emerald-500 text-white`}>
              {spinner("activate") ?? <Power className="w-3.5 h-3.5" />} Activer
            </button>
          )}
          <button type="button" onClick={() => void act("pause")} disabled={!!blocked.pause || !!pending} title={blocked.pause ?? undefined} className={`${BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200`}>
            {spinner("pause") ?? <Pause className="w-3.5 h-3.5" />} Mettre en pause
          </button>
          <button type="button" onClick={() => void act("run")} disabled={!!blocked.run || !!pending} title={blocked.run ?? undefined} className={`${BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200`}>
            {spinner("run") ?? <Zap className="w-3.5 h-3.5" />} {pending === "run" ? "Exécution en cours…" : "Exécuter maintenant"}
          </button>
          <button type="button" onClick={() => void act("archive")} disabled={archived || !!pending} className={`${BUTTON} bg-gray-900 border border-gray-800 hover:border-red-900 text-gray-400 hover:text-red-300 sm:ml-auto`}>
            {spinner("archive") ?? <Archive className="w-3.5 h-3.5" />} Archiver
          </button>
        </div>
        {/* The reason is written, not only in a tooltip: a greyed button must explain itself on a phone too. */}
        {!archived && routine.status !== "active" && routine.status !== "paused" && blocked.activate && (
          <p className="text-xs text-gray-500"><span className="text-gray-400">Activer est grisé :</span> {blocked.activate}</p>
        )}
        {routine.status === "paused" && blocked.resume && (
          <p className="text-xs text-gray-500"><span className="text-gray-400">Reprendre est grisé :</span> {blocked.resume}</p>
        )}
        {archived && <p className="text-xs text-gray-500">Routine archivée : elle ne s&apos;exécute plus, son historique reste consultable.</p>}
        {notice && <p className={`text-xs break-words ${notice.ok ? "text-emerald-300" : "text-red-400"}`}>{notice.text}</p>}
      </Card>

      <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
        <Kpi label="Prochaine exécution" accent="violet" value={<span className="text-base">{routine.status === "active" ? dateTimeLabel(routine.nextRunAt, routine.timezone) : "—"}</span>} sub={routine.status === "active" ? undefined : "La routine n'est pas active"} />
        <Kpi label="Dernière exécution" accent="gray" value={<span className="text-base">{routine.lastRunAt ? dateTimeLabel(routine.lastRunAt, routine.timezone) : "Jamais"}</span>} sub={last && routine.lastRunAt ? last.label : undefined} />
        <Kpi label="Essai à blanc" accent="emerald" value={<span className="text-base">{routine.dryRunValid ? "Réussi" : hasDefinition(routine) ? "À faire" : "—"}</span>} sub={routine.dryRunValid ? dateTimeLabel(routine.dryRunAt, routine.timezone) : hasDefinition(routine) ? "Exigé avant l'activation" : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 items-start">
        <RoutineChat
          routineId={routine.id}
          metaAccountId={routine.metaAccountId}
          timezone={routine.timezone}
          initialInput={example?.prompt ?? null}
          readOnly={archived}
          onApplied={() => { void load(); setTab("dry_run"); }}
        />

        <Card className="min-w-0">
          <div className="px-3 py-2 border-b border-gray-800">
            <div role="tablist" aria-label="Détail de la routine" className="flex gap-1 overflow-x-auto">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${tab === t.key ? "bg-violet-600 text-white" : "text-gray-400 hover:text-gray-100 hover:bg-gray-800"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          {tab === "definition" && <DefinitionView routine={routine} />}
          {tab === "dry_run" && (
            <DryRunPanel
              // A new definition starts from a clean panel.
              key={routine.definitionHash ?? "none"}
              routine={routine}
              onDone={(raw) => { if (!accept(raw)) void load(); setHistoryKey((k) => k + 1); }}
            />
          )}
          {tab === "history" && <RunHistory routineId={routine.id} timezone={routine.timezone} refreshKey={historyKey} />}
        </Card>
      </div>
    </div>
  );
}
