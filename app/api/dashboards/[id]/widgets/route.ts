/**
 * POST /api/dashboards/[id]/widgets          → staff: add a widget
 *   Body: { type, title?, width?, config?, position? }
 * PUT  /api/dashboards/[id]/widgets          → staff: reorder
 *   Body: { order: string[] }  (widget ids, new order)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { validateWidgetConfig, validateWidgetWidth } from "@/lib/dashboard-widgets";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const dashboard = await prisma.dashboard.findUnique({
    where: { id },
    include: { _count: { select: { widgets: true } } },
  });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (dashboard._count.widgets >= 24) {
    return NextResponse.json({ error: "24 widgets max par dashboard" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  let config: Record<string, unknown>;
  try {
    config = validateWidgetConfig(String(body.type ?? ""), body.config);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "invalid config" }, { status: 400 });
  }

  const maxPos = await prisma.dashboardWidget.aggregate({
    where: { dashboardId: id },
    _max: { position: true },
  });
  const position = Number.isInteger(body.position)
    ? Number(body.position)
    : (maxPos._max.position ?? -1) + 1;

  const widget = await prisma.dashboardWidget.create({
    data: {
      dashboardId: id,
      type: String(body.type),
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : null,
      width: validateWidgetWidth(body.width),
      position,
      config: JSON.stringify(config),
    },
  });
  return NextResponse.json({ widget });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  if (!Array.isArray(body.order) || body.order.some((x: unknown) => typeof x !== "string")) {
    return NextResponse.json({ error: "order must be an array of widget ids" }, { status: 400 });
  }
  const order = body.order as string[];

  const results = await prisma.$transaction(
    order.map((widgetId, index) =>
      prisma.dashboardWidget.updateMany({
        where: { id: widgetId, dashboardId: id },
        data: { position: index },
      }),
    ),
  );
  const matched = results.reduce((s, r) => s + r.count, 0);
  if (matched !== order.length) {
    return NextResponse.json(
      { error: `réorganisation partielle: ${matched}/${order.length} widgets trouvés — rechargez le dashboard` },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
}
