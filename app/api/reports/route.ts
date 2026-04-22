import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const reports = await prisma.sharedReport.findMany({
    where: { userId: guard.session.userId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    reports.map((r) => ({
      ...r,
      creativeIds: JSON.parse(r.creativeIds),
      metrics: JSON.parse(r.metrics),
    }))
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const body = await req.json();
  const { name, periodFrom, periodTo, creativeIds, metrics } = body;

  if (!name || !creativeIds?.length || !metrics?.length) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const report = await prisma.sharedReport.create({
    data: {
      userId: guard.session.userId,
      name,
      periodFrom,
      periodTo,
      creativeIds: JSON.stringify(creativeIds),
      metrics: JSON.stringify(metrics),
    },
  });

  return NextResponse.json({
    ...report,
    creativeIds: JSON.parse(report.creativeIds),
    metrics: JSON.parse(report.metrics),
  });
}
