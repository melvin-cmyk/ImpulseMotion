/**
 * PUT    /api/staff-dashboards/catalog/dimensions/[id] → { dimension } (whole definition)
 * DELETE /api/staff-dashboards/catalog/dimensions/[id] → { ok: true }
 * The catalogue is the team's: any staff member may edit or remove an entry.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { dimensionFromRow, validateDimensionInput } from "@/lib/staff-dashboards/catalog";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const existing = await prisma.staffDimension.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  const v = validateDimensionInput(await req.json().catch(() => null));
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const clash = await prisma.staffDimension.findUnique({ where: { key: v.value.key }, select: { id: true } });
  if (clash && clash.id !== id) return NextResponse.json({ error: `la clé « ${v.value.key} » existe déjà` }, { status: 409 });
  const { rule, ...rest } = v.value;
  const row = await prisma.staffDimension.update({ where: { id }, data: { ...rest, ruleJson: JSON.stringify(rule) }, include: { owner: { select: { email: true } } } });
  return NextResponse.json({ dimension: dimensionFromRow(row) });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const { count } = await prisma.staffDimension.deleteMany({ where: { id } });
  return count ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "introuvable" }, { status: 404 });
}
