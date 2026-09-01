/**
 * GET  /api/reports?dashboardId=&limit=   → staff: list reports (newest first)
 * POST /api/reports                        → staff: create + generate a report
 *      body { dashboardId, since, until, compare?: "prev"|"year"|"none"|"custom", cmpSince?, cmpUntil?, title? }
 *
 * Generation runs inside the request (maxDuration 300): the row is created in
 * status "generating" first so the UI can poll /api/reports/[id] and survive a
 * dropped connection.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { generateClientReport, defaultReportTitle, resolveCompare } from "@/lib/report-generate";
import { REPORT_LIST_SELECT, serializeReportRow } from "@/lib/reports-api";

export const maxDuration = 300;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  const dashboardId = req.nextUrl.searchParams.get("dashboardId");
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") ?? 50) || 50, 1), 200);
  const reports = await prisma.clientReport.findMany({
    where: dashboardId ? { dashboardId } : {},
    orderBy: { createdAt: "desc" },
    take: limit,
    select: REPORT_LIST_SELECT,
  });
  return NextResponse.json({ reports: reports.map(serializeReportRow) });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => ({}));
  const dashboardId = typeof body.dashboardId === "string" ? body.dashboardId : "";
  const since = typeof body.since === "string" ? body.since : "";
  const until = typeof body.until === "string" ? body.until : "";
  if (!dashboardId) return NextResponse.json({ error: "dashboardId requis" }, { status: 400 });
  if (!DATE_RE.test(since) || !DATE_RE.test(until) || since > until) {
    return NextResponse.json({ error: "since/until invalides (YYYY-MM-DD)" }, { status: 400 });
  }
  const dashboard = await prisma.dashboard.findUnique({ where: { id: dashboardId } });
  if (!dashboard) return NextResponse.json({ error: "client introuvable" }, { status: 404 });

  const cmp = resolveCompare(since, until, typeof body.compare === "string" ? body.compare : "prev", {
    since: body.cmpSince, until: body.cmpUntil,
  });
  if (cmp && (!DATE_RE.test(cmp.since) || !DATE_RE.test(cmp.until))) {
    return NextResponse.json({ error: "période de comparaison invalide" }, { status: 400 });
  }

  const report = await prisma.clientReport.create({
    data: {
      dashboardId,
      userId: guard.session.userId,
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : defaultReportTitle(dashboard.name, since, until),
      periodSince: since,
      periodUntil: until,
      compareSince: cmp?.since ?? null,
      compareUntil: cmp?.until ?? null,
      status: "generating",
      trigger: "manual",
    },
  });

  // Fire-and-poll: the client can either await this response or poll the id.
  try {
    await generateClientReport(report.id);
  } catch (e) {
    const full = await prisma.clientReport.findUnique({ where: { id: report.id }, select: REPORT_LIST_SELECT });
    return NextResponse.json({ error: e instanceof Error ? e.message : "génération échouée", report: full ? serializeReportRow(full) : null }, { status: 502 });
  }
  const full = await prisma.clientReport.findUnique({ where: { id: report.id }, select: REPORT_LIST_SELECT });
  return NextResponse.json({ report: full ? serializeReportRow(full) : null });
}
