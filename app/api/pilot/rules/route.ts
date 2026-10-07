/**
 * GET  /api/pilot/rules?clientId=…        → the automatic rules of the client (staff, scope)
 * POST /api/pilot/rules { clientId, …rule } → creates one (the account must be the client's and in scope)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { resolveAccount } from "@/lib/pilot/service";
import { readRule } from "@/lib/pilot/rules";

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const clientId = new URL(req.url).searchParams.get("clientId") ?? "";
  const scope = await getAccountScope(guard.session);
  const rules = (await prisma.pilotRule.findMany({ where: clientId ? { alertClientId: clientId } : {}, orderBy: { createdAt: "desc" }, take: 200 }))
    .filter((r) => platformAccountInScope(scope, r.platform, r.accountId));
  return NextResponse.json({ rules }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => null);
  const read = readRule(body);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: 400 });
  const resolved = await resolveAccount(guard.session, String(body?.clientId ?? ""), read.rule.accountId, read.rule.platform);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  const user = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { name: true, email: true } });
  const currency = await resolved.adapter.readCurrency(resolved.account.digits).catch(() => resolved.account.currency ?? "EUR");
  const rule = await prisma.pilotRule.create({
    data: {
      alertClientId: resolved.client.id, clientName: resolved.client.name, platform: read.rule.platform, accountId: resolved.account.digits, accountName: resolved.account.name ?? "", currency,
      createdById: guard.session.userId, createdByName: (user?.name ?? "").trim() || user?.email || "Consultant",
      name: read.rule.name, enabled: read.rule.enabled, objectType: read.rule.objectType, objectId: read.rule.objectId, objectName: read.rule.objectName,
      metric: read.rule.metric, op: read.rule.op, threshold: read.rule.threshold, days: read.rule.days, minConversions: read.rule.minConversions,
      action: read.rule.action, actionValue: read.rule.actionValue, cooldownDays: read.rule.cooldownDays, notifyChannel: read.rule.notifyChannel,
    },
  });
  return NextResponse.json({ rule }, { status: 201 });
}
