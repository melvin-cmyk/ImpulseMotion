/**
 * DELETE /api/pilot/actions/[id] → drops one's own preview that was not sent.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  await prisma.pilotAction.updateMany({ where: { id, createdById: guard.session.userId, status: "draft" }, data: { status: "expired" } });
  return NextResponse.json({ ok: true });
}
