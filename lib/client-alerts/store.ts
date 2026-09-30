/**
 * Client alerts — the database reads and writes of one pass of the cron
 * (run.ts). The routes of the assistant do their own Prisma calls; nothing
 * here decides anything: the rules are in backtest.ts (advance) and run.ts.
 *
 * Two writes carry a guarantee:
 *   - recordCheck takes a message with one conditional update on the state it
 *     read (armed, lastTriggeredAt): two passes at the same instant see the
 *     same state, one of them records the event, the other records nothing;
 *   - markNotified only touches events that are not notified yet: notifiedAt
 *     is the idempotence of the delivery.
 */

import { prisma } from "@/lib/prisma";
import { todayIn } from "@/lib/date-ranges";
import { parseAccounts, type AlertAccount } from "@/lib/auto-alerts/clients";
import { MAX_DELIVERY_FAILURES, type Evaluation } from "@/lib/client-alerts/types";

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
  armed: boolean;
  lastCheckedAt: Date | null;
  lastTriggeredAt: Date | null;
}

const ROW = {
  id: true, createdById: true, createdByEmail: true, alertClientId: true, clientName: true, label: true,
  definitionJson: true, armed: true, lastCheckedAt: true, lastTriggeredAt: true,
} as const;

/** Active alerts, longest without a check first (never checked at the top): a pass cut by its budget resumes with the others. */
export async function listActiveAlerts(only?: string[]): Promise<AlertRow[]> {
  return prisma.clientAlert.findMany({
    where: { status: "active", ...(only ? { id: { in: only } } : {}) },
    orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    select: ROW,
  });
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
  /** State after the check (advance). */
  armed: boolean;
  /** The message this check is worth, if any. */
  event: { kind: "trigger" | "reminder"; threshold: number | null; message: string; dryRun: boolean } | null;
}

/**
 * Writes the outcome of one check. Returns the id of the event when a message
 * was recorded; null when there is none, or when another pass took it first.
 */
export async function recordCheck(alert: Pick<AlertRow, "id" | "armed" | "lastTriggeredAt">, check: CheckRecord): Promise<string | null> {
  const ev = check.evaluation;
  const data = { lastCheckedAt: check.at, lastValue: ev.value, lastNote: ev.status === "skipped" ? ev.reason ?? "Non jugée" : null, armed: check.armed };
  const event = check.event;
  if (!event) {
    await prisma.clientAlert.updateMany({ where: { id: alert.id, status: "active" }, data });
    return null;
  }
  return prisma.$transaction(async (tx) => {
    const taken = await tx.clientAlert.updateMany({
      where: { id: alert.id, status: "active", armed: alert.armed, lastTriggeredAt: alert.lastTriggeredAt },
      data: { ...data, lastTriggeredAt: check.at },
    });
    if (!taken.count) return null;
    const row = await tx.clientAlertEvent.create({
      data: {
        alertId: alert.id, kind: event.kind, triggeredAt: check.at, value: ev.value, threshold: event.threshold,
        detailJson: JSON.stringify(ev), message: event.message, dryRun: event.dryRun,
      },
      select: { id: true },
    });
    return row.id;
  });
}

/** Events kept out of Slack, with the reason the page shows. */
export async function holdEvents(eventIds: string[], reason: string): Promise<void> {
  if (!eventIds.length) return;
  await prisma.clientAlertEvent.updateMany({ where: { id: { in: eventIds }, notifiedAt: null }, data: { notifyError: reason.slice(0, 300) } });
}

/** Among these events, those still to deliver. */
export async function unsentEvents(eventIds: string[]): Promise<string[]> {
  if (!eventIds.length) return [];
  const rows = await prisma.clientAlertEvent.findMany({ where: { id: { in: eventIds }, notifiedAt: null }, select: { id: true } });
  const left = new Set(rows.map((r) => r.id));
  return eventIds.filter((id) => left.has(id));
}

/** One private message went out: its events share a batch, their alerts start again from zero failure. */
export async function markNotified(eventIds: string[], alertIds: string[], batchId: string, at: Date): Promise<void> {
  await prisma.clientAlertEvent.updateMany({ where: { id: { in: eventIds }, notifiedAt: null }, data: { notifiedAt: at, batchId, notifyError: null } });
  await prisma.clientAlert.updateMany({ where: { id: { in: alertIds } }, data: { consecutiveFailures: 0 } });
}

/**
 * A private message could not be delivered. Its events keep the error and are
 * not sent again; at MAX_DELIVERY_FAILURES in a row an alert is switched to
 * `error`. Returns the alerts switched off.
 */
export async function recordDeliveryFailure(eventIds: string[], alertIds: string[], error: string): Promise<string[]> {
  const text = error.replace(/\s+/g, " ").slice(0, 300);
  await prisma.clientAlertEvent.updateMany({ where: { id: { in: eventIds }, notifiedAt: null }, data: { notifyError: text } });
  const stopped: string[] = [];
  for (const id of alertIds) {
    const row = await prisma.clientAlert.update({ where: { id }, data: { consecutiveFailures: { increment: 1 } }, select: { consecutiveFailures: true } });
    if (row.consecutiveFailures < MAX_DELIVERY_FAILURES) continue;
    const { count } = await prisma.clientAlert.updateMany({
      where: { id, status: "active" },
      data: { status: "error", lastNote: `Message privé Slack non remis ${MAX_DELIVERY_FAILURES} fois de suite (${text}) : alerte arrêtée, à réactiver une fois l'envoi rétabli.` },
    });
    if (count) stopped.push(id);
  }
  return stopped;
}

/** Private messages this consultant already received today (Paris day): one batch = one message. */
export async function dmBatchesToday(userId: string, now: Date): Promise<number> {
  const rows = await prisma.clientAlertEvent.findMany({
    where: { notifiedAt: { gte: new Date(now.getTime() - 36 * 3_600_000) }, alert: { createdById: userId } },
    select: { id: true, batchId: true, notifiedAt: true },
  });
  const today = todayIn(PARIS, now);
  return new Set(rows.filter((r) => r.notifiedAt && todayIn(PARIS, r.notifiedAt) === today).map((r) => r.batchId ?? r.id)).size;
}
