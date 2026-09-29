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
  if (ran.outcome === "postponed") {
    return NextResponse.json({ error: "Exécution non lancée : le temps manque pour la mener à bien. Réessayez.", code: "postponed" }, { status: 409 });
  }
  if (ran.outcome !== "ran") {
    // The exact reason: a routine stopped or paused a moment ago is not « already running ».
    const reason = ran.outcome === "busy" ? ran.reason : "locked";
    const fresh = await getRoutine(routine.id);
    const stopped = ran.outcome === "busy" && ran.status === "error";
    const error = reason === "not_found" ? "Cette routine n'existe plus."
      : reason === "not_active"
        ? stopped ? "Cette routine vient d'être arrêtée après des échecs répétés : elle n'a pas été exécutée. Refaites un essai à blanc, puis activez-la."
          : "Cette routine n'est plus active (mise en pause, modifiée ou archivée entre-temps) : elle n'a pas été exécutée."
        : "Cette routine est déjà en cours d'exécution.";
    return NextResponse.json(
      { error, code: reason === "locked" || reason === "not_due" ? "busy" : reason, ...(fresh ? { routine: routineView(fresh) } : {}) },
      { status: reason === "not_found" ? 404 : 409 },
    );
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
