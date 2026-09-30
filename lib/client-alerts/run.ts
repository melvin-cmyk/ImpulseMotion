/**
 * Client alerts — one pass of the cron.
 *
 * Two phases, like the automatic alerts (lib/auto-alerts/run.ts): every alert
 * that is due is evaluated and its state written first; what reaches Slack is
 * decided afterwards, once the whole pass is known.
 *
 * What the pass guarantees, so that Slack is never filled:
 *   - a message only when `advance` says so (silence, re-arming, reminders);
 *   - a dry run (asked for, or CLIENT_ALERTS_SEND not on) records the events
 *     and advances the state exactly as a real pass, and sends nothing (the
 *     general anomaly is noted on its events too; the ceilings are not
 *     simulated, they count messages really delivered);
 *   - the same break on most alerts at once is an outage, not that many
 *     problems: nothing is sent (FLOOD);
 *   - one private message per consultant and per pass, a ceiling per
 *     consultant and per day, a ceiling per pass;
 *   - an event that was not sent is never sent later: it stays on the page
 *     with the reason. An alert from yesterday is noise.
 *
 * An alert whose accounts left its client goes to `review` instead of being
 * evaluated. One alert that fails does not stop the others.
 */

import { randomUUID } from "node:crypto";
import { todayIn } from "@/lib/date-ranges";
import { readClientSeries } from "@/lib/client-alerts/series";
import { evaluate, PLATFORM_LABEL, sameAccount } from "@/lib/client-alerts/evaluate";
import { advance, checkedOn } from "@/lib/client-alerts/backtest";
import { buildAlertLine, buildDmText } from "@/lib/client-alerts/message";
import { dmConfigured, resolveSlackIdentity, sendSlackDm } from "@/lib/client-alerts/slack-dm";
import {
  alertClientState, dmBatchesToday, holdEvents, listActiveAlerts, markNotified, recordCheck, recordDeliveryFailure, sendToReview, unsentEvents,
  type AlertClientState, type AlertRow,
} from "@/lib/client-alerts/store";
import {
  ALERT_DEFAULTS, CHECK_SLOTS_UTC, MAX_DM_PER_RUN, MAX_DM_PER_USER_PER_DAY, readDefinition, sendingEnabled,
  type AlertAccountRef, type AlertChecks, type AlertDefinition, type ClientSeries, type RunSummary,
} from "@/lib/client-alerts/types";

const PARIS = "Europe/Paris";
const CONCURRENCY = 4;
/** Under the 300 s of the function: what is not reached waits for the next pass. */
export const RUN_BUDGET_MS = 270_000;
/**
 * From this many alerts triggering in one pass, when they are at least this
 * share of the alerts evaluated, nothing is sent: a platform that reports
 * late or answers zeros, not that many real problems.
 */
export const FLOOD = { minAlerts: 5, share: 0.5 } as const;
/** Alerts written out in one private message; the others are one line « N autres alertes ». */
export const MAX_LINES_PER_DM = 6;

export const HELD = {
  flood: "anomalie générale : non envoyé",
  identity: "adresse Slack introuvable",
  daily: `plafond de ${MAX_DM_PER_USER_PER_DAY} messages privés par jour atteint : non envoyé`,
  run: `plafond de ${MAX_DM_PER_RUN} messages privés par passage atteint : non envoyé`,
  notConfigured: "envoi des messages privés Slack non configuré : non envoyé",
} as const;

const SLOTS_OF: Record<AlertChecks, number[]> = { "1x": [0], "2x": [0, 2], "4x": [0, 1, 2, 3] };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);

/** Slot of a firing: the index of its UTC hour among CHECK_SLOTS_UTC; null at any other hour. */
export function slotOf(now: Date): number | null {
  const i = (CHECK_SLOTS_UTC as readonly number[]).indexOf(now.getUTCHours());
  return i === -1 ? null : i;
}

/**
 * Is this alert checked at this pass? `slot` null = a manual pass: every
 * alert, whatever its frequency. Weekend = Saturday and Sunday in Paris.
 * An alert that missed a slot of its own earlier today (budget of the pass
 * used up, alert activated since) is taken at the next pass, whatever the slot.
 */
export function isDue(def: Pick<AlertDefinition, "checks" | "weekdaysOnly">, lastCheckedAt: Date | null, slot: number | null, now: Date): boolean {
  if (!checkedOn(def, todayIn(PARIS, now))) return false;
  if (slot === null) return true;
  const slots = SLOTS_OF[def.checks] ?? SLOTS_OF[ALERT_DEFAULTS.checks];
  if (slots.includes(slot)) return true;
  const day = now.toISOString().slice(0, 10);
  return slots.some((s) => s < slot && (!lastCheckedAt || lastCheckedAt.getTime() < Date.parse(`${day}T${String(CHECK_SLOTS_UTC[s]).padStart(2, "0")}:00:00Z`)));
}

/** Pure: why an alert can no longer be evaluated as it is, or null. */
export function clientProblem(accounts: AlertAccountRef[], clientName: string, client: AlertClientState | null): string | null {
  if (!client) return `Le client « ${clientName} » n'existe plus : alerte à revoir.`;
  if (client.gone) return `Le client « ${client.name} » n'a plus aucun compte lisible : alerte à revoir.`;
  const left = accounts.filter((a) => !client.accounts.some((c) => sameAccount(c, a)));
  if (!left.length) return null;
  const names = left.map((a) => `${PLATFORM_LABEL[a.platform]} « ${a.name} »`).join(", ");
  return left.length > 1
    ? `Les comptes ${names} ne font plus partie du client « ${client.name} » : alerte à revoir.`
    : `Le compte ${names} ne fait plus partie du client « ${client.name} » : alerte à revoir.`;
}

interface Pending { order: number; eventId: string; alertId: string; userId: string; who: string; line: string }

/** One pass of the cron: checks the active alerts that are due, records the triggers, sends the private messages. */
export async function runClientAlerts(opts: { now?: Date; slot?: number | null; dryRun?: boolean; only?: string[] } = {}): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const deadlineAt = Date.now() + RUN_BUDGET_MS;
  const slot = opts.slot === undefined ? slotOf(now) : opts.slot;
  const dryRun = opts.dryRun === true || !sendingEnabled();
  const summary: RunSummary = { slot, checked: 0, triggered: 0, skipped: 0, sent: 0, dryRun, held: 0, errors: [] };

  const due = (await listActiveAlerts(opts.only)).flatMap((row) => {
    const def = readDefinition(row.definitionJson);
    return def && isDue(def, row.lastCheckedAt, slot, now) ? [{ row, def }] : [];
  });

  // One read per account and per pass, shared by the alerts that look at it.
  const reads = new Map<string, Promise<ClientSeries>>();
  const seriesOf = async (accounts: AlertAccountRef[]): Promise<ClientSeries> => {
    const parts = await Promise.all(accounts.map((a) => {
      const key = `${a.platform}:${a.accountId}`;
      let read = reads.get(key);
      if (!read) reads.set(key, (read = readClientSeries([a], { now, fresh: true })));
      return read;
    }));
    return { readAt: parts[0].readAt, until: parts[0].until, accounts: parts.map((p, i) => ({ ...p.accounts[0], account: accounts[i] })) };
  };

  const pending: Pending[] = [];

  const one = async (row: AlertRow, def: AlertDefinition, order: number): Promise<void> => {
    if (row.alertClientId) {
      const problem = clientProblem(def.accounts, row.clientName, await alertClientState(row.alertClientId));
      if (problem) { await sendToReview(row.id, problem, now); return; }
    }
    const evaluation = evaluate(def, await seriesOf(def.accounts), { live: true });
    const step = advance({ armed: row.armed, lastMessageAt: row.lastTriggeredAt }, evaluation.status, now, def);
    const line = step.message ? buildAlertLine({ clientName: row.clientName, def, evaluation, kind: step.message }) : null;
    const eventId = await recordCheck(row, {
      at: now, evaluation, armed: step.state.armed,
      event: step.message && line !== null ? { kind: step.message, threshold: def.threshold ?? null, message: line, dryRun } : null,
    });
    summary.checked++;
    if (evaluation.status === "skipped") summary.skipped++;
    if (eventId && line !== null) {
      summary.triggered++;
      pending.push({ order, eventId, alertId: row.id, userId: row.createdById, who: row.createdByEmail ?? row.createdById, line });
    }
  };

  let next = 0;
  let unreached = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, due.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= due.length) return;
      if (Date.now() >= deadlineAt) { unreached++; continue; }
      const { row, def } = due[i];
      try {
        await one(row, def, i);
      } catch (e) {
        summary.errors.push(`${row.clientName} — ${row.label || row.id} : ${errText(e)}`);
      }
    }
  });
  await Promise.all(workers);
  if (unreached) summary.errors.push(`Temps du passage écoulé : ${unreached} alerte${unreached > 1 ? "s" : ""} non vérifiée${unreached > 1 ? "s" : ""}, reprise${unreached > 1 ? "s" : ""} au passage suivant.`);

  // ── What reaches Slack ─────────────────────────────────────────────────────
  if (!pending.length) return summary;
  pending.sort((a, b) => a.order - b.order);
  const hold = async (events: Pending[], reason: string) => {
    summary.held += events.length;
    await holdEvents(events.map((p) => p.eventId), reason).catch((e) => { summary.errors.push(`Événements non annotés : ${errText(e)}`); });
  };

  // Said in a dry run too: it is what the measure before switching the sending on must show.
  if (pending.length >= FLOOD.minAlerts && pending.length >= summary.checked * FLOOD.share) {
    summary.errors.push(`Anomalie générale suspectée : ${pending.length} alertes déclenchées sur ${summary.checked} vérifiées — rien n'a été envoyé dans Slack, à vérifier côté plateformes.`);
    await hold(pending, HELD.flood);
    return summary;
  }
  if (dryRun) return summary;
  if (!dmConfigured()) {
    summary.errors.push("Messages privés Slack non configurés : rien n'a été envoyé.");
    await hold(pending, HELD.notConfigured);
    return summary;
  }

  const byUser = new Map<string, Pending[]>();
  for (const p of pending) byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), p]);
  const pageUrl = process.env.NEXTAUTH_URL ? `${process.env.NEXTAUTH_URL.replace(/\/$/, "")}/admin/alerts/assistant` : null;

  for (const [userId, all] of byUser) {
    const who = all[0].who;
    try {
      if (summary.sent >= MAX_DM_PER_RUN) { await hold(all, HELD.run); continue; }
      if ((await dmBatchesToday(userId, now)) >= MAX_DM_PER_USER_PER_DAY) { await hold(all, HELD.daily); continue; }
      // notifiedAt is the idempotence: what another pass delivered meanwhile is not said twice.
      const left = new Set(await unsentEvents(all.map((p) => p.eventId)));
      const events = all.filter((p) => left.has(p.eventId));
      if (!events.length) continue;
      const eventIds = events.map((p) => p.eventId);
      const alertIds = [...new Set(events.map((p) => p.alertId))];
      try {
        const identity = await resolveSlackIdentity(userId);
        if (identity.status !== "found" || !identity.slackUserId) { await hold(events, HELD.identity); continue; }
        const lines = events.slice(0, MAX_LINES_PER_DM).map((p) => p.line);
        await sendSlackDm(identity.slackUserId, buildDmText(lines, events.length - lines.length, pageUrl));
      } catch (e) {
        summary.errors.push(`Message privé à ${who} non remis : ${errText(e)}`);
        const stopped = await recordDeliveryFailure(eventIds, alertIds, errText(e));
        if (stopped.length) summary.errors.push(`${stopped.length} alerte${stopped.length > 1 ? "s" : ""} de ${who} arrêtée${stopped.length > 1 ? "s" : ""} après plusieurs échecs d'envoi.`);
        continue;
      }
      summary.sent++;
      await markNotified(eventIds, alertIds, randomUUID(), now);
    } catch (e) {
      summary.errors.push(`Envoi à ${who} : ${errText(e)}`);
    }
  }
  return summary;
}
