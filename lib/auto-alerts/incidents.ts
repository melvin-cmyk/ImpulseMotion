/**
 * Automatic alerting — incident memory.
 *
 * A finding is a fact observed at one run; an incident is the same problem
 * followed over time. The channel only hears about CHANGES:
 *   - a problem that appears            → sent once
 *   - a warning that becomes critical   → sent once more
 *   - a critical problem still open     → one reminder after 3 days, then silence
 *   - a problem that went away          → one "résolu" line (if it had been sent)
 * A problem seen again at the next run is only touched in base, never re-sent,
 * and it takes two clean runs in a row to close it (no flapping).
 */

import { prisma } from "@/lib/prisma";
import type { Finding, Scope, Severity } from "@/lib/auto-alerts/detect";

export const REMIND_AFTER_MS = 72 * 3600 * 1000;
export const MAX_REMINDERS = 1;
export const MISSES_TO_RESOLVE = 2;

export interface IncidentState {
  id: string;
  key: string;
  scope: string;
  kind: string;
  severity: string;
  status: string; // open | resolved
  title: string;
  detail: string;
  missCount: number;
  remindCount: number;
  notifiedAt: Date | null;
  lastNotifiedAt: Date | null;
}

export type Reason = "new" | "escalated" | "reminder";

export interface Plan {
  /** To create (or reopen) and announce. */
  announce: Array<{ finding: Finding; reason: Reason; incidentId: string | null }>;
  /** Still there, nothing to say. */
  touch: Array<{ incidentId: string; finding: Finding }>;
  /** Not seen this run but not closed yet. */
  miss: string[];
  /** Closed at this run; `say` = it had been announced, so the channel is told. */
  resolve: Array<{ incident: IncidentState; say: boolean }>;
}

const rank = (s: string) => (s === "critical" ? 2 : 1);

/** Pure: what to do with this run's findings given what is already known. */
export function planIncidents(existing: IncidentState[], findings: Finding[], evaluated: ReadonlySet<Scope>, now: Date = new Date()): Plan {
  const plan: Plan = { announce: [], touch: [], miss: [], resolve: [] };
  const byKey = new Map(existing.map((i) => [i.key, i]));
  const seen = new Set<string>();

  for (const f of findings) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    const inc = byKey.get(f.key);
    if (!inc || inc.status !== "open") {
      plan.announce.push({ finding: f, reason: "new", incidentId: inc?.id ?? null });
      continue;
    }
    if (rank(f.severity) > rank(inc.severity) && inc.notifiedAt) {
      plan.announce.push({ finding: f, reason: "escalated", incidentId: inc.id });
      continue;
    }
    if (!inc.notifiedAt) {
      // Known but never delivered (no channel yet, webhook down): try again.
      plan.announce.push({ finding: f, reason: "new", incidentId: inc.id });
      continue;
    }
    const last = inc.lastNotifiedAt ?? inc.notifiedAt;
    if (f.severity === "critical" && inc.remindCount < MAX_REMINDERS && now.getTime() - last.getTime() >= REMIND_AFTER_MS) {
      plan.announce.push({ finding: f, reason: "reminder", incidentId: inc.id });
      continue;
    }
    plan.touch.push({ incidentId: inc.id, finding: f });
  }

  for (const inc of existing) {
    if (inc.status !== "open" || seen.has(inc.key)) continue;
    // A scope that could not be read this run says nothing about its incidents.
    if (!evaluated.has(inc.scope as Scope)) continue;
    if (inc.missCount + 1 >= MISSES_TO_RESOLVE) plan.resolve.push({ incident: inc, say: !!inc.notifiedAt });
    else plan.miss.push(inc.id);
  }
  return plan;
}

export interface AppliedPlan {
  /** Incident ids behind each announced finding, same order as plan.announce. */
  announcedIds: string[];
}

/** Writes the plan. Delivery is recorded apart (markNotified) once Slack answered. */
export async function applyPlan(dashboardId: string, plan: Plan, now: Date = new Date()): Promise<AppliedPlan> {
  const announcedIds: string[] = [];
  for (const a of plan.announce) {
    const f = a.finding;
    const data = {
      scope: f.scope, platform: f.platform, kind: f.kind, severity: f.severity as Severity, title: f.title, detail: f.detail,
      entityLevel: f.entity?.level ?? null, entityId: f.entity?.id ?? null, entityName: f.entity?.name ?? null,
      lastSeenAt: now, missCount: 0,
    };
    const row = await prisma.autoIncident.upsert({
      where: { dashboardId_key: { dashboardId, key: f.key } },
      create: { dashboardId, key: f.key, status: "open", firstSeenAt: now, ...data },
      update: a.reason === "new" && a.incidentId
        // Reopened (or never delivered): a fresh incident as far as the channel is concerned.
        ? { status: "open", resolvedAt: null, remindCount: 0, ...data }
        : data,
    });
    announcedIds.push(row.id);
  }
  for (const t of plan.touch) {
    await prisma.autoIncident.update({
      where: { id: t.incidentId },
      data: { lastSeenAt: now, missCount: 0, detail: t.finding.detail, severity: t.finding.severity },
    });
  }
  if (plan.miss.length) {
    await prisma.autoIncident.updateMany({ where: { id: { in: plan.miss } }, data: { missCount: { increment: 1 } } });
  }
  if (plan.resolve.length) {
    await prisma.autoIncident.updateMany({
      where: { id: { in: plan.resolve.map((r) => r.incident.id) } },
      data: { status: "resolved", resolvedAt: now },
    });
  }
  return { announcedIds };
}

/** Called once the digest reached Slack. */
export async function markNotified(plan: Plan, announcedIds: string[], now: Date = new Date()): Promise<void> {
  for (let i = 0; i < plan.announce.length; i++) {
    const id = announcedIds[i];
    if (!id) continue;
    const reason = plan.announce[i].reason;
    await prisma.autoIncident.update({
      where: { id },
      data: {
        lastNotifiedAt: now, notifyError: null,
        ...(reason === "new" ? { notifiedAt: now } : {}),
        ...(reason === "reminder" ? { remindCount: { increment: 1 } } : {}),
      },
    });
  }
}

export async function markNotifyError(announcedIds: string[], error: string): Promise<void> {
  if (!announcedIds.length) return;
  await prisma.autoIncident.updateMany({ where: { id: { in: announcedIds } }, data: { notifyError: error.slice(0, 300) } });
}
