import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reports = await prisma.sharedReport.findMany({
    where: { userId: session.user.id },
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
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { name, periodFrom, periodTo, creativeIds, metrics } = body;

  if (!name || !creativeIds?.length || !metrics?.length) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const report = await prisma.sharedReport.create({
    data: {
      userId: session.user.id,
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
