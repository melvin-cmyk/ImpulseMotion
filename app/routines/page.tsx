"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CalendarClock, Loader2, Megaphone, MessageSquare, Plus, Repeat, Table2 } from "lucide-react";
import { Card, PageHeader, Pill } from "@/components/ui/surface";
import { scheduleTitle } from "@/components/routines/schedule-label";
import { ROUTINE_EXAMPLES, ROUTINE_STATUS, RUN_STATUS, dateTimeLabel, hasDefinition, toRoutineView, type RoutineView } from "@/components/routines/routine-model";
import { ACL_CHANGED_EVENT } from "@/lib/acl-version";

const EXAMPLE_ICON: Record<string, React.ElementType> = { creas: Megaphone, slack: MessageSquare, suivi: Table2 };

function NewButton() {
  return (
    <Link
      href="/routines/new"
      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold shrink-0"
    >
      <Plus className="w-4 h-4" /> Nouvelle routine
    </Link>
  );
}

export default function RoutinesPage() {
  const [routines, setRoutines] = useState<RoutineView[] | null>(null);
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/routines${archived ? "?archived=1" : ""}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);
      setRoutines((Array.isArray(body.routines) ? body.routines : []).map(toRoutineView).filter((r: RoutineView | null): r is RoutineView => !!r));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    }
  }, [archived]);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  // Accounts given or withdrawn by an admin change the list without signing in again.
  useEffect(() => {
    const onChange = () => { void load(); };
    window.addEventListener(ACL_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(ACL_CHANGED_EVENT, onChange);
  }, [load]);

  const empty = routines !== null && routines.length === 0 && !archived;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col gap-3 sm:block">
        <PageHeader
          title="Routines"
          subtitle="Des tâches répétitives confiées à l'application : lire un Google Sheet ou les plateformes, puis écrire, prévenir ou créer des publicités en pause, au rythme que vous fixez."
          action={<span className="hidden sm:inline-flex"><NewButton /></span>}
        />
        <span className="sm:hidden"><NewButton /></span>
      </div>

      {error && (
        <Card padded className="border-red-900/40">
          <p className="text-sm text-red-400">Les routines n&apos;ont pas pu être chargées ({error}).</p>
          <button type="button" onClick={() => void load()} className="mt-2 text-xs underline text-gray-300">Réessayer</button>
        </Card>
      )}

      {routines === null && !error && (
        <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement…</div>
      )}

      {empty && (
        <Card padded className="py-8">
          <div className="max-w-2xl mx-auto text-center">
            <Repeat className="w-8 h-8 text-violet-400 mx-auto mb-3" />
            <h2 className="text-base font-semibold text-white">Aucune routine pour l&apos;instant</h2>
            <p className="text-sm text-gray-400 mt-2 leading-relaxed">
              Une routine est une suite d&apos;étapes fixes que l&apos;application exécute pour vous, à heure dite : elle lit des données,
              les trie, puis agit. Vous la décrivez en français à une IA, qui la construit avec vous. Rien ne part sans un essai à blanc
              que vous avez relu.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 mt-6">
            {ROUTINE_EXAMPLES.map((ex) => {
              const Icon = EXAMPLE_ICON[ex.key] ?? Repeat;
              return (
                <Link key={ex.key} href={`/routines/new?exemple=${ex.key}`} className="block">
                  <Card padded interactive className="h-full bg-gray-950/50">
                    <Icon className="w-5 h-5 text-violet-400" />
                    <h3 className="text-sm font-semibold text-white mt-2">{ex.title}</h3>
                    <p className="text-xs text-gray-400 mt-1 leading-relaxed">{ex.text}</p>
                    <span className="text-xs text-violet-300 mt-3 inline-block">Partir de cet exemple →</span>
                  </Card>
                </Link>
              );
            })}
          </div>
        </Card>
      )}

      {routines !== null && !empty && (
        <>
          <label className="flex items-center gap-2 text-xs text-gray-400 w-fit">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} className="accent-violet-600" />
            Afficher les routines archivées
          </label>

          {routines.length === 0 ? (
            <Card padded className="text-center py-10">
              <p className="text-sm text-gray-400">Aucune routine, archivée ou non.</p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {routines.map((r) => {
                const st = ROUTINE_STATUS[r.status] ?? { label: r.status, tone: "default" as const };
                const last = r.lastRunStatus ? RUN_STATUS[r.lastRunStatus] ?? { label: r.lastRunStatus, tone: "default" as const } : null;
                return (
                  <Link key={r.id} href={`/routines/${r.id}`} className="block">
                    <Card padded interactive className="h-full">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[11px] uppercase tracking-wider text-violet-300 font-semibold truncate">{r.clientName}</div>
                          <h3 className="text-sm font-semibold text-white mt-0.5 break-words">{r.name}</h3>
                        </div>
                        <Pill tone={st.tone} className="shrink-0">{st.label}</Pill>
                      </div>

                      <div className="text-xs text-gray-400 mt-2 flex items-center gap-1.5">
                        <CalendarClock className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                        {hasDefinition(r) ? scheduleTitle(r.schedule, r.timezone) : "Pas encore de définition"}
                      </div>

                      {r.writesPlatform && (
                        <div className="text-[11px] text-amber-300 mt-2 flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          Crée des publicités Meta en pause sur le compte {r.metaAccountId ?? "—"}
                        </div>
                      )}

                      <dl className="grid grid-cols-2 gap-2 mt-3 text-[11px]">
                        <div>
                          <dt className="text-gray-600">Prochaine exécution</dt>
                          <dd className="text-gray-300">{r.status === "active" ? dateTimeLabel(r.nextRunAt, r.timezone) : "—"}</dd>
                        </div>
                        <div>
                          <dt className="text-gray-600">Dernière exécution</dt>
                          <dd className="text-gray-300 flex flex-wrap items-center gap-1.5">
                            {r.lastRunAt ? dateTimeLabel(r.lastRunAt, r.timezone) : "Jamais"}
                            {last && r.lastRunAt && <Pill tone={last.tone} className="text-[10px]">{last.label}</Pill>}
                          </dd>
                        </div>
                      </dl>
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
