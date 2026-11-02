/**
 * GET /api/cron/weekly-recap — Monday morning: weekly creative recap of every
 * client in its Slack channel (lib/weekly-recap.ts). Posts only when
 * WEEKLY_RECAP_SEND=1; otherwise a dry run (nothing is posted).
 */

import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { runWeeklyRecap } from "@/lib/weekly-recap";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const send = process.env.WEEKLY_RECAP_SEND === "1";
  const results = await runWeeklyRecap({ send, deadline: Date.now() + 270_000 });
  return NextResponse.json({ send, results: results.map((r) => ({ ...r, text: undefined })) });
}
