/**
 * Cron of the pilotage impacts — once a day (vercel.json, 06:40 UTC): the J+7
 * and J+14 analyses of the changes sent from /pilotage, written in the page
 * and in the client's HQ (lib/pilot/impact-run.ts). No AI, no token.
 *
 * Emergency stop: PILOT_IMPACT_CRON=off.
 */

import { NextRequest, NextResponse } from "next/server";
import { runPilotImpacts } from "@/lib/pilot/impact-run";

export const maxDuration = 300;

function checkCronAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed: no secret configured → deny
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.PILOT_IMPACT_CRON?.trim().toLowerCase() === "off") return NextResponse.json({ stopped: true });
  try {
    const summary = await runPilotImpacts();
    console.log("[pilot-impact] pass", JSON.stringify(summary));
    return NextResponse.json(summary);
  } catch (e) {
    console.error("[pilot-impact] pass failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
