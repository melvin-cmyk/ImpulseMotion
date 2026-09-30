/**
 * Client alerts — one pass of the cron.
 *
 * Two phases, like the automatic alerts (lib/auto-alerts/run.ts): every alert
 * that is due is evaluated first; what reaches Slack is decided afterwards,
 * once the whole pass is known.
 *
 * An alert is disarmed by a DELIVERED message only. A trigger leaves ONE
 * pending event on the alert — a new one, or its undelivered event brought up
 * to date — and the state does not move until the private message is out
 * (markNotified). Whatever stands in between behaves the same way: a ceiling,
 * the general anomaly, a person Slack does not know, sending not plugged, a
 * send that fails, a pass cut short or killed between the two phases. At the
 * next pass, if the condition is still true the same event is tried again; if
 * the situation is back to normal the event stays on the page as not sent,
 * with the reason, and nothing is sent late. An alert that has such an event
 * is due at EVERY pass, whatever its own frequency, until then.
 *
 * The one exception is a message nobody knows the fate of. An event is claimed
 * before its message leaves; when the delivery service answers too late or not
 * clearly, or when the pass dies between the send and its record, the message
 * may be in Slack: the event is closed as such and its alert starts its
 * silence as if it had been delivered. It is never sent a second time.
 *
 * What the pass guarantees, so that Slack is never filled:
 *   - a message only when `advance` says so (silence, re-arming, reminders);
 *   - never more than one undelivered event per alert, and one pass at most
 *     sending it: an alert whose event another pass is sending is left alone;
 *   - a dry run (asked for, or CLIENT_ALERTS_SEND not on) records its events
 *     and advances the state as a real pass that delivered would, and sends
 *     nothing; at the first real pass, an alert a dry run had disarmed is
 *     re-armed before being evaluated, and no dry-run event is ever sent;
 *   - the same break on most CLIENTS at once is an outage, not that many
 *     problems: nothing is sent (FLOOD);
 *   - one private message per consultant and per pass, a ceiling per
 *     consultant and per day, a ceiling per pass.
 *
 * An alert whose accounts left its client goes to `review`, the alerts of a
 * person who is no longer staff go to `paused`, instead of being evaluated.
 * One alert that fails does not stop the others.
 */

import { todayIn } from "@/lib/date-ranges";
import { readClientSeries } from "@/lib/client-alerts/series";
import { evaluate, PLATFORM_LABEL, sameAccount } from "@/lib/client-alerts/evaluate";
import { advance, checkedOn, cooldownMs } from "@/lib/client-alerts/backtest";
import { buildAlertLine, buildDmText } from "@/lib/client-alerts/message";
import { dmConfigured, resolveSlackIdentity, sendSlackDm, SlackDmError } from "@/lib/client-alerts/slack-dm";
import {
  alertClientState, claimEvents, claimedAt, closeUnknown, creatorRoles, dmBatchesToday, holdEvents, listActiveAlerts, markNotified, newBatchId, pauseAlerts,
  pendingEvents, rearmAfterDryRun, recordCheck, recordDeliveryFailure, releaseEvents, sendToReview,
  type AlertClientState, type AlertRow, type PendingEvent,
} from "@/lib/client-alerts/store";
import {
  ALERT_DEFAULTS, BACK_TO_NORMAL, CHECK_SLOTS_UTC, COOLDOWN_MAX_HOURS, DELIVERY_UNKNOWN, MAX_DM_PER_RUN, MAX_DM_PER_USER_PER_DAY, readDefinition, sendingEnabled,
  type AlertAccountRef, type AlertChecks, type AlertDefinition, type ClientSeries, type RunSummary,
} from "@/lib/client-alerts/types";

const PARIS = "Europe/Paris";
const CONCURRENCY = 4;
/** Time given to the evaluations, under the 300 s of the function: what is not reached waits for the next pass. */
export const RUN_BUDGET_MS = 200_000;
/** From the start of the pass: no private message is started after it. What is left stays pending for the next pass. */
export const SEND_DEADLINE_MS = 270_000;
/**
 * From this many CLIENTS triggering in one pass, when they are at least this
 * share of the clients checked, nothing is sent: a platform that reports late
 * or answers zeros, not that many real problems. Clients, not alerts: five
 * alerts of one client that breaks are one problem, to be said.
 */
export const FLOOD = { minClients: 5, share: 0.5 } as const;
/**
 * A claim younger than this belongs to a pass that may still be sending (a function lives 300 s):
 * its alert is left alone. Older, the pass is gone without saying what became of the message.
 */
export const CLAIM_GRACE_MS = 10 * 60_000;
/** Alerts written out in one private message; the others are one line « N autres alertes ». */
export const MAX_LINES_PER_DM = 6;

export const HELD = {
  flood: "anomalie générale : non envoyé",
  identity: "adresse Slack introuvable",
  daily: `plafond de ${MAX_DM_PER_USER_PER_DAY} messages privés par jour atteint : non envoyé`,
  run: `plafond de ${MAX_DM_PER_RUN} messages privés par passage atteint : non envoyé`,
  notConfigured: "envoi des messages privés Slack non configuré : non envoyé",
  /** Closes a pending event: it is kept on the page, and is no longer what makes its alert due at every pass. */
  normal: BACK_TO_NORMAL,
} as const;

const STAFF_ROLES = new Set(["admin", "consultant"]);
export const CREATOR_GONE = "La personne qui a créé cette alerte n'a plus de compte dans l'application : alerte mise en pause.";
export const CREATOR_NOT_STAFF = "La personne qui a créé cette alerte ne fait plus partie de l'équipe : alerte mise en pause.";

const SLOTS_OF: Record<AlertChecks, number[]> = { "1x": [0], "2x": [0, 2], "4x": [0, 1, 2, 3] };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
/** For the cron's answer: the technical cause when slack-dm.ts gives one. */
const causeText = (e: unknown) => (e instanceof SlackDmError ? e.detail : errText(e));
/** For the page: the words of slack-dm.ts, never the raw text of another error (a database message, a stack). */
const failureWords = (e: unknown) => (e instanceof SlackDmError ? e.message : "l'envoi a échoué avant d'atteindre Slack");

/** Slot of a firing: the index of its UTC hour among CHECK_SLOTS_UTC; null at any other hour. */
export function slotOf(now: Date): number | null {
  const i = (CHECK_SLOTS_UTC as readonly number[]).indexOf(now.getUTCHours());
  return i === -1 ? null : i;
}

/**
 * Is this alert checked at this pass? `slot` null = a manual pass: every
 * alert, whatever its frequency. Never on a Saturday or a Sunday (Paris) for
 * working days only. An alert that missed a slot of its own earlier today
 * (budget of the pass used up, alert activated since) is taken at the next
 * pass, whatever the slot — and so is, at every pass, an alert with a message
 * still to deliver (`pending`).
 */
export function isDue(def: Pick<AlertDefinition, "checks" | "weekdaysOnly">, lastCheckedAt: Date | null, slot: number | null, now: Date, pending = false): boolean {
  if (!checkedOn(def, todayIn(PARIS, now))) return false;
  if (slot === null || pending) return true;
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

interface Pending {
  order: number; eventId: string; alertId: string; definitionHash: string; userId: string; who: string; line: string;
  /** The client the alert is about: what the general anomaly counts. */
  client: string;
}

const plural = (n: number) => (n > 1 ? "s" : "");

/** One pass of the cron: checks the active alerts that are due, records the triggers, sends the private messages. */
export async function runClientAlerts(opts: { now?: Date; slot?: number | null; dryRun?: boolean; only?: string[] } = {}): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const startedAt = Date.now();
  const slot = opts.slot === undefined ? slotOf(now) : opts.slot;
  const dryRun = opts.dryRun === true || !sendingEnabled();
  const summary: RunSummary = { slot, checked: 0, triggered: 0, skipped: 0, sent: 0, dryRun, held: 0, failed: 0, errors: [] };

  const rows = await listActiveAlerts(opts.only);

  // The creator must still be staff: one read of the roles per pass.
  const roles = await creatorRoles(rows.map((r) => r.createdById));
  const orphans = rows.filter((r) => !STAFF_ROLES.has(roles.get(r.createdById) ?? ""));
  if (orphans.length) {
    const gone = orphans.filter((r) => !roles.has(r.createdById)).map((r) => r.id);
    const notStaff = orphans.filter((r) => roles.has(r.createdById)).map((r) => r.id);
    const paused = (await pauseAlerts(gone, CREATOR_GONE)) + (await pauseAlerts(notStaff, CREATOR_NOT_STAFF));
    if (paused) summary.errors.push(`${paused} alerte${plural(paused)} mise${plural(paused)} en pause : créée${plural(paused)} par une personne qui ne fait plus partie de l'équipe.`);
  }
  const orphan = new Set(orphans.map((r) => r.id));
  const live = rows.flatMap((row) => {
    const def = orphan.has(row.id) ? null : readDefinition(row.definitionJson);
    return def ? [{ row, def }] : [];
  });

  // The undelivered event of an alert, young enough to be its message still: reused rather than doubled.
  // A dry run has no pending event: each of its events is final.
  const undelivered = dryRun
    ? new Map<string, PendingEvent>()
    : await pendingEvents(live.map(({ row }) => row.id), new Date(now.getTime() - COOLDOWN_MAX_HOURS * 3_600_000));

  // Events claimed for a message and never resolved. A young claim is another pass at work: its
  // alert is not touched. An old one is a message of unknown fate: closed, its alert in silence.
  const busy = new Set<string>();
  for (const { row } of live) {
    const event = undelivered.get(row.id);
    if (!event) continue;
    if (event.notifyError === DELIVERY_UNKNOWN) { undelivered.delete(row.id); continue; }
    if (!event.batchId) continue;
    const since = claimedAt(event.batchId) ?? event.triggeredAt;
    if (now.getTime() - since.getTime() < CLAIM_GRACE_MS) { busy.add(row.id); continue; }
    // A rule validated since (changed, or back from a pause) has its own fresh state: only the event is closed.
    const validatedSince = !!row.backtestAt && row.backtestAt.getTime() > since.getTime();
    await closeUnknown([event.id], validatedSince ? [] : [row], since);
    if (!validatedSince) { row.armed = false; row.lastTriggeredAt = since; }
    undelivered.delete(row.id);
    summary.errors.push(`${row.clientName} — ${row.label || row.id} : un message privé a été lancé sans que son issue soit connue ; il n'est pas renvoyé.`);
  }

  const reusable = (row: AlertRow, def: AlertDefinition): PendingEvent | null => {
    const event = undelivered.get(row.id);
    return event && now.getTime() - event.triggeredAt.getTime() < cooldownMs(def) ? event : null;
  };
  /** Still to deliver: not closed by a return to normal. */
  const open = (event: PendingEvent | null) => !!event && event.notifyError !== HELD.normal;

  const due = live.filter(({ row, def }) => !busy.has(row.id) && isDue(def, row.lastCheckedAt, slot, now, open(reusable(row, def))));

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
  const clientsChecked = new Set<string>();

  const one = async (row: AlertRow, def: AlertDefinition, order: number): Promise<void> => {
    if (row.alertClientId) {
      const problem = clientProblem(def.accounts, row.clientName, await alertClientState(row.alertClientId));
      if (problem) { await sendToReview(row.id, problem, now); return; }
    }
    let state = { armed: row.armed, lastMessageAt: row.lastTriggeredAt };
    // Sending is on: what a dry run recorded was never said to anybody — neither
    // its disarming nor the silence that follows a message count.
    if (!dryRun && (!row.armed || row.lastTriggeredAt)) {
      const back = await rearmAfterDryRun(row);
      if (back) state = { armed: true, lastMessageAt: back.lastTriggeredAt };
    }
    const evaluation = evaluate(def, await seriesOf(def.accounts));
    const step = advance(state, evaluation.status, now, def);
    const line = step.message ? buildAlertLine({ clientName: row.clientName, def, evaluation, kind: step.message }) : null;
    const waiting = reusable(row, def);
    // The state evaluated from is the condition of the write: see recordCheck.
    const eventId = await recordCheck({ ...row, armed: state.armed, lastTriggeredAt: state.lastMessageAt }, {
      at: now, evaluation, armed: step.state.armed,
      event: step.message && line !== null ? { kind: step.message, threshold: def.threshold ?? null, message: line, dryRun, reuse: waiting?.id ?? null } : null,
    });
    const client = row.alertClientId ?? `nom:${row.clientName}`;
    summary.checked++;
    clientsChecked.add(client);
    if (evaluation.status === "skipped") summary.skipped++;
    if (eventId && line !== null) {
      summary.triggered++;
      pending.push({ order, eventId, alertId: row.id, definitionHash: row.definitionHash, userId: row.createdById, who: row.createdByEmail ?? row.createdById, line, client });
    } else if (evaluation.status === "ok" && waiting && open(waiting)) {
      // Back to normal before the message could leave: it stays on the page, said as such, and is never sent late.
      await holdEvents([waiting.id], HELD.normal);
    }
  };

  const evaluateUntil = startedAt + RUN_BUDGET_MS;
  let next = 0;
  let unreached = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, due.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= due.length) return;
      if (Date.now() >= evaluateUntil) { unreached++; continue; }
      const { row, def } = due[i];
      try {
        await one(row, def, i);
      } catch (e) {
        summary.errors.push(`${row.clientName} — ${row.label || row.id} : ${errText(e)}`);
      }
    }
  });
  await Promise.all(workers);
  if (unreached) summary.errors.push(`Temps du passage écoulé : ${unreached} alerte${plural(unreached)} non vérifiée${plural(unreached)}, reprise${plural(unreached)} au passage suivant.`);

  // ── What reaches Slack ─────────────────────────────────────────────────────
  if (!pending.length) return summary;
  pending.sort((a, b) => a.order - b.order);
  const hold = async (events: Pending[], reason: string) => {
    summary.held += events.length;
    await holdEvents(events.map((p) => p.eventId), reason).catch((e) => { summary.errors.push(`Événements non annotés : ${errText(e)}`); });
  };

  // Said in a dry run too: it is what the measure before switching the sending on must show.
  const clientsTriggered = new Set(pending.map((p) => p.client));
  if (clientsTriggered.size >= FLOOD.minClients && clientsTriggered.size >= clientsChecked.size * FLOOD.share) {
    const said = `Anomalie générale suspectée : ${clientsTriggered.size} clients déclenchés sur ${clientsChecked.size} vérifiés (${pending.length} alertes) — rien n'a été envoyé dans Slack, à vérifier côté plateformes.`;
    console.warn(`[client-alerts] ${said}`);
    summary.errors.push(said);
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
  const sendUntil = startedAt + SEND_DEADLINE_MS;
  let late = 0;
  /** Messages that left, or may have left: what the ceiling of the pass counts. */
  let attempted = 0;

  for (const [userId, all] of byUser) {
    const who = all[0].who;
    // The function is about to be cut: a message started now could be sent and never recorded.
    if (Date.now() >= sendUntil) { late += all.length; continue; }
    try {
      if (attempted >= MAX_DM_PER_RUN) { await hold(all, HELD.run); continue; }
      if ((await dmBatchesToday(userId, now)) >= MAX_DM_PER_USER_PER_DAY) { await hold(all, HELD.daily); continue; }
      // Who to write to, before anything is claimed: a search that fails sent nothing, whatever its own fate.
      let slackUserId: string | null;
      try {
        const identity = await resolveSlackIdentity(userId);
        slackUserId = identity.status === "found" ? identity.slackUserId : null;
      } catch (e) {
        summary.failed += all.length;
        summary.errors.push(`Message privé à ${who} non remis : ${causeText(e)} — nouvel essai au prochain passage.`);
        const stopped = await recordDeliveryFailure(all.map((p) => p.eventId), all.map((p) => p.alertId), failureWords(e));
        if (stopped.length) summary.errors.push(`${stopped.length} alerte${plural(stopped.length)} de ${who} arrêtée${plural(stopped.length)} après plusieurs échecs d'envoi.`);
        continue;
      }
      if (!slackUserId) { await hold(all, HELD.identity); continue; }
      // The claim is the idempotence: what another pass delivered, or is sending, is not said twice.
      const batchId = newBatchId(now);
      const held = new Set(await claimEvents(all.map((p) => p.eventId), batchId));
      const events = all.filter((p) => held.has(p.eventId));
      if (!events.length) continue;
      const eventIds = events.map((p) => p.eventId);
      const alertsOf = events.map((p) => ({ id: p.alertId, definitionHash: p.definitionHash }));
      attempted++;
      try {
        const lines = events.slice(0, MAX_LINES_PER_DM).map((p) => p.line);
        await sendSlackDm(slackUserId, buildDmText(lines, events.length - lines.length, pageUrl));
      } catch (e) {
        summary.failed += events.length;
        if (e instanceof SlackDmError && e.uncertain) {
          // The message may be in Slack: it is not sent again, and its alerts start their silence.
          summary.errors.push(`Message privé à ${who} : issue inconnue (${causeText(e)}) — il est peut-être arrivé, il n'est pas renvoyé.`);
          await closeUnknown(eventIds, alertsOf, now);
          continue;
        }
        // Nothing left: nothing was disarmed, the events are free again and tried at the next pass.
        attempted--;
        summary.errors.push(`Message privé à ${who} non remis : ${causeText(e)} — nouvel essai au prochain passage.`);
        await releaseEvents(eventIds, batchId);
        const stopped = await recordDeliveryFailure(eventIds, events.map((p) => p.alertId), failureWords(e));
        if (stopped.length) summary.errors.push(`${stopped.length} alerte${plural(stopped.length)} de ${who} arrêtée${plural(stopped.length)} après plusieurs échecs d'envoi.`);
        continue;
      }
      summary.sent++;
      // The message is out: this, and only this, disarms its alerts. Should the write fail, the
      // events keep their claim: the next pass closes them as « delivery unknown », and does not send again.
      try {
        await markNotified(eventIds, alertsOf, batchId, now);
      } catch (e) {
        summary.errors.push(`Message privé à ${who} envoyé, mais son enregistrement a échoué (${errText(e)}) : il ne sera pas renvoyé.`);
      }
    } catch (e) {
      summary.errors.push(`Envoi à ${who} : ${errText(e)}`);
    }
  }
  if (late) summary.errors.push(`Temps du passage écoulé : ${late} message${plural(late)} non envoyé${plural(late)}, repris au passage suivant.`);
  return summary;
}
