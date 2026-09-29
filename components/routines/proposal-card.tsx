"use client";

/**
 * A routine proposed by the AI, as a card the consultant can read: what it
 * does, when, step by step, what is assumed, what it will write.
 *
 * « Appliquer » is rendered only where canApplyProposal says so (a proposal
 * the server has validated). Being checked, unverified or invalid, the card
 * shows why and offers no way to apply.
 */

import { AlertTriangle, CalendarClock, CheckCircle2, HelpCircle, Loader2, XCircle } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { DEFAULT_MAX_ITEMS_PER_RUN, type PreflightIssue, type RoutineProposal } from "@/lib/routines/types";
import { scheduleTitle } from "@/components/routines/schedule-label";
import { STEP_FAMILY, canApplyProposal, describeStep, stepsWritePlatform, type ProposalState } from "@/components/routines/routine-model";

export function ProposalCard({
  state, proposal, draftName, errors, issues, notices, metaAccountId, timezone, onApply, onRefuse, onRecheck,
}: {
  /** What the proposal changes of what the routine has already done (the ad set has changed: rows created again). */
  notices?: string[];
  state: ProposalState;
  /** Validated by the server; absent while checking and when invalid. */
  proposal?: RoutineProposal | null;
  /** Name read in the block before validation, for the title only. */
  draftName?: string | null;
  errors?: string[];
  /** Controls of the server when the proposal was applied. */
  issues?: PreflightIssue[];
  metaAccountId: string | null;
  timezone?: string | null;
  onApply: () => void;
  onRefuse: () => void;
  onRecheck: () => void;
}) {
  const bad = state === "invalid" || state === "failed" || state === "unverified";
  const createsAds = proposal ? stepsWritePlatform(proposal.definition.steps) : false;
  const warnings = (issues ?? []).filter((i) => i.severity === "warning");
  const blocking = (issues ?? []).filter((i) => i.severity === "error");

  return (
    <div className={`bg-gray-900 border rounded-2xl overflow-hidden ${bad ? "border-amber-800/60" : state === "applied" ? "border-emerald-900/60" : "border-violet-800/50"}`}>
      <div className="px-4 py-3 border-b border-gray-800 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-violet-300 font-semibold">Proposition de routine</div>
          <div className="text-sm font-semibold text-white mt-0.5 break-words">{proposal?.name ?? draftName ?? "Proposition illisible"}</div>
        </div>
        {state === "applied" && <Pill tone="emerald">Appliquée</Pill>}
        {state === "refused" && <Pill>Refusée</Pill>}
        {state === "invalid" && <Pill tone="amber">Invalide</Pill>}
        {state === "failed" && <Pill tone="red">Non appliquée</Pill>}
      </div>

      {proposal && (
        <div className="px-4 py-3 space-y-3">
          {proposal.explanation && <p className="text-sm text-gray-300 leading-relaxed">{proposal.explanation}</p>}

          {createsAds && (
            <div className="flex items-start gap-2 text-xs text-amber-200 bg-amber-950/30 border border-amber-900/50 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Cette routine crée des publicités Meta <strong>en pause</strong> sur le compte {metaAccountId ?? "de la routine"}.
                Rien n&apos;est diffusé tant que vous ne les activez pas vous-même dans Meta.
              </span>
            </div>
          )}

          {(notices ?? []).map((notice, i) => (
            <div key={i} role="alert" className="flex items-start gap-2 text-xs text-amber-200 bg-amber-950/40 border border-amber-700/60 rounded-lg px-3 py-2 font-semibold">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="break-words">{notice}</span>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
            <span className="inline-flex items-center gap-1.5"><CalendarClock className="w-3.5 h-3.5 text-violet-400" />{scheduleTitle(proposal.schedule, timezone)}</span>
            <span>{proposal.maxItemsPerRun ?? DEFAULT_MAX_ITEMS_PER_RUN} éléments au plus par exécution</span>
          </div>

          <ol className="space-y-1.5">
            {proposal.definition.steps.map((step, i) => (
              <li key={step.id} className="flex items-start gap-2 text-xs">
                <span className="w-5 h-5 rounded-full bg-gray-800 text-gray-400 flex items-center justify-center shrink-0 tabular-nums">{i + 1}</span>
                <div className="min-w-0">
                  <Pill tone={STEP_FAMILY[step.type].tone} className="mr-1.5 text-[10px]">{STEP_FAMILY[step.type].label}</Pill>
                  <span className="text-gray-300 break-words">{step.label ? `${step.label} — ` : ""}{describeStep(step)}</span>
                </div>
              </li>
            ))}
          </ol>

          {proposal.assumptions.length > 0 && (
            <div className="text-xs bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2">
              <div className="flex items-center gap-1.5 text-gray-300 font-semibold mb-1"><HelpCircle className="w-3.5 h-3.5 text-blue-400" />Hypothèses de l&apos;IA, à vérifier</div>
              <ul className="list-disc pl-4 space-y-0.5 text-gray-400">
                {proposal.assumptions.map((a, i) => <li key={i} className="break-words">{a}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {(errors?.length || blocking.length || warnings.length) ? (
        <div className="px-4 pb-3 space-y-2">
          {(errors?.length || blocking.length) ? (
            <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-900/50 rounded-lg px-3 py-2">
              <div className="font-semibold mb-1">
                {state === "invalid" ? "Proposition invalide : elle ne peut pas être appliquée." : "Le serveur a refusé cette proposition."}
              </div>
              <ul className="list-disc pl-4 space-y-0.5">
                {(errors ?? []).map((e, i) => <li key={`e${i}`} className="break-words">{e}</li>)}
                {blocking.map((e, i) => <li key={`b${i}`} className="break-words">{e.stepId ? `${e.stepId} : ` : ""}{e.message}</li>)}
              </ul>
              <div className="text-amber-400/80 mt-1">Ces erreurs seront transmises à l&apos;IA avec votre prochain message : demandez-lui de corriger.</div>
            </div>
          ) : null}
          {warnings.length > 0 && (
            <div className="text-xs text-gray-300 bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2">
              <div className="font-semibold mb-1">Avertissements du serveur</div>
              <ul className="list-disc pl-4 space-y-0.5 text-gray-400">
                {warnings.map((w, i) => <li key={i} className="break-words">{w.stepId ? `${w.stepId} : ` : ""}{w.message}</li>)}
              </ul>
            </div>
          )}
        </div>
      ) : null}

      <div className="px-4 py-3 border-t border-gray-800 bg-gray-950/40">
        {state === "checking" && (
          <div className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="w-3.5 h-3.5 animate-spin" />Vérification de la proposition…</div>
        )}
        {state === "unverified" && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-amber-300">
            <span>La proposition n&apos;a pas pu être vérifiée : elle ne peut pas être appliquée en l&apos;état.</span>
            <button type="button" onClick={onRecheck} className="px-2.5 py-1 rounded-lg font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200">Vérifier à nouveau</button>
          </div>
        )}
        {canApplyProposal(state, proposal) && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onApply} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white">
              {state === "failed" ? "Réessayer l'application" : "Appliquer la proposition"}
            </button>
            <button type="button" onClick={onRefuse} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-300">
              Refuser
            </button>
            <span className="text-[11px] text-gray-500">
              {state === "failed" ? "Rien n'a été enregistré." : "Rien n'est exécuté : l'essai à blanc vient ensuite."}
            </span>
          </div>
        )}
        {state === "applying" && (
          <div className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="w-3.5 h-3.5 animate-spin" />Contrôles du serveur (Sheet, campagne, ensemble de publicités)…</div>
        )}
        {state === "applied" && (
          <div className="flex items-center gap-2 text-xs text-emerald-400"><CheckCircle2 className="w-3.5 h-3.5" />Définition enregistrée. Lancez l&apos;essai à blanc avant d&apos;activer.</div>
        )}
        {state === "refused" && <div className="text-xs text-gray-500">Proposition refusée.</div>}
        {state === "invalid" && (
          <div className="flex items-center gap-2 text-xs text-amber-400"><XCircle className="w-3.5 h-3.5" />Aucune application possible tant que la proposition n&apos;est pas corrigée.</div>
        )}
      </div>
    </div>
  );
}
