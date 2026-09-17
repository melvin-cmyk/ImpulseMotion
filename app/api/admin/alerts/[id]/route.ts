import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { accountIdInScope, getAccountScope } from "@/lib/scope";

/** 404 when the rule is gone, 403 when it belongs to a client the viewer
 *  was not assigned. Admins pass through. */
async function denyIfRuleOutOfScope(
  session: { userId: string; role?: string | null },
  id: string,
): Promise<NextResponse | null> {
  const rule = await prisma.alertRule.findUnique({ where: { id }, select: { clientId: true } });
  if (!rule) return NextResponse.json({ error: "not found" }, { status: 404 });
  const scope = await getAccountScope(session);
  if (!accountIdInScope(scope, rule.clientId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return null;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfRuleOutOfScope(guard.session, id);
  if (denied) return denied;
  const body = await req.json();
  const updated = await prisma.alertRule.update({
    where: { id },
    data: { enabled: body.enabled, threshold: body.threshold },
  });
  return NextResponse.json({ rule: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfRuleOutOfScope(guard.session, id);
  if (denied) return denied;
  await prisma.alertRule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
