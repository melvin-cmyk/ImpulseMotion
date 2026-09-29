"use client";

/**
 * Tab « Définition »: the routine as it is stored, said in French — schedule,
 * ceiling, then each step with what it reads and the texts it will write.
 * Read only: a definition changes through the conversation with the AI.
 */

import { CalendarClock, Layers } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { scheduleTitle } from "@/components/routines/schedule-label";
import { STEP_FAMILY, dateTimeLabel, describeStep, hasDefinition, stepTexts, type RoutineView } from "@/components/routines/routine-model";

export function DefinitionView({ routine }: { routine: RoutineView }) {
  if (!hasDefinition(routine)) {
    return (
      <div className="p-6 text-center">
        <Layers className="w-8 h-8 text-gray-700 mx-auto mb-3" />
        <p className="text-sm text-gray-400">Cette routine n&apos;a pas encore de définition.</p>
        <p className="text-xs text-gray-600 mt-1">Décrivez ce que vous voulez à l&apos;IA, puis appliquez sa proposition : elle apparaîtra ici.</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {routine.description && <p className="text-sm text-gray-300 leading-relaxed">{routine.description}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="bg-gray-950/50 border border-gray-800 rounded-xl px-3 py-2">
          <div className="text-[11px] text-gray-500 uppercase tracking-wide font-medium flex items-center gap-1"><CalendarClock className="w-3 h-3" />Planning</div>
          <div className="text-sm text-white mt-0.5">{scheduleTitle(routine.schedule, routine.timezone)}</div>
        </div>
        <div className="bg-gray-950/50 border border-gray-800 rounded-xl px-3 py-2">
          <div className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">Par exécution</div>
          <div className="text-sm text-white mt-0.5">{routine.maxItemsPerRun || "—"} éléments au plus</div>
        </div>
        <div className="bg-gray-950/50 border border-gray-800 rounded-xl px-3 py-2">
          <div className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">Essai à blanc</div>
          <div className={`text-sm mt-0.5 ${routine.dryRunValid ? "text-emerald-300" : "text-amber-300"}`}>
            {routine.dryRunValid ? `Réussi ${dateTimeLabel(routine.dryRunAt, routine.timezone)}` : "À faire sur cette définition"}
          </div>
        </div>
      </div>

      <ol className="space-y-2">
        {routine.steps.map((step, i) => {
          const texts = stepTexts(step);
          return (
            <li key={step.id} className="bg-gray-950/50 border border-gray-800 rounded-xl px-3 py-2.5">
              <div className="flex items-start gap-2">
                <span className="w-5 h-5 rounded-full bg-gray-800 text-gray-400 text-xs flex items-center justify-center shrink-0 tabular-nums">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Pill tone={STEP_FAMILY[step.type].tone} className="text-[10px]">{STEP_FAMILY[step.type].label}</Pill>
                    {step.label && <span className="text-sm font-medium text-white break-words">{step.label}</span>}
                    <span className="text-[10px] text-gray-600 font-mono">{step.id} · {step.type}</span>
                  </div>
                  <p className="text-xs text-gray-300 mt-1 break-words">{describeStep(step)}</p>
                  {step.input && <p className="text-[11px] text-gray-500 mt-0.5">Lit les lignes de l&apos;étape « {step.input} ».</p>}
                  {texts.length > 0 && (
                    <dl className="mt-2 space-y-1">
                      {texts.map((t) => (
                        <div key={t.label} className="grid grid-cols-1 sm:grid-cols-[9rem_1fr] gap-x-2 text-xs">
                          <dt className="text-gray-500">{t.label}</dt>
                          <dd className="text-gray-300 font-mono text-[11px] whitespace-pre-wrap break-all">{t.text}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="text-[11px] text-gray-600">
        Les motifs entre accolades sont remplacés à chaque exécution : {"{{row.colonne}}"} par la cellule de la ligne, {"{{run.date}}"} par la date, {"{{steps.id.text}}"} par le texte rédigé par l&apos;IA.
        Pour modifier la routine, demandez-le à l&apos;IA : toute modification impose un nouvel essai à blanc.
      </p>
    </div>
  );
}
