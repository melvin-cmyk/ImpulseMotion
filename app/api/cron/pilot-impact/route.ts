/**
 * Cron of the pilotage impacts — once a day (vercel.json, 06:40 UTC): the J+7
 * and J+14 analyses of the changes sent from /pilotage, written in the page
 * and in the client's HQ (lib/pilot/impact-run.ts). Before them, the
 * platforms' change logs of every account are read (lib/pilot/changes-ingest.ts),
 * so changes made outside Pilotage are judged too. No AI, no token.
 *
 * Emergency stop: PILOT_IMPACT_CRON=off.
 */

import { NextRequest, NextResponse } from "next/server";
import { runPilotImpacts } from "@/lib/pilot/impact-run";
import { runChangesIngest } from "@/lib/pilot/changes-ingest";
import { recoverStale } from "@/lib/pilot/service";

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
    // Sends cut short (function killed) are closed even when nobody opens the journal.
    await recoverStale().catch((e) => console.error("[pilot-impact] stale sends not recovered", e));
    const ingest = await runChangesIngest(90_000).catch((e) => { console.error("[pilot-impact] ingest failed", e); return null; });
    const summary = await runPilotImpacts();
    console.log("[pilot-impact] pass", JSON.stringify({ ingest, ...summary }));
    return NextResponse.json({ ingest, ...summary });
  } catch (e) {
    console.error("[pilot-impact] pass failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
