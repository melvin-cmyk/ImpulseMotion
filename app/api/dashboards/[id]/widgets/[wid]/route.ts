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
      // Merge with the stored config so a partial patch (e.g. just {metric})
      // doesn't silently reset the other fields to their defaults.
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(widget.config || "{}"); } catch { /* keep {} */ }
      const patch = body.config && typeof body.config === "object" ? body.config : {};
      data.config = JSON.stringify(validateWidgetConfig(widget.type, { ...existing, ...patch }));
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
  const { count } = await prisma.dashboardWidget.deleteMany({ where: { id: wid, dashboardId: id } });
  if (count === 0) {
    // Never report success for a no-op — the caller (human or copilot) would
    // show "✓ Appliqué" while nothing changed.
    return NextResponse.json({ error: "widget introuvable (déjà supprimé ?)" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
