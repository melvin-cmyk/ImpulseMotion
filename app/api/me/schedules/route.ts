import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { assertAccountAllowed } from "@/lib/acl";
import { prisma } from "@/lib/prisma";

function nextMonthlyRun(from = new Date()): Date {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(1);
  d.setUTCHours(7, 0, 0, 0);
  return d;
}

function nextWeeklyRun(from = new Date()): Date {
  const d = new Date(from);
  const day = d.getUTCDay();
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  d.setUTCHours(7, 0, 0, 0);
  return d;
}

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const schedules = await prisma.reportSchedule.findMany({
    where: { userId: guard.session.userId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ schedules });
}

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const body = await req.json();
  const { clientId, clientLabel, platform, frequency, recipients } = body as {
    clientId: string;
    clientLabel?: string;
    platform?: string;
    frequency?: string;
    recipients: string;
  };
  if (!clientId || !recipients) {
    return NextResponse.json({ error: "clientId and recipients required" }, { status: 400 });
  }
  const allowed = await assertAccountAllowed(guard.session.userId, (platform ?? "meta") as "meta", clientId);
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const freq = frequency ?? "monthly";
  const nextRunAt = freq === "weekly" ? nextWeeklyRun() : nextMonthlyRun();
  const schedule = await prisma.reportSchedule.create({
    data: {
      userId: guard.session.userId,
      clientId,
      clientLabel: clientLabel ?? null,
      platform: platform ?? "meta",
      frequency: freq,
      recipients,
      nextRunAt,
    },
  });
  return NextResponse.json({ schedule });
}
