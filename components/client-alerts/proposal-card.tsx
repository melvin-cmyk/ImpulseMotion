"use client";

/**
 * An alert proposed by the AI, as a card the consultant can judge in a few
 * seconds: the rule as one sentence, the accounts it covers, what it would
 * have done over the last 30 days, its settings in words.
 *
 * Everything written here comes from the definition the server validated and
 * from its replay — never from the AI's prose, apart from its « explanation ».
 * « Valider » is rendered only for a proposal the server found valid; while it
 * is being checked, unverified or invalid, the card says why and offers no way
 * to validate.
 *
 * For a lot (several clients, one rule), the card shows the replay client by
 * client — and which clients cannot take the rule, and why — instead of the
 * accounts and the replay of one client.
 */

import { AlertTriangle, BellRing, CheckCircle2, History, Loader2, XCircle } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import type { AlertDefinition, Backtest } from "@/lib/client-alerts/types";
import type { LotCheck, LotClientCheck } from "@/lib/client-alerts/lot";
import {
  PLATFORM_LABEL, cardNotes, guardsLine, hindsightLine, replayLine, replayOf, ruleSentence, settingsLine, statsLine, unbreakable, type CardState,
} from "@/components/client-alerts/alert-model";

export type { CardState } from "@/components/client-alerts/alert-model";

const primaryBtn = "px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors";
const quietBtn = "px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors";

export function ProposalCard({
  state, proposal, draftLabel, backtest, warnings, errors, notice, confirmCount, confirmClients, lot, replaces, onValidate, onConfirm, onCancel, onRecheck,
}: {
  state: CardState;
  /** Validated by the server; absent while checking and when invalid. */
  proposal?: AlertDefinition | null;
  /** Label read in the block before validation, for the title only. */
  draftLabel?: string | null;
  backtest?: Backtest | null;
  warnings?: string[];
  errors?: string[];
  /** What is missing for the message to reach Slack, said by the server when the alert was recorded. */
  notice?: string | null;
  /** Messages the alert would have sent, when a confirmation is asked. */
  confirmCount?: number;
  /** A lot: the clients for which the alert would have sent that many messages. */
  confirmClients?: string[];
  /** A lot: what the rule gives on each client. */
  lot?: LotCheck | null;
  /** An alert is in service for this conversation: validating replaces it. */
  replaces?: boolean;
  onValidate: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRecheck: () => void;
}) {
  const bad = state === "invalid" || state === "failed" || state === "unverified" || state === "closed";
  const live = state === "inService";
  const replay = backtest ? replayOf(backtest) : null;
  const guards = proposal ? guardsLine(proposal) : null;
  const hindsight = proposal ? hindsightLine(proposal) : null;
  // The notes of the replay are those of one client: a lot says its clients one by one instead.
  const notes = cardNotes(warnings ?? [], lot ? [] : backtest?.notes ?? []);
  const canValidate = (state === "pending" || state === "failed") && !!proposal;
  const lotOk = lot ? lot.clients.filter((c) => c.ok).length : 0;

  return (
    <div className={`bg-gray-900 border rounded-2xl overflow-hidden ${bad ? "border-amber-800/60" : live ? "border-emerald-900/60" : "border-violet-800/50"}`}>
      <div className="px-4 py-3 border-b border-gray-800 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-violet-300 font-semibold">Proposition d&apos;alerte</div>
          <div className="text-sm font-semibold text-white mt-0.5 break-words">{proposal?.label ?? draftLabel ?? "Proposition illisible"}</div>
        </div>
        {state === "inService" && <Pill tone="emerald" className="shrink-0">En service</Pill>}
        {state === "paused" && <Pill className="shrink-0">En pause</Pill>}
        {(state === "replaced" || state === "superseded") && <Pill className="shrink-0">Remplacée</Pill>}
        {state === "invalid" && <Pill tone="amber" className="shrink-0">Refusée</Pill>}
        {state === "failed" && <Pill tone="red" className="shrink-0">Non enregistrée</Pill>}
      </div>

      {proposal && (
        <div className="px-4 py-3 space-y-3">
          <p className="text-sm text-white leading-relaxed flex items-start gap-2">
            <BellRing className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
            <span className="break-words">{unbreakable(ruleSentence(proposal, lot))}</span>
          </p>

          {lot ? (
            <p className="text-xs text-gray-400">
              Chaque client est jugé séparément, sur {lot.platforms ? `ses comptes ${lot.platforms.map((p) => PLATFORM_LABEL[p]).join(" et ")}` : "tous ses comptes"} ; le message dit quel client est en cause.
            </p>
          ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {proposal.accounts.map((a) => (
              <Pill key={`${a.platform}:${a.accountId}`} tone={a.platform === "meta" ? "blue" : "emerald"} className="text-[11px]">
                {PLATFORM_LABEL[a.platform]} · {a.name}
              </Pill>
            ))}
          </div>
          )}

          {lot && <LotReplay clients={lot.clients} />}

          {!lot && replay && backtest && (
            <div className="text-xs bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2 space-y-1">
              <div className="flex items-start gap-1.5 text-gray-200 font-semibold">
                <History className="w-3.5 h-3.5 text-violet-400 shrink-0 mt-0.5" />
                <span className="break-words">{replayLine(replay)}</span>
              </div>
              <div className="text-gray-400 sm:pl-5 tabular-nums">{unbreakable(statsLine(proposal.metric, backtest))}</div>
              {backtest.skippedDays > 0 && (
                <div className="text-gray-500 sm:pl-5">
                  {backtest.skippedDays} jour{backtest.skippedDays > 1 ? "s" : ""} non jugé{backtest.skippedDays > 1 ? "s" : ""} (trop peu de données ou chiffres illisibles).
                </div>
              )}
            </div>
          )}

          <div className="text-xs text-gray-400 space-y-0.5">
            <p>{settingsLine(proposal)}</p>
            {guards && <p>{guards}</p>}
            {hindsight && <p>{hindsight}</p>}
            <p className="text-gray-500">Message privé Slack, pour vous seul.</p>
          </div>

          {proposal.explanation && <p className="text-xs text-gray-400 leading-relaxed break-words"><span className="text-gray-500">Lecture de l&apos;IA : </span>{proposal.explanation}</p>}

          {notes.length > 0 && (
            <ul className="text-xs text-amber-200 bg-amber-950/30 border border-amber-900/50 rounded-lg px-3 py-2 space-y-1">
              {notes.map((n, i) => (
                <li key={i} className="flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span className="break-words">{n}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}

      {errors && errors.length > 0 && (
        <div className="px-4 py-3">
          <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-900/50 rounded-lg px-3 py-2">
            <div className="font-semibold mb-1">
              {state === "invalid" ? "Cette proposition ne peut pas être validée."
                : state === "unverified" ? "Cette proposition n'a pas pu être vérifiée."
                : state === "closed" ? "Cette proposition ne peut plus être validée."
                : "L'alerte n'a pas été enregistrée."}
            </div>
            <ul className="list-disc pl-4 space-y-0.5">
              {errors.map((e, i) => <li key={i} className="break-words">{e}</li>)}
            </ul>
            {state === "invalid" && <div className="text-amber-400/80 mt-1">Ces raisons seront transmises à l&apos;IA avec votre prochain message : demandez-lui de corriger.</div>}
          </div>
        </div>
      )}

      <div className="px-4 py-3 border-t border-gray-800 bg-gray-950/40 min-h-[3.25rem] flex items-center">
        {state === "checking" && (
          <div className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="w-3.5 h-3.5 animate-spin" />Vérification sur les 30 derniers jours…</div>
        )}
        {state === "unverified" && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-amber-300">
            {!errors?.length && <span>La proposition n&apos;a pas pu être vérifiée : elle ne peut pas être validée en l&apos;état.</span>}
            <button type="button" onClick={onRecheck} className={quietBtn}>Vérifier à nouveau</button>
          </div>
        )}
        {canValidate && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onValidate} className={primaryBtn}>
              {state === "failed" ? "Réessayer"
                : lot ? `${replaces ? "Remplacer" : "Valider"} pour ${lotOk} client${lotOk > 1 ? "s" : ""}`
                : replaces ? "Remplacer l'alerte en service" : "Valider cette alerte"}
            </button>
            <span className="text-[11px] text-gray-500">
              {state === "failed" ? "Rien n'a été enregistré." : "Rien n'est enregistré avant votre clic. Pour changer quelque chose, demandez-le à l'IA."}
            </span>
          </div>
        )}
        {state === "confirming" && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-amber-200">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>
              {confirmClients?.length
                ? `Pour ${confirmClients.join(", ")}, cette alerte vous aurait envoyé jusqu'à ${confirmCount ?? "beaucoup de"} messages en 30 jours. C'est beaucoup : la mettre en service quand même ?`
                : `Cette alerte vous aurait envoyé ${confirmCount ?? "beaucoup de"} messages en 30 jours. C'est beaucoup : la mettre en service quand même ?`}
            </span>
            <button type="button" onClick={onConfirm} className={primaryBtn}>Oui, {replaces ? "remplacer" : "valider"} quand même</button>
            <button type="button" onClick={onCancel} className={quietBtn}>Annuler</button>
          </div>
        )}
        {state === "applying" && (
          <div className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="w-3.5 h-3.5 animate-spin" />Dernière vérification, puis mise en service…</div>
        )}
        {state === "inService" && (
          <div className="text-xs space-y-1">
            <div className="flex items-center gap-2 text-emerald-400"><CheckCircle2 className="w-3.5 h-3.5 shrink-0" />Alerte en service. Pour la modifier, demandez-le à l&apos;IA.</div>
            {notice && <div className="text-amber-300 break-words">{notice}</div>}
          </div>
        )}
        {state === "paused" && <div className="text-xs text-gray-400">C&apos;est l&apos;alerte enregistrée ; elle est en pause. Reprenez-la depuis la liste.</div>}
        {state === "replaced" && <div className="text-xs text-gray-500">Validée, puis remplacée par une proposition plus récente.</div>}
        {state === "superseded" && <div className="text-xs text-gray-500">Remplacée par une proposition plus récente.</div>}
        {state === "invalid" && (
          <div className="flex items-center gap-2 text-xs text-amber-400"><XCircle className="w-3.5 h-3.5 shrink-0" />Aucune validation possible tant que la proposition n&apos;est pas corrigée.</div>
        )}
        {state === "closed" && (
          <div className="flex items-center gap-2 text-xs text-amber-400"><XCircle className="w-3.5 h-3.5 shrink-0" />Plus aucune validation possible pour cette alerte.</div>
        )}
      </div>
    </div>
  );
}

/** The replay of a lot, one line per client: the messages it would have sent, or why the client is left out. */
function LotReplay({ clients }: { clients: LotClientCheck[] }) {
  const out = clients.filter((c) => !c.ok);
  return (
    <div className="text-xs bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2 space-y-1">
      <div className="flex items-start gap-1.5 text-gray-200 font-semibold">
        <History className="w-3.5 h-3.5 text-violet-400 shrink-0 mt-0.5" />
        <span>Sur les 30 derniers jours, client par client :</span>
      </div>
      <ul className="sm:pl-5 space-y-0.5">
        {clients.map((c) => (
          <li key={c.alertClientId} className="flex items-start justify-between gap-3">
            <span className={`break-words ${c.ok ? "text-gray-300" : "text-amber-300"}`}>{c.clientName}</span>
            <span className={`shrink-0 text-right tabular-nums ${c.ok ? (c.noisy ? "text-amber-300" : "text-gray-400") : "text-amber-400/80"}`}>
              {c.ok ? lotMessages(c) : c.retry ? "à revérifier" : "non concerné"}
            </span>
          </li>
        ))}
      </ul>
      {out.length > 0 && (
        <ul className="sm:pl-5 pt-1 border-t border-gray-800 text-amber-300/90 space-y-0.5">
          {out.map((c) => <li key={c.alertClientId} className="break-words">{c.clientName} : {c.error ?? "non vérifiable"}</li>)}
        </ul>
      )}
    </div>
  );
}

function lotMessages(c: LotClientCheck): string {
  const n = c.messages ?? 0;
  return n === 0 ? "aucun message" : `${n} message${n > 1 ? "s" : ""}`;
}
