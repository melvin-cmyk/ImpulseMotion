import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
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
  // Run every Monday at 07:00 UTC
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  d.setUTCHours(7, 0, 0, 0);
  return d;
}

export async function GET() {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const schedules = await prisma.reportSchedule.findMany({
    orderBy: { createdAt: "desc" },
    include: { user: { select: { email: true, name: true } } },
  });
  return NextResponse.json({ schedules });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const body = await req.json();
  const { userId, clientId, clientLabel, platform, frequency, recipients } = body as {
    userId: string;
    clientId: string;
    clientLabel?: string;
    platform?: string;
    frequency?: string;
    recipients: string;
  };
  if (!userId || !clientId || !recipients) {
    return NextResponse.json({ error: "userId, clientId, recipients required" }, { status: 400 });
  }
  const freq = frequency ?? "monthly";
  const nextRunAt = freq === "weekly" ? nextWeeklyRun() : nextMonthlyRun();
  const schedule = await prisma.reportSchedule.create({
    data: {
      userId,
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
