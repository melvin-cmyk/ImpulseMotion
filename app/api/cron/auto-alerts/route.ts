import { NextRequest, NextResponse } from "next/server";
import { runAutoAlerts } from "@/lib/auto-alerts/run";

export const maxDuration = 300;

function checkCronAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed: no secret configured → deny
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Four firings a day (vercel.json); each client follows its own frequency. Quiet accounts cost a few API reads and no AI. */
export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await runAutoAlerts({ scheduled: true, sync: true, deadlineAt: Date.now() + 270_000 });
  const { runs, ...summary } = result;
  return NextResponse.json({
    ...summary,
    sent: runs.filter((r) => r.sent).map((r) => ({ client: r.name, channel: r.channel, announced: r.announced, resolved: r.resolved })),
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
