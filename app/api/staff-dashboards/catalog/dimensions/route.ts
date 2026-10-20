/**
 * POST /api/staff-dashboards/catalog/dimensions → 201 { dimension }
 * Adds a dimension to the team's catalogue (any staff member). The rule is
 * checked (regex compiles, mapping lines complete); a taken key answers 409.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { dimensionFromRow, validateDimensionInput } from "@/lib/staff-dashboards/catalog";

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const v = validateDimensionInput(await req.json().catch(() => null));
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  if (await prisma.staffDimension.findUnique({ where: { key: v.value.key }, select: { id: true } })) {
    return NextResponse.json({ error: `la clé « ${v.value.key} » existe déjà` }, { status: 409 });
  }
  const { rule, ...rest } = v.value;
  const row = await prisma.staffDimension.create({ data: { ...rest, ruleJson: JSON.stringify(rule), ownerId: guard.session.userId }, include: { owner: { select: { email: true } } } });
  return NextResponse.json({ dimension: dimensionFromRow(row) }, { status: 201 });
}
