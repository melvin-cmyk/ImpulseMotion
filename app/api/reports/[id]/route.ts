import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
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
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const report = await prisma.sharedReport.findUnique({ where: { id } });
  if (!report || report.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.sharedReport.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
