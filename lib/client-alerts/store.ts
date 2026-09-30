/**
 * Client alerts — the database reads and writes of one pass of the cron
 * (run.ts). The routes of the assistant do their own Prisma calls; nothing
 * here decides anything: the rules are in backtest.ts (advance) and run.ts.
 *
 * An alert is disarmed by a DELIVERED message and by nothing else:
 *   - recordCheck records what a check found and, when it is worth a message,
 *     ONE pending event — a new one, or the alert's undelivered event brought
 *     up to date. The state (armed, lastTriggeredAt) does not move;
 *   - markNotified is what moves it: the events get their notifiedAt, their
 *     alerts are disarmed and start their silence.
 * So whatever stands between a trigger and Slack — a ceiling, the general
 * anomaly, an unknown Slack identity, n8n down, a pass cut short — leaves the
 * alert as it was, and the next pass tries again while the condition is true.
 * A dry run is the exception: it advances the state at once, to mirror what a
 * real pass would have done (rearmAfterDryRun undoes it when sending starts).
 *
 * Guarantees carried by the writes:
 *   - every write of a check is conditional on the rule the pass read
 *     (definitionHash): a rule replaced during a pass is never overwritten
 *     with the state of the old one;
 *   - the write that records a message is also conditional on the
 *     lastCheckedAt the pass read: two passes at the same instant see the same
 *     alert, one of them takes the message, the other records nothing;
 *   - that write is conditional too on the state the pass evaluated from
 *     (armed, lastTriggeredAt): a pass that listed the alert before another
 *     one delivered its message records nothing after it;
 *   - an event is CLAIMED (claimEvents) before its message leaves: one pass
 *     sends it, and an event whose claim was never resolved is closed as
 *     « delivery unknown », never sent a second time;
 *   - markNotified and the holds only touch events that are not notified yet:
 *     notifiedAt is the idempotence of the delivery.
 */

import { prisma } from "@/lib/prisma";
import { todayIn } from "@/lib/date-ranges";
import { parseAccounts, type AlertAccount } from "@/lib/auto-alerts/clients";
import { randomUUID } from "node:crypto";
import { DELIVERY_UNKNOWN, MAX_DELIVERY_FAILURES, type Evaluation } from "@/lib/client-alerts/types";

const PARIS = "Europe/Paris";

/** What a pass needs of a ClientAlert. */
export interface AlertRow {
  id: string;
  createdById: string;
  createdByEmail: string | null;
  alertClientId: string | null;
  clientName: string;
  label: string;
  definitionJson: string;
  definitionHash: string;
  armed: boolean;
  lastCheckedAt: Date | null;
  lastTriggeredAt: Date | null;
  /** Last time the rule was validated (activation, change, back from a pause). */
  backtestAt: Date | null;
}

const ROW = {
  id: true, createdById: true, createdByEmail: true, alertClientId: true, clientName: true, label: true,
  definitionJson: true, definitionHash: true, armed: true, lastCheckedAt: true, lastTriggeredAt: true, backtestAt: true,
} as const;

/** Active alerts, longest without a check first (never checked at the top): a pass cut by its budget resumes with the others. */
export async function listActiveAlerts(only?: string[]): Promise<AlertRow[]> {
  return prisma.clientAlert.findMany({
    where: { status: "active", ...(only ? { id: { in: only } } : {}) },
    orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    select: ROW,
  });
}

/** The role of each of these people today; a person who no longer exists is absent. One query per pass. */
export async function creatorRoles(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  const rows = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, role: true } });
  return new Map(rows.map((r) => [r.id, r.role]));
}

/** The alerts of a person who is no longer staff stop being checked; a person decides what they become. */
export async function pauseAlerts(ids: string[], note: string): Promise<number> {
  if (!ids.length) return 0;
  const { count } = await prisma.clientAlert.updateMany({ where: { id: { in: ids }, status: "active" }, data: { status: "paused", lastNote: note } });
  return count;
}

export interface AlertClientState { name: string; gone: boolean; accounts: AlertAccount[] }

/** The client an alert was made from, as it is today; null when the row no longer exists. */
export async function alertClientState(id: string): Promise<AlertClientState | null> {
  const c = await prisma.alertClient.findUnique({ where: { id }, select: { name: true, gone: true, accountsJson: true } });
  return c ? { name: c.name, gone: c.gone, accounts: parseAccounts(c.accountsJson) } : null;
}

/** The accounts of the alert are no longer those of its client: a person decides what it becomes. */
export async function sendToReview(id: string, note: string, at: Date): Promise<void> {
  await prisma.clientAlert.updateMany({ where: { id, status: "active" }, data: { status: "review", lastNote: note, lastCheckedAt: at } });
}

export interface CheckRecord {
  at: Date;
  evaluation: Evaluation;
  /** State after the check (advance): written when no message is worth, and by a dry run. */
  armed: boolean;
  /**
   * The message this check is worth, if any. `reuse` = the alert's undelivered event, brought up to
   * date instead of adding a second one; `dryRun` events are always new, and advance the state.
   */
  event: { kind: "trigger" | "reminder"; threshold: number | null; message: string; dryRun: boolean; reuse?: string | null } | null;
}

/**
 * Writes the outcome of one check. Returns the id of the event when a message
 * is to be sent; null when there is none, when the rule was replaced since the
 * pass read it, or when another pass took the message first.
 */
export async function recordCheck(alert: Pick<AlertRow, "id" | "definitionHash" | "lastCheckedAt" | "armed" | "lastTriggeredAt">, check: CheckRecord): Promise<string | null> {
  const ev = check.evaluation;
  const found = { lastCheckedAt: check.at, lastValue: ev.value, lastNote: ev.status === "skipped" ? ev.reason ?? "Non jugée" : null };
  const same = { id: alert.id, status: "active", definitionHash: alert.definitionHash };
  const event = check.event;
  // The state the pass evaluated from: a message delivered by another pass since then moved it.
  const from = { armed: alert.armed, lastTriggeredAt: alert.lastTriggeredAt };
  if (!event) {
    // `armed` is only written over the state it was computed from; the check itself is always recorded.
    const moved = await prisma.clientAlert.updateMany({ where: { ...same, ...from }, data: { ...found, armed: check.armed } });
    if (!moved.count) await prisma.clientAlert.updateMany({ where: same, data: found });
    return null;
  }
  return prisma.$transaction(async (tx) => {
    const taken = await tx.clientAlert.updateMany({
      where: { ...same, lastCheckedAt: alert.lastCheckedAt, ...from },
      // A real message disarms when it is delivered (markNotified), not before. A dry run mirrors it at once.
      data: event.dryRun ? { ...found, armed: false, lastTriggeredAt: check.at } : found,
    });
    if (!taken.count) return null;
    const data = { kind: event.kind, triggeredAt: check.at, value: ev.value, threshold: event.threshold, detailJson: JSON.stringify(ev), message: event.message };
    if (event.reuse && !event.dryRun) {
      // Still undelivered: the same event, with today's figures. Its last reason goes: it is pending again.
      // No longer pending: another pass delivered it meanwhile. Nothing is added for the same fact.
      const kept = await tx.clientAlertEvent.updateMany({ where: { id: event.reuse, alertId: alert.id, notifiedAt: null, dryRun: false }, data: { ...data, notifyError: null } });
      return kept.count ? event.reuse : null;
    }
    const row = await tx.clientAlertEvent.create({ data: { alertId: alert.id, ...data, dryRun: event.dryRun }, select: { id: true } });
    return row.id;
  });
}

export interface PendingEvent { id: string; alertId: string; triggeredAt: Date; notifyError: string | null; batchId: string | null }

/** The latest undelivered real event of each of these alerts, triggered since `since`. One query per pass. */
export async function pendingEvents(alertIds: string[], since: Date): Promise<Map<string, PendingEvent>> {
  const out = new Map<string, PendingEvent>();
  if (!alertIds.length) return out;
  const rows = await prisma.clientAlertEvent.findMany({
    where: { alertId: { in: alertIds }, notifiedAt: null, dryRun: false, triggeredAt: { gte: since } },
    orderBy: [{ triggeredAt: "desc" }],
    select: { id: true, alertId: true, triggeredAt: true, notifyError: true, batchId: true },
  });
  for (const r of rows) if (!out.has(r.alertId)) out.set(r.alertId, r);
  return out;
}

/**
 * Sending has just been switched on (or a pass was run dry by hand): what a
 * dry run recorded was said to nobody. When the latest event of an alert is a
 * dry-run one, the alert goes back to where its last DELIVERED message left it
 * — armed, in the silence of that message if there was one. Returns the state to evaluate from, or null when nothing changes.
 * The dry-run events themselves are never sent.
 */
export async function rearmAfterDryRun(alert: Pick<AlertRow, "id" | "definitionHash">): Promise<{ lastTriggeredAt: Date | null } | null> {
  const latest = await prisma.clientAlertEvent.findFirst({ where: { alertId: alert.id }, orderBy: [{ triggeredAt: "desc" }], select: { dryRun: true } });
  if (!latest?.dryRun) return null;
  const delivered = await prisma.clientAlertEvent.findFirst({
    where: { alertId: alert.id, notifiedAt: { not: null } }, orderBy: [{ notifiedAt: "desc" }], select: { notifiedAt: true },
  });
  // A message of unknown fate counts as said: it may be in Slack.
  const unknown = await prisma.clientAlertEvent.findFirst({
    where: { alertId: alert.id, notifiedAt: null, notifyError: DELIVERY_UNKNOWN }, orderBy: [{ triggeredAt: "desc" }], select: { triggeredAt: true, batchId: true },
  });
  const said = [delivered?.notifiedAt ?? null, unknown ? claimedAt(unknown.batchId) ?? unknown.triggeredAt : null].filter((d): d is Date => !!d);
  const lastTriggeredAt = said.length ? new Date(Math.max(...said.map((d) => d.getTime()))) : null;
  // Armed or not: a dry run that went back to normal re-armed the alert but
  // left its date, and the silence of a message nobody received kept it mute.
  const { count } = await prisma.clientAlert.updateMany({
    where: { id: alert.id, status: "active", definitionHash: alert.definitionHash },
    data: { armed: true, lastTriggeredAt },
  });
  return count ? { lastTriggeredAt } : null;
}

/** Events kept out of Slack for now, with the reason the page shows. */
export async function holdEvents(eventIds: string[], reason: string): Promise<void> {
  if (!eventIds.length) return;
  await prisma.clientAlertEvent.updateMany({ where: { id: { in: eventIds }, notifiedAt: null }, data: { notifyError: reason.slice(0, 300) } });
}

/** The batch of one private message: the moment its events were claimed, then a random part. */
export const newBatchId = (at: Date): string => `${at.getTime()}-${randomUUID()}`;
/** When a batch was claimed; null for an id that does not say. */
export function claimedAt(batchId: string | null): Date | null {
  const m = /^(\d{12,})-/.exec(batchId ?? "");
  return m ? new Date(Number(m[1])) : null;
}

/**
 * Takes these events for one private message, before it leaves: an event
 * belongs to one batch at most, so two passes never send the same one.
 * Returns the events this batch holds.
 */
export async function claimEvents(eventIds: string[], batchId: string): Promise<string[]> {
  if (!eventIds.length) return [];
  await prisma.clientAlertEvent.updateMany({ where: { id: { in: eventIds }, notifiedAt: null, batchId: null }, data: { batchId } });
  const rows = await prisma.clientAlertEvent.findMany({ where: { id: { in: eventIds }, notifiedAt: null, batchId }, select: { id: true } });
  const held = new Set(rows.map((r) => r.id));
  return eventIds.filter((id) => held.has(id));
}

/** Nothing left for Slack after all (no address, a refusal): the events are free for the next pass. */
export async function releaseEvents(eventIds: string[], batchId: string): Promise<void> {
  if (!eventIds.length) return;
  await prisma.clientAlertEvent.updateMany({ where: { id: { in: eventIds }, notifiedAt: null, batchId }, data: { batchId: null } });
}

/**
 * One private message went out. Its events, claimed under this batch, get
 * their date; their alerts are disarmed and start their silence NOW — with
 * closeUnknown, the only places that do it for a real message. An alert whose
 * rule was replaced since the pass read it keeps the fresh state of its new rule.
 */
export async function markNotified(eventIds: string[], alerts: Array<Pick<AlertRow, "id" | "definitionHash">>, batchId: string, at: Date): Promise<void> {
  // One transaction: an event dated while its alert stayed armed would be said again at the next pass.
  await prisma.$transaction(async (tx) => {
    await tx.clientAlertEvent.updateMany({ where: { id: { in: eventIds }, notifiedAt: null, batchId }, data: { notifiedAt: at, notifyError: null } });
    for (const a of alerts) {
      await tx.clientAlert.updateMany({ where: { id: a.id, definitionHash: a.definitionHash }, data: { armed: false, lastTriggeredAt: at, consecutiveFailures: 0 } });
    }
  });
}

/**
 * Nobody knows whether the message of these events arrived. They keep their
 * claim and are closed with DELIVERY_UNKNOWN; their alerts are disarmed and
 * start their silence at `at`, as after a delivered message: saying it twice
 * is worse than saying it late, and the page shows what happened.
 */
export async function closeUnknown(eventIds: string[], alerts: Array<Pick<AlertRow, "id" | "definitionHash">>, at: Date): Promise<void> {
  if (!eventIds.length) return;
  await prisma.$transaction(async (tx) => {
    await tx.clientAlertEvent.updateMany({ where: { id: { in: eventIds }, notifiedAt: null }, data: { notifyError: DELIVERY_UNKNOWN } });
    for (const a of alerts) {
      await tx.clientAlert.updateMany({ where: { id: a.id, definitionHash: a.definitionHash }, data: { armed: false, lastTriggeredAt: at, consecutiveFailures: 0 } });
    }
  });
}

/**
 * A private message could not be delivered. Its events keep the reason and
 * stay pending: nothing was disarmed, the next pass tries again while the
 * condition is true. One failure is counted per alert and per pass; at
 * MAX_DELIVERY_FAILURES in a row an alert is switched to `error`.
 * Returns the alerts switched off.
 */
export async function recordDeliveryFailure(eventIds: string[], alertIds: string[], error: string): Promise<string[]> {
  const text = error.replace(/\s+/g, " ").slice(0, 300);
  await prisma.clientAlertEvent.updateMany({ where: { id: { in: eventIds }, notifiedAt: null }, data: { notifyError: text } });
  const stopped: string[] = [];
  for (const id of [...new Set(alertIds)]) {
    const row = await prisma.clientAlert.update({ where: { id }, data: { consecutiveFailures: { increment: 1 } }, select: { consecutiveFailures: true } });
    if (row.consecutiveFailures < MAX_DELIVERY_FAILURES) continue;
    const { count } = await prisma.clientAlert.updateMany({
      where: { id, status: "active" },
      data: { status: "error", lastNote: `Message privé Slack non remis ${MAX_DELIVERY_FAILURES} fois de suite (${text}) : alerte arrêtée. Reprenez-la une fois l'envoi rétabli.` },
    });
    if (count) stopped.push(id);
  }
  return stopped;
}

/** Private messages this consultant already received today (Paris day), those of unknown fate included: one batch = one message. */
export async function dmBatchesToday(userId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 36 * 3_600_000);
  const select = { id: true, batchId: true, notifiedAt: true, triggeredAt: true } as const;
  const delivered = await prisma.clientAlertEvent.findMany({ where: { notifiedAt: { gte: since }, alert: { createdById: userId } }, select });
  const unknown = await prisma.clientAlertEvent.findMany({ where: { notifiedAt: null, notifyError: DELIVERY_UNKNOWN, triggeredAt: { gte: since }, alert: { createdById: userId } }, select });
  const today = todayIn(PARIS, now);
  const said = [...delivered.map((r) => ({ ...r, at: r.notifiedAt })), ...unknown.map((r) => ({ ...r, at: claimedAt(r.batchId) ?? r.triggeredAt }))];
  return new Set(said.filter((r) => r.at && todayIn(PARIS, r.at) === today).map((r) => r.batchId ?? r.id)).size;
}
