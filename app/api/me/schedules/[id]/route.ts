import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

async function getOwned(id: string, userId: string) {
  const row = await prisma.reportSchedule.findUnique({ where: { id } });
  if (!row || row.userId !== userId) return null;
  return row;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const owned = await getOwned(id, guard.session.userId);
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json();
  const updated = await prisma.reportSchedule.update({
    where: { id },
    data: {
      enabled: body.enabled,
      recipients: body.recipients,
      frequency: body.frequency,
    },
  });
  return NextResponse.json({ schedule: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const owned = await getOwned(id, guard.session.userId);
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });
  await prisma.reportSchedule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
