import { NextRequest, NextResponse } from "next/server";
import { runAlertScan } from "@/lib/alerts";

export const maxDuration = 300;

function checkCronAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed: no secret configured → deny
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runAlertScan();
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  return GET(req);
}
