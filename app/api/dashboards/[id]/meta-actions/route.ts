/**
 * GET /api/dashboards/[id]/meta-actions?since=YYYY-MM-DD&until=YYYY-MM-DD
 *   → staff: Meta action types present on the dashboard's account over the
 *     window (default: last 30 full days), plus the account's conversion
 *     setting. Feeds the widget editor's conversion / action pickers.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { listDashboardMetaActions } from "@/lib/dashboard-widgets";
import { lastFullDays } from "@/lib/date-ranges";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;

  const dashboard = await prisma.dashboard.findUnique({
    where: { id },
    select: { id: true, userId: true, metaAccountId: true, googleCustomerId: true },
  });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });

  const since = req.nextUrl.searchParams.get("since") ?? "";
  const until = req.nextUrl.searchParams.get("until") ?? "";
  const range = DATE_RE.test(since) && DATE_RE.test(until) && since <= until ? { since, until } : lastFullDays(30);

  try {
    return NextResponse.json(await listDashboardMetaActions(dashboard, range.since, range.until));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
