/**
 * Daily cron (07:00 UTC): generates AI reports for clients that opted in.
 *
 * Dashboard.reportFrequency = "weekly" → every Monday, last 7 full days.
 *                           = "monthly" → the 1st of the month, previous month.
 * Idempotent: a period already covered by a ready/generating report is skipped.
 * Runs serially (each report is one relay session) inside maxDuration 300 —
 * remaining clients roll over to the next day (they're skipped only once a
 * report for the period exists).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateClientReport, defaultReportTitle } from "@/lib/report-generate";
import { lastMonthRange, lastWeekRange } from "@/lib/report-data";
import { prevRange } from "@/lib/dashboard-widgets";

export const maxDuration = 300;

const BUDGET_MS = 270_000;

function checkCronAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const now = new Date();
  const force = req.nextUrl.searchParams.get("force") === "1";
  const isMonday = now.getUTCDay() === 1;
  const isFirst = now.getUTCDate() === 1;

  const dashboards = await prisma.dashboard.findMany({
    where: { reportFrequency: { in: ["weekly", "monthly"] } },
    orderBy: { createdAt: "asc" },
  });

  const started = Date.now();
  const results: Array<{ dashboardId: string; name: string; status: string; reportId?: string; error?: string }> = [];

  for (const d of dashboards) {
    const due = d.reportFrequency === "weekly" ? isMonday || force : isFirst || force;
    if (!due) { results.push({ dashboardId: d.id, name: d.name, status: "not_due" }); continue; }
    if (Date.now() - started > BUDGET_MS) { results.push({ dashboardId: d.id, name: d.name, status: "deferred" }); continue; }

    const range = d.reportFrequency === "weekly" ? lastWeekRange(now) : lastMonthRange(now);
    const existing = await prisma.clientReport.findFirst({
      where: { dashboardId: d.id, periodSince: range.since, periodUntil: range.until, status: { in: ["ready", "generating"] } },
      select: { id: true },
    });
    if (existing) { results.push({ dashboardId: d.id, name: d.name, status: "exists", reportId: existing.id }); continue; }

    const cmp = prevRange(range.since, range.until);
    const report = await prisma.clientReport.create({
      data: {
        dashboardId: d.id,
        userId: d.userId,
        title: defaultReportTitle(d.name, range.since, range.until),
        periodSince: range.since,
        periodUntil: range.until,
        compareSince: cmp.since,
        compareUntil: cmp.until,
        status: "generating",
        trigger: "cron",
      },
    });
    try {
      await generateClientReport(report.id);
      results.push({ dashboardId: d.id, name: d.name, status: "ok", reportId: report.id });
    } catch (e) {
      results.push({ dashboardId: d.id, name: d.name, status: "error", reportId: report.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({ processed: dashboards.length, results });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
