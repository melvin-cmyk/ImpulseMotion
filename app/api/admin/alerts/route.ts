import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { validateNotify } from "@/lib/alert-notify";
import { BUDGET_PACING_METRIC } from "@/lib/alerts";
import { accountIdInScope, getAccountScope } from "@/lib/scope";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const scope = await getAccountScope(guard.session);
  const rules = await prisma.alertRule.findMany({
    where: { NOT: { metric: BUDGET_PACING_METRIC } },
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { email: true, name: true } },
      _count: { select: { events: true } },
    },
  });
  // A consultant only sees the rules of the accounts an admin assigned to them.
  // Account-agnostic rules (clientId null) span the whole BM → admins only.
  const visible = scope.all ? rules : rules.filter((r) => accountIdInScope(scope, r.clientId));
  return NextResponse.json({ rules: visible });
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
  const scope = await getAccountScope(guard.session);
  if (!scope.all) {
    // A consultant arms alerts for themselves, on an assigned account only.
    if (userId !== guard.session.userId || !accountIdInScope(scope, clientId)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }
  const notify = validateNotify(body.notify);
  if (!notify.ok) return NextResponse.json({ error: notify.error }, { status: 400 });
  const rule = await prisma.alertRule.create({
    data: {
      userId,
      clientId: clientId ?? null,
      platform: platform ?? "meta",
      metric,
      condition,
      threshold,
      window: window ?? "7d",
      notifyJson: JSON.stringify(notify.value),
    },
  });
  return NextResponse.json({ rule });
}
