import { NextRequest, NextResponse } from "next/server";
import { isStaff, requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { searchParams } = new URL(req.url);
  const acknowledged = searchParams.get("acknowledged");
  // Staff (admin + consultant) see every client's events — same scope as the cockpit.
  const where = isStaff(guard.session) ? {} : { userId: guard.session.userId };
  const events = await prisma.alertEvent.findMany({
    where: {
      ...where,
      ...(acknowledged === "false" ? { acknowledged: false } : {}),
    },
    orderBy: { triggeredAt: "desc" },
    take: 100,
    include: { rule: { select: { metric: true, condition: true, threshold: true } } },
  });
  return NextResponse.json({ events });
}

export async function PATCH(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const body = await req.json();
  const { id, acknowledged } = body as { id: string; acknowledged: boolean };
  const event = await prisma.alertEvent.findUnique({ where: { id } });
  if (!event) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!isStaff(guard.session) && event.userId !== guard.session.userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  await prisma.alertEvent.update({ where: { id }, data: { acknowledged } });
  return NextResponse.json({ ok: true });
}
