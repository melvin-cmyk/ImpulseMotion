/**
 * POST /api/staff-dashboards/catalog/metrics → 201 { metric }
 * Adds a metric to the team's catalogue (any staff member). The formula is
 * parsed before anything is written; a key already taken answers 409.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { metricFromRow, validateMetricInput } from "@/lib/staff-dashboards/catalog";

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => null);
  const v = validateMetricInput(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  if (await prisma.staffMetric.findUnique({ where: { key: v.value.key }, select: { id: true } })) {
    return NextResponse.json({ error: `la clé « ${v.value.key} » existe déjà` }, { status: 409 });
  }
  const row = await prisma.staffMetric.create({ data: { ...v.value, ownerId: guard.session.userId }, include: { owner: { select: { email: true } } } });
  return NextResponse.json({ metric: metricFromRow(row) }, { status: 201 });
}
