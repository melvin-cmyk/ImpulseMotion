/**
 * Activation of a routine — staff only.
 *
 * POST → ready, paused or error → active, and the next run is scheduled.
 *
 * Refused unless the last successful dry run covers the definition as it is
 * now (same hash). When the routine writes on an ad platform and
 * ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN=1, the person must really be an
 * administrator (baseRole), not a consultant.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireRealAdmin, requireStaff } from "@/lib/auth-helpers";
import { hashDefinition } from "@/lib/routines/hash";
import { computeNextRunAt } from "@/lib/routines/schedule";
import { writesPlatform } from "@/lib/routines/steps";
import { actorOf, getRoutine, logEvent, routineForSession, routineView, setStatus } from "@/lib/routines/store";
import { parseStoredDefinition, parseStoredSchedule } from "@/lib/routines/validate";
import { platformWriteNeedsAdmin } from "@/lib/routines/types";

const conflict = (error: string, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status: 409 });

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const found = await routineForSession(guard.session, (await params).id);
  if (found.status !== 200) return NextResponse.json({ error: found.status === 403 ? "forbidden" : "not found" }, { status: found.status });
  const { routine } = found;

  if (routine.status === "active") return conflict("Cette routine est déjà active.");
  if (routine.status !== "ready" && routine.status !== "paused" && routine.status !== "error") {
    return conflict(routine.status === "archived" ? "Cette routine est archivée." : "Cette routine n'a pas encore de définition.");
  }

  // What is stored is read again: the columns of the row are not taken at their word.
  const definition = parseStoredDefinition(routine.definitionJson);
  if (!definition.ok) return conflict("La définition enregistrée est refusée.", { errors: definition.errors });
  const schedule = parseStoredSchedule(routine.scheduleJson);
  if (!schedule.ok) return conflict("Le planning enregistré est refusé.", { errors: schedule.errors });
  const hash = hashDefinition({ definition: definition.value, schedule: schedule.value, maxItemsPerRun: routine.maxItemsPerRun });
  if (hash !== routine.definitionHash) return conflict("La définition enregistrée ne correspond plus à son empreinte : appliquez-la de nouveau.");
  if (!routine.dryRunHash) return conflict("Un essai à blanc réussi est demandé avant l'activation.", { code: "dry_run_required" });
  if (routine.dryRunHash !== hash) return conflict("La routine a changé depuis le dernier essai à blanc : refaites un essai avant de l'activer.", { code: "dry_run_outdated" });

  if (writesPlatform(definition.value.steps) && platformWriteNeedsAdmin()) {
    const admin = await requireRealAdmin();
    if ("error" in admin) {
      return NextResponse.json({ error: "Cette routine crée des publicités : seul un administrateur peut l'activer.", code: "admin_required" }, { status: 403 });
    }
  }

  const now = new Date();
  const nextRunAt = computeNextRunAt(schedule.value, routine.timezone, now);
  const actor = actorOf(guard.session);
  // Conditional on the hash the checks were made on: a definition applied meanwhile wins.
  const done = await setStatus(routine.id, ["ready", "paused", "error"], "active", {
    nextRunAt, activatedById: actor.userId, activatedAt: now, consecutiveFailures: 0,
  }, { definitionHash: hash, dryRunHash: hash });
  if (!done) return conflict("La routine a changé entre-temps : rechargez la page.");
  await logEvent(routine.id, "activated", actor, { definitionHash: hash, detail: nextRunAt ? `Prochaine exécution : ${nextRunAt.toISOString()}` : "Déclenchement manuel" });

  const fresh = await getRoutine(routine.id);
  return NextResponse.json({ ok: true, nextRunAt: nextRunAt ? nextRunAt.getTime() : null, routine: routineView(fresh ?? routine) });
}
