import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { validateNotify } from "@/lib/alert-notify";
import { parseFilter, validateRuleInput } from "@/lib/alert-entities";
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
  return NextResponse.json({ rules: visible.map((r) => ({ ...r, filter: parseFilter(r.filterJson) })) });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json();
  const { userId, clientId } = body;
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
  const platform = body.platform === "google" ? "google" : "meta";
  const spec = validateRuleInput(body, { platform });
  if (!spec.ok) return NextResponse.json({ error: spec.error }, { status: 400 });
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
      platform,
      metric: spec.data.metric!,
      condition: spec.data.condition!,
      threshold: spec.data.threshold!,
      window: spec.data.window ?? "7d",
      level: spec.data.level ?? "account",
      filterJson: spec.data.filterJson ?? "{}",
      mode: spec.data.mode ?? "rule",
      prompt: spec.data.prompt ?? null,
      label: spec.data.label ?? null,
      notifyJson: JSON.stringify(notify.value),
    },
  });
  return NextResponse.json({ rule });
}
