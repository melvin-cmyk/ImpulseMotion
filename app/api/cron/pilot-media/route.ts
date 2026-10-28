/**
 * Media pass of the Pilotage — the videos sent to Meta ahead of an ad creation
 * are processed asynchronously by Meta: this pass reads where they are and
 * finishes the creations that waited for them (lib/pilot/service.ts
 * runPilotMediaPass), then closes the actions and writes HQ, once.
 *
 * Meant to fire every two minutes. The project's Vercel plan refuses a cron
 * that fires more than once a day (and then creates no deployment at all), so
 * this route is called by a systemd timer on the VPS
 * (deploy/impulsemotion-pilot-media.{service,timer}) with the CRON_SECRET; the
 * hourly routines cron and the page that waits for a creation call the same
 * pass as backstops.
 *
 * Emergency stop: PILOT_MEDIA_CRON=off.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { runPilotMediaPass } from "@/lib/pilot/service";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.PILOT_MEDIA_CRON?.trim().toLowerCase() === "off") return NextResponse.json({ stopped: true });
  try {
    const summary = await runPilotMediaPass(new Date(), 45_000);
    if (summary.checked || summary.created || summary.refused) console.log("[pilot-media] pass", JSON.stringify(summary));
    return NextResponse.json(summary);
  } catch (e) {
    console.error("[pilot-media] pass failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
