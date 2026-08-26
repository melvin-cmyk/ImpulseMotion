import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { BUDGET_PACING_METRIC } from "@/lib/alerts";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const rules = await prisma.alertRule.findMany({
    where: { NOT: { metric: BUDGET_PACING_METRIC } },
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { email: true, name: true } },
      _count: { select: { events: true } },
    },
  });
  return NextResponse.json({ rules });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json();
  const { userId, clientId, platform, metric, condition, threshold, window } = body;
  if (!userId || !metric || !condition || typeof threshold !== "number") {
    return NextResponse.json(
      { error: "userId, metric, condition, threshold required" },
      { status: 400 },
    );
  }
  const rule = await prisma.alertRule.create({
    data: {
      userId,
      clientId: clientId ?? null,
      platform: platform ?? "meta",
      metric,
      condition,
      threshold,
      window: window ?? "7d",
    },
  });
  return NextResponse.json({ rule });
}
