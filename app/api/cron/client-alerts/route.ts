/**
 * Cron of the client alerts — four firings a day (vercel.json), ten minutes
 * after the automatic alerts; each alert follows its own frequency.
 *
 *   ?dry=1        records what would be sent, sends nothing (also the rule while CLIENT_ALERTS_SEND is not on)
 *   ?slot=<0-3>   takes the alerts of that slot, whatever the hour
 *   ?all=1        every active alert, whatever its frequency
 *
 * Emergency stop: CLIENT_ALERTS_CRON=off — nothing is read, nothing is written.
 */

import { NextRequest, NextResponse } from "next/server";
import { runClientAlerts } from "@/lib/client-alerts/run";

export const maxDuration = 300;

function checkCronAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed: no secret configured → deny
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.CLIENT_ALERTS_CRON?.trim().toLowerCase() === "off") return NextResponse.json({ stopped: true });
  const q = req.nextUrl.searchParams;
  const forced = q.get("slot");
  // undefined = the slot of the hour; null = no slot, every active alert.
  const slot = q.get("all") === "1" ? null : forced !== null && /^[0-3]$/.test(forced) ? Number(forced) : undefined;
  try {
    return NextResponse.json(await runClientAlerts({ slot, dryRun: q.get("dry") === "1" }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
