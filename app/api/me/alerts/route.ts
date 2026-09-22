import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { assertAccountAllowed } from "@/lib/acl";
import { prisma } from "@/lib/prisma";
import { validateNotify } from "@/lib/alert-notify";
import { parseFilter, validateRuleInput } from "@/lib/alert-entities";
import { BUDGET_PACING_METRIC } from "@/lib/alerts";

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const rules = await prisma.alertRule.findMany({
    where: { userId: guard.session.userId, NOT: { metric: BUDGET_PACING_METRIC } },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { events: true } } },
  });
  return NextResponse.json({ rules: rules.map((r) => ({ ...r, filter: parseFilter(r.filterJson) })) });
}

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const body = await req.json();
  const { clientId, platform } = body;
  const spec = validateRuleInput(body);
  if (!spec.ok) return NextResponse.json({ error: spec.error }, { status: 400 });
  if (clientId) {
    const allowed = await assertAccountAllowed(guard.session.userId, (platform ?? "meta") as "meta", clientId);
    if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const notify = validateNotify(body.notify);
  if (!notify.ok) return NextResponse.json({ error: notify.error }, { status: 400 });
  const rule = await prisma.alertRule.create({
    data: {
      userId: guard.session.userId,
      clientId: clientId ?? null,
      platform: platform ?? "meta",
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
