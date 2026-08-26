/**
 * PATCH  /api/dashboards/[id]/widgets/[wid]  → staff: edit title/width/config/position
 * DELETE /api/dashboards/[id]/widgets/[wid]  → staff
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { validateWidgetConfig, validateWidgetWidth } from "@/lib/dashboard-widgets";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; wid: string }> },
) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id, wid } = await params;

  const widget = await prisma.dashboardWidget.findFirst({ where: { id: wid, dashboardId: id } });
  if (!widget) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {};
  if (typeof body.title === "string") data.title = body.title.trim().slice(0, 120) || null;
  if (body.width !== undefined) data.width = validateWidgetWidth(body.width);
  if (Number.isInteger(body.position)) data.position = Number(body.position);
  if (body.config !== undefined) {
    try {
      data.config = JSON.stringify(validateWidgetConfig(widget.type, body.config));
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "invalid config" }, { status: 400 });
    }
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const updated = await prisma.dashboardWidget.update({ where: { id: wid }, data });
  return NextResponse.json({ widget: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; wid: string }> },
) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id, wid } = await params;
  await prisma.dashboardWidget.deleteMany({ where: { id: wid, dashboardId: id } });
  return NextResponse.json({ ok: true });
}
