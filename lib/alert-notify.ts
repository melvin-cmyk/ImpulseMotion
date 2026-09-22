/**
 * Alert notifications for consultants — Slack channel and/or email, delivered
 * by an n8n workflow (Webhook → Slack / Gmail) so the app keeps no messaging
 * credentials. One POST per event; n8n answers 2xx once posted.
 *
 * Destinations live on the rule (AlertRule.notifyJson). An event is sent at
 * most once (AlertEvent.notifiedAt), so a replayed cron never spams a channel.
 * Without N8N_ALERT_WEBHOOK_URL the whole thing is a no-op: alerts stay
 * in-app, exactly as before.
 */

import { prisma } from "@/lib/prisma";

export interface AlertNotify {
  /** "#alertes-lpev" or a channel id "C0…". */
  slackChannel?: string;
  emails?: string[];
}

export const MAX_NOTIFY_EMAILS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLACK_RE = /^(#[a-z0-9][a-z0-9._-]{0,79}|[CG][A-Z0-9]{8,})$/;

/** Validates a client-provided notify object; returns an error message or the clean value. */
export function validateNotify(input: unknown): { ok: true; value: AlertNotify } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== "object") return { ok: false, error: "notify doit être un objet" };
  const o = input as Record<string, unknown>;
  const out: AlertNotify = {};
  if (o.slackChannel !== undefined && o.slackChannel !== null && String(o.slackChannel).trim() !== "") {
    const ch = String(o.slackChannel).trim();
    if (!SLACK_RE.test(ch)) return { ok: false, error: "canal Slack invalide (ex. #alertes-client ou C0123ABCD)" };
    out.slackChannel = ch;
  }
  if (o.emails !== undefined && o.emails !== null) {
    const raw = Array.isArray(o.emails) ? o.emails : String(o.emails).split(/[,;\s]+/);
    const emails = [...new Set(raw.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
    if (emails.length > MAX_NOTIFY_EMAILS) return { ok: false, error: `au plus ${MAX_NOTIFY_EMAILS} adresses e-mail` };
    const bad = emails.find((e) => !EMAIL_RE.test(e));
    if (bad) return { ok: false, error: `adresse e-mail invalide : ${bad}` };
    if (emails.length) out.emails = emails;
  }
  return { ok: true, value: out };
}

export function parseNotify(json: string | null | undefined): AlertNotify {
  if (!json) return {};
  try {
    const v = validateNotify(JSON.parse(json));
    return v.ok ? v.value : {};
  } catch {
    return {};
  }
}

export const hasNotifyTargets = (n: AlertNotify): boolean => !!n.slackChannel || !!(n.emails && n.emails.length);

export interface NotifiableEvent {
  id: string;
  triggeredAt: Date;
  metric: string;
  value: number;
  threshold: number;
  message: string;
  clientId: string;
  entityLevel?: string | null;
  entityName?: string | null;
  rule: { id: string; condition: string; window: string; platform: string; notifyJson: string; label?: string | null; mode?: string; user: { email: string | null; name: string | null } };
}

export function alertWebhookConfig(): { url: string; secret: string } | null {
  const url = process.env.N8N_ALERT_WEBHOOK_URL?.trim();
  if (!url) return null;
  return { url, secret: process.env.N8N_ALERT_WEBHOOK_SECRET?.trim() ?? "" };
}

/** The JSON n8n receives — stable contract (version 1). */
export function buildAlertPayload(e: NotifiableEvent, notify: AlertNotify, accountLabel: string | null, appUrl: string) {
  return {
    version: 1,
    event: {
      id: e.id,
      triggeredAt: e.triggeredAt.toISOString(),
      metric: e.metric,
      condition: e.rule.condition,
      threshold: e.threshold,
      value: e.value,
      window: e.rule.window,
      message: e.message,
      accountId: e.clientId,
      accountLabel: accountLabel ?? e.clientId,
      platform: e.rule.platform,
      entityLevel: e.entityLevel ?? null,
      entityName: e.entityName ?? null,
    },
    rule: { id: e.rule.id, ownerEmail: e.rule.user.email, ownerName: e.rule.user.name, label: e.rule.label ?? null, mode: e.rule.mode ?? "rule" },
    notify: { slackChannel: notify.slackChannel ?? null, emails: notify.emails ?? [] },
    links: { alerts: `${appUrl}/admin/alerts`, event: `${appUrl}/admin/alerts?event=${e.id}` },
  };
}

/**
 * Sends every not-yet-notified event whose rule has a destination. Never
 * throws: failures are stored on the event (notifyError) and returned.
 */
export async function notifyAlertEvents(eventIds: string[]): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  if (!eventIds.length) return out;
  const cfg = alertWebhookConfig();
  if (!cfg) { out.skipped = eventIds.length; return out; }

  const events = await prisma.alertEvent.findMany({
    where: { id: { in: eventIds }, notifiedAt: null },
    include: { rule: { include: { user: { select: { email: true, name: true } } } } },
  });
  const accountIds = [...new Set(events.map((e) => e.clientId))];
  const labels = accountIds.length
    ? await prisma.userAdAccount.findMany({ where: { accountId: { in: accountIds } }, select: { accountId: true, label: true } })
    : [];
  const labelOf = new Map(labels.filter((l) => l.label).map((l) => [l.accountId, l.label as string]));
  const appUrl = (process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "https://app.impulse-analytics.com").replace(/\/$/, "");

  for (const e of events) {
    const notify = parseNotify(e.rule.notifyJson);
    if (!hasNotifyTargets(notify)) { out.skipped++; continue; }
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cfg.secret ? { "X-Alert-Secret": cfg.secret } : {}) },
        body: JSON.stringify(buildAlertPayload(e, notify, labelOf.get(e.clientId) ?? null, appUrl)),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`n8n ${res.status}`);
      await prisma.alertEvent.update({ where: { id: e.id }, data: { notifiedAt: new Date(), notifyError: null } });
      out.sent++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.alertEvent.update({ where: { id: e.id }, data: { notifyError: msg.slice(0, 300) } }).catch(() => undefined);
      out.failed++;
    }
  }
  return out;
}
