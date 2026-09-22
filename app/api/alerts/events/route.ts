import { accountIdInScope, getAccountScope } from "@/lib/scope";
import { NextRequest, NextResponse } from "next/server";
import { isStaff, requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { searchParams } = new URL(req.url);
  const acknowledged = searchParams.get("acknowledged");
  // Staff see the events of their assigned clients (admin: all) — same scope as the cockpit.
  const staff = isStaff(guard.session);
  const where = staff ? {} : { userId: guard.session.userId };
  const rows = await prisma.alertEvent.findMany({
    where: {
      ...where,
      ...(acknowledged === "false" ? { acknowledged: false } : {}),
    },
    orderBy: { triggeredAt: "desc" },
    take: staff ? 400 : 100,
    include: { rule: { select: { metric: true, condition: true, threshold: true, label: true, level: true, mode: true } } },
  });
  const scope = staff ? await getAccountScope(guard.session) : null;
  const events = (scope ? rows.filter((e) => accountIdInScope(scope, e.clientId)) : rows).slice(0, 100);
  return NextResponse.json({ events });
}

export async function PATCH(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const body = await req.json();
  const { id, acknowledged } = body as { id: string; acknowledged: boolean };
  const event = await prisma.alertEvent.findUnique({ where: { id } });
  if (!event) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (isStaff(guard.session)) {
    // Acknowledging is an act of monitoring: only on an assigned client.
    const scope = await getAccountScope(guard.session);
    if (!accountIdInScope(scope, event.clientId)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  } else if (event.userId !== guard.session.userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  await prisma.alertEvent.update({ where: { id }, data: { acknowledged } });
  return NextResponse.json({ ok: true });
}
