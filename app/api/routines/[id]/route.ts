/**
 * One routine — whoever has access to the routines (lib/routines/access.ts).
 *
 * GET    → the routine ({ routine }), with its health: how many live runs in
 *          a row were not a full success, the last error, and how many items
 *          wait for a person; and the names of the clients its steps name
 *          (`clientNames`, by id)
 * PATCH  → { name? } and/or { action: "pause" | "resume" | "archive" }
 *          pause   : active → paused, leaves the schedule
 *          resume  : paused → active, if the dry run still covers the routine
 *                    (definition, schedule, accounts, timezone). A routine
 *                    that creates ads is resumed by who may activate it.
 *          archive : any status → archived
 * DELETE → archives (nothing is ever deleted: the history is the audit trail)
 *
 * A routine switched off after three failures (status error) is not resumed:
 * it goes through a dry run and an activation again.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireRoutinesAccess } from "@/lib/routines/access";
import { adminRuleRefusal } from "@/lib/routines/admin-rule";
import { clientNamesOf } from "@/lib/routines/clients";
import { hashDefinition } from "@/lib/routines/hash";
import { computeNextRunAt } from "@/lib/routines/schedule";
import {
  actorOf, getRoutine, itemsToCheck, logEvent, renameRoutine, routineForSession, routineHealth, routineView, setStatus, type Actor, type RoutineRecord,
} from "@/lib/routines/store";
import { parseStoredDefinition, parseStoredSchedule, validateName } from "@/lib/routines/validate";

const NO_STORE = { "Cache-Control": "no-store" };
const NOT_FOUND = () => NextResponse.json({ error: "not found" }, { status: 404 });
const FORBIDDEN = () => NextResponse.json({ error: "forbidden" }, { status: 403 });
const conflict = (error: string) => NextResponse.json({ error }, { status: 409 });

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const guard = await requireRoutinesAccess();
  if ("error" in guard) return guard.error;
  const found = await routineForSession(guard.session, (await params).id);
  if (found.status !== 200) return found.status === 403 ? FORBIDDEN() : NOT_FOUND();
  const [health, toCheck, clientNames] = await Promise.all([
    routineHealth(found.routine.id).catch(() => null),
    itemsToCheck(found.routine.id).catch(() => []),
    clientNamesOf(found.routine.definitionJson).catch(() => ({})),
  ]);
  return NextResponse.json({
    routine: {
      ...routineView(found.routine),
      degradedRuns: health?.degradedRuns ?? 0, degradedAtLeast: health?.atLeast ?? false, degradedError: health?.lastError ?? null,
      itemsToCheck: toCheck.length, clientNames,
    },
  }, { headers: NO_STORE });
}

async function archive(routine: RoutineRecord, actor: Actor): Promise<void> {
  if (routine.status === "archived") return;
  const done = await setStatus(routine.id, ["draft", "ready", "active", "paused", "error"], "archived", { nextRunAt: null });
  if (done) await logEvent(routine.id, "archived", actor, { definitionHash: routine.definitionHash });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const guard = await requireRoutinesAccess();
  if ("error" in guard) return guard.error;
  const found = await routineForSession(guard.session, (await params).id);
  if (found.status !== 200) return found.status === 403 ? FORBIDDEN() : NOT_FOUND();
  const { routine } = found;
  const actor = actorOf(guard.session);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "corps de requête invalide" }, { status: 400 });
  const action = body.action;
  if (action !== undefined && action !== "pause" && action !== "resume" && action !== "archive") {
    return NextResponse.json({ error: "action inconnue (pause, resume ou archive)" }, { status: 400 });
  }
  if (body.name === undefined && action === undefined) return NextResponse.json({ error: "rien à modifier" }, { status: 400 });
  if (routine.status === "archived") return conflict("Cette routine est archivée.");

  // Asked before anything is changed: a refused resume does not rename the routine on its way.
  if (action === "resume") {
    const refused = await adminRuleRefusal(routine, "resume");
    if (refused) return NextResponse.json(refused.body, { status: refused.status });
  }

  if (body.name !== undefined) {
    const name = validateName(body.name);
    if (!name.ok) return NextResponse.json({ error: name.errors[0] }, { status: 400 });
    await renameRoutine(routine.id, name.value);
  }

  if (action === "pause") {
    if (!(await setStatus(routine.id, ["active"], "paused", { nextRunAt: null }))) return conflict("Seule une routine active peut être mise en pause.");
    await logEvent(routine.id, "paused", actor, { definitionHash: routine.definitionHash });
  } else if (action === "resume") {
    if (routine.status === "error") return conflict("Routine arrêtée après des échecs répétés : refaites un essai à blanc, puis activez-la.");
    if (routine.status !== "paused") return conflict("Seule une routine en pause peut être reprise.");
    if (!routine.dryRunHash || routine.dryRunHash !== routine.definitionHash) return conflict("La définition a changé depuis le dernier essai à blanc : refaites un essai, puis activez la routine.");
    const schedule = parseStoredSchedule(routine.scheduleJson);
    if (!schedule.ok) return conflict(schedule.errors[0]);
    const definition = parseStoredDefinition(routine.definitionJson);
    if (!definition.ok) return conflict("La définition enregistrée est refusée : appliquez-la de nouveau.");
    const hash = hashDefinition({
      definition: definition.value, schedule: schedule.value, maxItemsPerRun: routine.maxItemsPerRun,
      metaAccountId: routine.metaAccountId, googleCustomerId: routine.googleCustomerId, timezone: routine.timezone,
    });
    if (hash !== routine.definitionHash) return conflict("La définition, les comptes ou le fuseau ont changé depuis le dernier essai à blanc : appliquez la définition de nouveau, refaites un essai, puis activez la routine.");
    const nextRunAt = computeNextRunAt(schedule.value, routine.timezone, new Date());
    if (!(await setStatus(routine.id, ["paused"], "active", { nextRunAt, consecutiveFailures: 0 }))) return conflict("La routine a changé d'état entre-temps.");
    await logEvent(routine.id, "resumed", actor, { definitionHash: routine.definitionHash });
  } else if (action === "archive") {
    await archive(routine, actor);
  }

  const fresh = await getRoutine(routine.id);
  return NextResponse.json({ ok: true, routine: routineView(fresh ?? routine) });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const guard = await requireRoutinesAccess();
  if ("error" in guard) return guard.error;
  const found = await routineForSession(guard.session, (await params).id);
  if (found.status !== 200) return found.status === 403 ? FORBIDDEN() : NOT_FOUND();
  await archive(found.routine, actorOf(guard.session));
  return NextResponse.json({ ok: true });
}
