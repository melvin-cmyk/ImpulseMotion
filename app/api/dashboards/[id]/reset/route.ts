/**
 * POST /api/dashboards/[id]/reset — staff: replace all widgets with the
 * current rich default set (used after account rebinds, or to adopt new
 * defaults on dashboards nobody customized).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { resetDashboardWidgets } from "@/lib/dashboard-widgets";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const dashboard = await resetDashboardWidgets(id);
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
