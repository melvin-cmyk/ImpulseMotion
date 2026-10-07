/**
 * PATCH  /api/pilot/rules/[id] { enabled?, …rule } → updates a rule (staff, scope)
 * DELETE /api/pilot/rules/[id]
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { readRule } from "@/lib/pilot/rules";

type Ctx = { params: Promise<{ id: string }> };

async function load(session: { userId: string; role?: string | null; baseRole?: string | null }, id: string) {
  const rule = await prisma.pilotRule.findUnique({ where: { id } });
  if (!rule || !platformAccountInScope(await getAccountScope(session), rule.platform, rule.accountId)) return null;
  return rule;
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const rule = await load(guard.session, (await params).id);
  if (!rule) return NextResponse.json({ error: "Règle introuvable." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (Object.keys(body).length === 1 && typeof body.enabled === "boolean") {
    return NextResponse.json({ rule: await prisma.pilotRule.update({ where: { id: rule.id }, data: { enabled: body.enabled } }) });
  }
  const read = readRule({ ...rule, ...body, platform: rule.platform, accountId: rule.accountId });
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: 400 });
  const updated = await prisma.pilotRule.update({
    where: { id: rule.id },
    data: { name: read.rule.name, enabled: read.rule.enabled, objectType: read.rule.objectType, objectId: read.rule.objectId, objectName: read.rule.objectName, metric: read.rule.metric, op: read.rule.op, threshold: read.rule.threshold, days: read.rule.days, minConversions: read.rule.minConversions, action: read.rule.action, actionValue: read.rule.actionValue, cooldownDays: read.rule.cooldownDays, notifyChannel: read.rule.notifyChannel },
  });
  return NextResponse.json({ rule: updated });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const rule = await load(guard.session, (await params).id);
  if (!rule) return NextResponse.json({ error: "Règle introuvable." }, { status: 404 });
  await prisma.pilotRule.delete({ where: { id: rule.id } });
  return NextResponse.json({ ok: true });
}
