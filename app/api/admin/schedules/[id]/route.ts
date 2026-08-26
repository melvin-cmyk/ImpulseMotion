import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
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
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  await prisma.reportSchedule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
