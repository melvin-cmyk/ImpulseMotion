/**
 * GET /api/cron/ads-sync — hourly pass of the creative warehouse (see
 * vercel.json): yesterday for every account + one backfill chunk, within the
 * function budget. Partial passes are normal: the next hour continues.
 * `WAREHOUSE_SYNC=off` pauses it.
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
