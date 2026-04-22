import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Public access — increment views and return report
  const report = await prisma.sharedReport.update({
    where: { id },
    data: { views: { increment: 1 } },
  }).catch(() => null);

  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    ...report,
    creativeIds: JSON.parse(report.creativeIds),
    metrics: JSON.parse(report.metrics),
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const { id } = await params;

  const report = await prisma.sharedReport.findUnique({ where: { id } });
  if (!report || report.userId !== guard.session.userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.sharedReport.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
