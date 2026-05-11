import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await prisma.accountBudget.findUnique({ where: { id } });
  if (!row || row.userId !== guard.session.userId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  await prisma.accountBudget.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
