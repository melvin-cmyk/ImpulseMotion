/**
 * GET /api/cron/ads-sync — nightly passes of the creative warehouse (six
 * entries 01:30→06:30 UTC in vercel.json: the Hobby plan only allows daily
 * expressions): yesterday for every account + one backfill chunk, within the
 * function budget. Partial passes are normal: the next entry continues, and
 * the server timer (deploy/impulsemotion-ads-sync.timer) does the heavy
 * lifting without the 300 s limit. `WAREHOUSE_SYNC=off` pauses it.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { runAdsSync } from "@/lib/ads-warehouse/sync";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if ((process.env.WAREHOUSE_SYNC ?? "on").toLowerCase() === "off") return NextResponse.json({ skipped: true, reason: "WAREHOUSE_SYNC=off" });
  try {
    const report = await runAdsSync({ deadline: Date.now() + 280_000 });
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
