import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const body = await req.json();
  const updated = await prisma.alertRule.update({
    where: { id },
    data: { enabled: body.enabled, threshold: body.threshold },
  });
  return NextResponse.json({ rule: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  await prisma.alertRule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
