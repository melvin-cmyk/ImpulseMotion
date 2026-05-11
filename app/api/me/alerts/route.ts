import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { assertAccountAllowed } from "@/lib/acl";
import { prisma } from "@/lib/prisma";
import { BUDGET_PACING_METRIC } from "@/lib/alerts";

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const rules = await prisma.alertRule.findMany({
    where: { userId: guard.session.userId, NOT: { metric: BUDGET_PACING_METRIC } },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { events: true } } },
  });
  return NextResponse.json({ rules });
}

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const body = await req.json();
  const { clientId, platform, metric, condition, threshold, window } = body;
  if (!metric || !condition || typeof threshold !== "number") {
    return NextResponse.json({ error: "metric, condition, threshold required" }, { status: 400 });
  }
  if (clientId) {
    const allowed = await assertAccountAllowed(guard.session.userId, (platform ?? "meta") as "meta", clientId);
    if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rule = await prisma.alertRule.create({
    data: {
      userId: guard.session.userId,
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
