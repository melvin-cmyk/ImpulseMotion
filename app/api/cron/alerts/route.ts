import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { runAlertScan } from "@/lib/alerts";

export const maxDuration = 300;


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
