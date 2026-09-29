"use client";

/**
 * One run, step by step: status, rows in and out, warnings, error, the text
 * an AI wrote, and what was written or would be. Shared by the dry run panel
 * and the history.
 */

import { Pill } from "@/components/ui/surface";
import { STEP_WRITES, type StepResult } from "@/lib/routines/types";
import { STEP_FAMILY, TARGET_LABEL, durationLabel, runCounters } from "@/components/routines/routine-model";

const STEP_STATUS: Record<StepResult["status"], { label: string; tone: "emerald" | "default" | "red" }> = {
  ok: { label: "OK", tone: "emerald" },
  skipped: { label: "Non exécutée", tone: "default" },
  failed: { label: "Échec", tone: "red" },
};

function Preview({ preview }: { preview: Record<string, string | number | boolean | null> }) {
  const entries = Object.entries(preview).filter(([, v]) => v !== null && v !== "");
  if (!entries.length) return null;
  return (
    <dl className="mt-1 space-y-0.5">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-1 sm:grid-cols-[9rem_1fr] gap-x-2 text-[11px]">
          <dt className="text-gray-500 break-words">{k}</dt>
          <dd className="text-gray-300 whitespace-pre-wrap break-all">{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RunSteps({ steps, dryRun }: { steps: StepResult[]; dryRun: boolean }) {
  if (!steps.length) return <p className="text-xs text-gray-500">Aucune étape n&apos;a été exécutée.</p>;
  return (
    <ol className="space-y-2">
      {steps.map((s, i) => {
        const st = STEP_STATUS[s.status];
        return (
          <li key={`${s.stepId}-${i}`} className={`bg-gray-950/50 border rounded-xl px-3 py-2.5 ${s.status === "failed" ? "border-red-900/50" : "border-gray-800"}`}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-gray-800 text-gray-400 text-xs flex items-center justify-center shrink-0 tabular-nums">{i + 1}</span>
              <Pill tone={STEP_FAMILY[s.type].tone} className="text-[10px]">{STEP_FAMILY[s.type].label}</Pill>
              <span className="text-xs text-gray-300 font-mono">{s.stepId}</span>
              <Pill tone={st.tone} className="text-[10px]">{st.label}</Pill>
              <span className="text-[11px] text-gray-600 ml-auto tabular-nums">
                {s.rowsIn} ligne{s.rowsIn > 1 ? "s" : ""} lue{s.rowsIn > 1 ? "s" : ""} · {s.rowsOut} en sortie · {durationLabel(s.durationMs)}
              </span>
            </div>

            {STEP_WRITES[s.type] !== "none" && s.status !== "skipped" && (
              <p className="text-[11px] text-gray-400 mt-1.5 tabular-nums">
                {runCounters({ counts: s.counts, trigger: dryRun ? "dry_run" : "manual", steps: [s] }).map((c) => c.text).join(" · ")}
              </p>
            )}
            {s.timedOut && <p className="text-xs text-amber-300 mt-1">Arrêtée faute de temps : ce qui reste est traité à l&apos;exécution suivante.</p>}
            {s.error && (
              <p className="text-xs text-red-300 mt-1.5 break-words">
                {s.error.class === "infra"
                  ? "Panne technique (ne compte pas comme un échec de la routine) : "
                  : s.error.scope === "items"
                    ? "Lignes en échec (chacune est retentée, 3 tentatives au plus ; la routine ne s'arrête pas pour cela) : "
                    : "Erreur : "}{s.error.message}
              </p>
            )}
            {s.warnings.map((w, k) => <p key={k} className="text-xs text-amber-300 mt-1 break-words">{w}</p>)}

            {typeof s.output.text === "string" && s.output.text && (
              <div className="mt-2">
                <div className="text-[11px] text-gray-500">Texte rédigé par l&apos;IA</div>
                <p className="text-xs text-gray-300 whitespace-pre-wrap break-words bg-gray-900 border border-gray-800 rounded-lg px-2.5 py-1.5 mt-0.5">{s.output.text}</p>
              </div>
            )}

            {s.planned.length > 0 && (
              <div className="mt-2">
                <div className="text-[11px] text-gray-500">{dryRun ? "Serait écrit" : "Prévu"} — {s.planned.length} élément{s.planned.length > 1 ? "s" : ""}</div>
                <ul className="mt-1 space-y-1.5">
                  {s.planned.map((p, k) => (
                    <li key={k} className="bg-gray-900 border border-gray-800 rounded-lg px-2.5 py-1.5">
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <Pill tone={p.target === "meta" ? "red" : "amber"} className="text-[10px]">{TARGET_LABEL[p.target]}</Pill>
                        <span className="text-gray-200 break-words">{p.summary}</span>
                        {p.itemKey && <span className="text-[10px] text-gray-600 font-mono break-all">{p.itemKey}</span>}
                      </div>
                      <Preview preview={p.preview} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {s.written.length > 0 && (
              <div className="mt-2">
                <div className="text-[11px] text-gray-500">Écrit — {s.written.length} élément{s.written.length > 1 ? "s" : ""}</div>
                <ul className="mt-1 space-y-1">
                  {s.written.map((w, k) => (
                    <li key={k} className="text-xs text-gray-300 break-words">
                      {w.summary}
                      {w.externalId && <span className="text-[10px] text-gray-500 font-mono ml-1.5">id {w.externalId}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
