import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountInsights, getMetaSystemToken } from "@/lib/meta-api";

export const maxDuration = 300;

function checkCronAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

function nextMonthlyRun(from = new Date()): Date {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(1);
  d.setUTCHours(7, 0, 0, 0);
  return d;
}

function nextWeeklyRun(from = new Date()): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + 7);
  d.setUTCHours(7, 0, 0, 0);
  return d;
}

function lastMonthRange(): { since: string; until: string } {
  const now = new Date();
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonthEnd = new Date(firstOfThisMonth);
  lastMonthEnd.setUTCDate(0);
  const lastMonthStart = new Date(Date.UTC(lastMonthEnd.getUTCFullYear(), lastMonthEnd.getUTCMonth(), 1));
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { since: fmt(lastMonthStart), until: fmt(lastMonthEnd) };
}

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const due = await prisma.reportSchedule.findMany({
    where: {
      enabled: true,
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: new Date() } }],
    },
  });

  const results: Array<{ id: string; status: string; error?: string }> = [];
  const token = getMetaSystemToken();
  const range = lastMonthRange();
  const periodKey = `${range.since}_${range.until}`;

  for (const sched of due) {
    try {
      const insight = await getAccountInsights(token, sched.clientId, range);
      const metrics = {
        spend: parseFloat(insight?.spend ?? "0"),
        impressions: parseInt(insight?.impressions ?? "0", 10),
        clicks: parseInt(insight?.clicks ?? "0", 10),
        ctr: parseFloat(insight?.ctr ?? "0"),
        cpm: parseFloat(insight?.cpm ?? "0"),
        frequency: parseFloat(insight?.frequency ?? "0"),
        actions: insight?.actions ?? [],
      };

      await prisma.deckHistory.create({
        data: {
          userId: sched.userId,
          clientId: sched.clientId,
          clientName: sched.clientLabel ?? sched.clientId,
          platform: sched.platform,
          period: periodKey,
          startDate: new Date(range.since),
          endDate: new Date(range.until),
          slidesJson: JSON.stringify({ kind: "auto-generated", schedule: sched.id }),
          metricsJson: JSON.stringify(metrics),
        },
      });

      await prisma.reportSchedule.update({
        where: { id: sched.id },
        data: {
          lastRunAt: new Date(),
          lastRunError: null,
          nextRunAt: sched.frequency === "weekly" ? nextWeeklyRun() : nextMonthlyRun(),
        },
      });

      results.push({ id: sched.id, status: "ok" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      await prisma.reportSchedule.update({
        where: { id: sched.id },
        data: {
          lastRunError: msg,
          nextRunAt: sched.frequency === "weekly" ? nextWeeklyRun() : nextMonthlyRun(),
        },
      });
      results.push({ id: sched.id, status: "error", error: msg });
    }
  }

  return NextResponse.json({ processed: due.length, results });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
