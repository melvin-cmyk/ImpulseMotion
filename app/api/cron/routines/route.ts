/**
 * Cron of the routines — every 15 minutes (vercel.json).
 *
 * Takes the routines that are due, one by one, each under its lock: two
 * firings at the same instant run a routine once. Budget of 270 s under the
 * 300 s of the function; what is not reached stays due and is taken by the
 * next firing. A routine late by more than 12 hours is recorded as missed.
 */

import { NextRequest, NextResponse } from "next/server";
import { runLocked } from "@/lib/routines/engine";
import { dueRoutineIds } from "@/lib/routines/store";
import { RUN_BUDGET_MS } from "@/lib/routines/types";

export const maxDuration = 300;

/** No routine is started with less than this left. */
const MIN_START_MS = 20_000;
const MAX_PER_FIRING = 50;

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
  const deadlineAt = Date.now() + RUN_BUDGET_MS;
  const ids = await dueRoutineIds(new Date(), MAX_PER_FIRING);
  const runs: Array<{ routineId: string; outcome: string; status?: string; runId?: string; error?: string | null }> = [];
  let deferred = 0;

  for (const [i, routineId] of ids.entries()) {
    if (Date.now() > deadlineAt - MIN_START_MS) { deferred = ids.length - i; break; }
    try {
      const ran = await runLocked(routineId, { trigger: "schedule", now: new Date(), deadlineAt });
      if (ran.outcome === "ran") runs.push({ routineId, outcome: "ran", status: ran.result.status, runId: ran.result.runId, error: ran.result.error });
      else runs.push({ routineId, outcome: ran.outcome });
    } catch (e) {
      // One routine that cannot be run does not stop the others.
      console.error("[cron/routines]", routineId, e instanceof Error ? e.message : e);
      runs.push({ routineId, outcome: "error", error: e instanceof Error ? e.message.slice(0, 300) : "erreur inconnue" });
    }
  }

  return NextResponse.json({
    due: ids.length,
    ran: runs.filter((r) => r.outcome === "ran").length,
    missed: runs.filter((r) => r.outcome === "missed").length,
    skipped: runs.filter((r) => r.outcome === "busy").length,
    deferred,
    timedOut: deferred > 0,
    runs,
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
