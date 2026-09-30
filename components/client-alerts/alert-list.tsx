"use client";

/**
 * The alerts of the person (or, for a real admin, of everyone): client, label,
 * status in words, last value and last trigger, and what can be done — open
 * the conversation to change the alert by asking, pause or resume, delete.
 *
 * An alert of someone else is read-only apart from what the API grants a real
 * admin: pausing it and deleting it.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, MessageSquare, Pause, Play, Trash2 } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { PlatformBadges } from "@/components/client-alerts/client-picker";
import {
  ALERT_STATUS, dayLabel, formatValue, guardsLine, replayLine, ruleSentence, settingsLine, unbreakable, type AlertEventView, type AlertView,
} from "@/components/client-alerts/alert-model";

export type AlertAction = "pause" | "resume" | "delete";

const btnBase = "inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const actionBtn = `${btnBase} bg-gray-950 hover:bg-gray-800 text-gray-300 border-gray-800`;
const openBtn = `${btnBase} bg-violet-500/10 hover:bg-violet-500/20 text-violet-200 border-violet-500/40`;
const dangerBtn = `${btnBase} bg-gray-950 hover:bg-red-950/40 text-red-300 border-red-900/60`;

function eventState(e: AlertEventView): { label: string; tone: "emerald" | "amber" | "red" | "default" } {
  if (e.notifyError) return { label: "non envoyé", tone: "red" };
  if (e.notifiedAt) return { label: "envoyé dans Slack", tone: "emerald" };
  if (e.dryRun) return { label: "mode d'essai", tone: "amber" };
  return { label: "en attente d'envoi", tone: "default" };
}

function AlertItem({ alert, open, busy, error, onOpen, onAction }: {
  alert: AlertView;
  open: boolean;
  /** Action in progress on this alert. */
  busy: AlertAction | null;
  error: string | null;
  onOpen: () => void;
  onAction: (action: AlertAction) => void;
}) {
  const [details, setDetails] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = ALERT_STATUS[alert.status];
  const def = alert.definition;
  const canResume = alert.mine && (alert.status === "paused" || alert.status === "error");
  const canPause = alert.status === "active";
  const title = alert.label || (alert.empty ? "Brouillon sans demande" : "Brouillon en cours");

  return (
    <li className={`px-4 py-3 space-y-2 ${open ? "bg-violet-500/5" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-violet-300 font-semibold break-words">{alert.clientName}</div>
          <div className={`text-sm font-medium mt-0.5 break-words ${alert.label ? "text-white" : "text-gray-400"}`}>{title}</div>
          <PlatformBadges accounts={alert.accounts} className="mt-1" />
        </div>
        <span title={status.help} className="shrink-0"><Pill tone={status.tone}>{status.label}</Pill></span>
      </div>

      {!alert.mine && alert.createdByEmail && <p className="text-[11px] text-gray-500 truncate">Créée par {alert.createdByEmail}</p>}

      {def && (
        <dl className="grid grid-cols-2 gap-2 text-[11px]">
          <div>
            <dt className="text-gray-600">Dernière valeur</dt>
            <dd className="text-gray-300 tabular-nums">
              {alert.lastCheckedAt ? `${formatValue(def.metric, alert.lastValue)} · le ${dayLabel(alert.lastCheckedAt)}` : "Pas encore vérifiée"}
            </dd>
          </div>
          <div>
            <dt className="text-gray-600">Dernier déclenchement</dt>
            <dd className="text-gray-300">{alert.lastTriggeredAt ? `le ${dayLabel(alert.lastTriggeredAt)}` : "Jamais"}</dd>
          </div>
        </dl>
      )}

      {alert.lastNote && <p className="text-[11px] text-amber-300 break-words">{alert.lastNote}</p>}

      {details && def && (
        <div className="text-xs text-gray-400 bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2 space-y-1.5">
          <p className="text-gray-200">{unbreakable(ruleSentence(def))}</p>
          <p>{settingsLine(def)}</p>
          {guardsLine(def) && <p>{guardsLine(def)}</p>}
          {alert.backtest && <p className="text-gray-500">{replayLine(alert.backtest)} (au moment de la validation).</p>}
          <div className="pt-1 border-t border-gray-800">
            <p className="text-gray-500 mb-1">Derniers déclenchements</p>
            {alert.events.length === 0 && <p className="text-gray-600">Aucun pour l&apos;instant.</p>}
            <ul className="space-y-1.5">
              {alert.events.map((e) => {
                const st = eventState(e);
                return (
                  <li key={e.id} className="space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-gray-300">{dayLabel(e.triggeredAt)}</span>
                      {e.kind === "reminder" && <Pill className="text-[10px]">rappel</Pill>}
                      <Pill tone={st.tone} className="text-[10px]">{st.label}</Pill>
                    </div>
                    <p className="text-gray-400 whitespace-pre-wrap break-words line-clamp-4">{e.message}</p>
                    {e.notifyError && <p className="text-red-400 break-words">{e.notifyError}</p>}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {error && <p role="alert" className="text-[11px] text-red-400 break-words">{error}</p>}

      {confirmDelete ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-[11px] text-amber-200">
          <span>Supprimer cette alerte et son historique ?</span>
          <button type="button" className={dangerBtn} disabled={busy !== null} onClick={() => onAction("delete")}>
            {busy === "delete" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}Oui, supprimer
          </button>
          <button type="button" className={actionBtn} disabled={busy !== null} onClick={() => setConfirmDelete(false)}>Annuler</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {alert.mine && (
            <button type="button" className={open ? openBtn : actionBtn} onClick={onOpen} title="Ouvrir la conversation pour terminer ou modifier l'alerte en le demandant">
              <MessageSquare className="w-3 h-3" />{def ? "Modifier" : "Continuer"}
            </button>
          )}
          {canPause && (
            <button type="button" className={actionBtn} disabled={busy !== null} onClick={() => onAction("pause")}>
              {busy === "pause" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pause className="w-3 h-3" />}Mettre en pause
            </button>
          )}
          {canResume && (
            <button type="button" className={actionBtn} disabled={busy !== null} onClick={() => onAction("resume")}>
              {busy === "resume" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}Reprendre
            </button>
          )}
          {def && (
            <button type="button" className={actionBtn} onClick={() => setDetails((d) => !d)} aria-expanded={details}>
              {details ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}Détail
            </button>
          )}
          <button
            type="button"
            className={`${actionBtn} ml-auto`}
            disabled={busy !== null}
            // A draft nobody wrote in holds nothing to lose: no question asked.
            onClick={() => (alert.empty ? onAction("delete") : setConfirmDelete(true))}
            aria-label={`Supprimer l'alerte ${title} de ${alert.clientName}`}
            title="Supprimer"
          >
            {busy === "delete" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
          </button>
        </div>
      )}
    </li>
  );
}

export function AlertList({ alerts, openId, busy, errors, onOpen, onAction }: {
  alerts: AlertView[];
  openId: string | null;
  /** alert id → action in progress. */
  busy: Record<string, AlertAction | undefined>;
  /** alert id → why the last action failed. */
  errors: Record<string, string | undefined>;
  onOpen: (alert: AlertView) => void;
  onAction: (alert: AlertView, action: AlertAction) => void;
}) {
  return (
    <ul className="divide-y divide-gray-800">
      {alerts.map((a) => (
        <AlertItem
          key={a.id}
          alert={a}
          open={openId === a.id}
          busy={busy[a.id] ?? null}
          error={errors[a.id] ?? null}
          onOpen={() => onOpen(a)}
          onAction={(action) => onAction(a, action)}
        />
      ))}
    </ul>
  );
}
