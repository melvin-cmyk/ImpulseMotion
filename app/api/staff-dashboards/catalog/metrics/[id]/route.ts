/**
 * PUT    /api/staff-dashboards/catalog/metrics/[id] → { metric }   (whole definition)
 * DELETE /api/staff-dashboards/catalog/metrics/[id] → { ok: true }
 * The catalogue is the team's: any staff member may edit or remove an entry.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { metricFromRow, validateMetricInput } from "@/lib/staff-dashboards/catalog";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const existing = await prisma.staffMetric.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  const v = validateMetricInput(await req.json().catch(() => null));
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const clash = await prisma.staffMetric.findUnique({ where: { key: v.value.key }, select: { id: true } });
  if (clash && clash.id !== id) return NextResponse.json({ error: `la clé « ${v.value.key} » existe déjà` }, { status: 409 });
  const row = await prisma.staffMetric.update({ where: { id }, data: v.value, include: { owner: { select: { email: true } } } });
  return NextResponse.json({ metric: metricFromRow(row) });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const { count } = await prisma.staffMetric.deleteMany({ where: { id } });
  return count ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "introuvable" }, { status: 404 });
}
