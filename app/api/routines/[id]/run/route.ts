/**
 * "Run now" — staff only.
 *
 * POST → one live run of an active routine, under the same lock as the cron:
 *        a routine that is already running answers 409 and nothing starts.
 *        The schedule is left as it is. A routine that creates ads is run
 *        by who may activate it (ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { adminRuleRefusal } from "@/lib/routines/admin-rule";
import { compactResult, runLocked } from "@/lib/routines/engine";
import { actorOf, getRoutine, logEvent, routineForSession, routineView } from "@/lib/routines/store";
import { RUN_BUDGET_MS } from "@/lib/routines/types";

export const maxDuration = 300;

const PREVIEW_ROWS = 50;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const found = await routineForSession(guard.session, (await params).id);
  if (found.status !== 200) return NextResponse.json({ error: found.status === 403 ? "forbidden" : "not found" }, { status: found.status });
  const { routine } = found;
  if (routine.status !== "active") {
    return NextResponse.json({ error: "Seule une routine active peut être exécutée : faites un essai à blanc, puis activez-la." }, { status: 409 });
  }

  const refused = await adminRuleRefusal(routine, "run");
  if (refused) return NextResponse.json(refused.body, { status: refused.status });

  const now = new Date();
  const ran = await runLocked(routine.id, {
    trigger: "manual", startedById: guard.session.userId, now, deadlineAt: now.getTime() + RUN_BUDGET_MS,
  });
  if (ran.outcome !== "ran") {
    return NextResponse.json({ error: "Cette routine est déjà en cours d'exécution.", code: "busy" }, { status: 409 });
  }
  await logEvent(routine.id, "run_manual", actorOf(guard.session), {
    definitionHash: ran.result.definitionHash, detail: `Exécution ${ran.result.runId} : ${ran.result.status}`,
  });

  const fresh = await getRoutine(routine.id);
  return NextResponse.json({
    ok: ran.result.status === "success",
    result: compactResult(ran.result, PREVIEW_ROWS),
    routine: routineView(fresh ?? routine),
  });
}
