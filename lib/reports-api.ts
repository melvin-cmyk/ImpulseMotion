/** Shared select/serializers for the /api/reports routes (route files may only export handlers). */

import type { ReportNextStep } from "@/lib/report-data";

export const REPORT_LIST_SELECT = {
  id: true, dashboardId: true, userId: true, title: true, periodSince: true, periodUntil: true,
  compareSince: true, compareUntil: true, status: true, trigger: true, summary: true, error: true,
  nextStepsJson: true, createdAt: true, updatedAt: true,
  dashboard: { select: { id: true, name: true, metaAccountId: true, googleCustomerId: true, reportFrequency: true } },
  user: { select: { id: true, name: true, email: true } },
} as const;

export const REPORT_FULL_INCLUDE = {
  dashboard: { select: { id: true, name: true, metaAccountId: true, googleCustomerId: true, reportFrequency: true } },
  user: { select: { id: true, name: true, email: true } },
} as const;

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function serializeReportRow(r: {
  id: string; dashboardId: string; userId: string | null; title: string; periodSince: string; periodUntil: string;
  compareSince: string | null; compareUntil: string | null; status: string; trigger: string; summary: string | null;
  error: string | null; nextStepsJson: string; createdAt: Date; updatedAt: Date;
  dashboard: { id: string; name: string; metaAccountId: string | null; googleCustomerId: string | null; reportFrequency: string | null };
  user: { id: string; name: string | null; email: string | null } | null;
}) {
  const steps = parseJson<ReportNextStep[]>(r.nextStepsJson, []);
  return {
    id: r.id,
    dashboardId: r.dashboardId,
    title: r.title,
    periodSince: r.periodSince,
    periodUntil: r.periodUntil,
    compareSince: r.compareSince,
    compareUntil: r.compareUntil,
    status: r.status,
    trigger: r.trigger,
    summary: r.summary,
    error: r.error,
    nextStepsCount: steps.length,
    nextStepsDone: steps.filter((s) => s.done).length,
    dashboard: r.dashboard,
    author: r.user,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function serializeReport(r: Parameters<typeof serializeReportRow>[0] & { dataJson: string; contentMd: string; chatJson: string }) {
  return {
    ...serializeReportRow(r),
    contentMd: r.contentMd,
    data: parseJson<unknown>(r.dataJson, null),
    nextSteps: parseJson<ReportNextStep[]>(r.nextStepsJson, []),
    chat: parseJson<Array<{ role: "user" | "assistant"; content: string }>>(r.chatJson, []),
  };
}
