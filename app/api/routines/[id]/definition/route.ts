/**
 * Applies a definition to a routine — staff only.
 *
 * POST { proposal } (or the proposal itself as the body)
 *
 * Nothing an AI proposes is stored as it comes:
 *   1. validateProposal rebuilds the proposal field by field;
 *   2. each step runs its preflight, which really looks (header of the Sheet,
 *      campaign and ad set in the account of the routine);
 *   3. with no blocking issue, the definition is stored, the routine goes
 *      back to `ready` and its previous dry run is forgotten.
 *
 * 400 → the proposal is invalid ({ errors })
 * 422 → a preflight found a blocking issue, nothing was stored ({ issues })
 * 200 → stored ({ routine, issues }) — the issues left are warnings
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { handlerFor, writesPlatform } from "@/lib/routines/steps";
import { actorOf, applyDefinition, getRoutine, routineForSession, routineView } from "@/lib/routines/store";
import { validateProposal } from "@/lib/routines/validate";
import type { PreflightIssue, StepContext } from "@/lib/routines/types";

export const maxDuration = 60;

const PREFLIGHT_TIMEOUT_MS = 20_000;

/** A preflight that cannot look blocks too: an unchecked definition is not applied. */
async function preflightStep(step: Parameters<typeof handlerFor>[0], routine: StepContext["routine"]): Promise<PreflightIssue[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), PREFLIGHT_TIMEOUT_MS); });
    const issues = await Promise.race([handlerFor(step).preflight(step, routine), timeout]);
    if (issues === "timeout") return [{ stepId: step.id, severity: "error", message: "Vérification impossible : pas de réponse à temps. Réessayez dans un instant." }];
    return (Array.isArray(issues) ? issues : [])
      .filter((i) => i && typeof i.message === "string")
      .map((i) => ({ stepId: step.id, severity: i.severity === "warning" ? "warning" : "error", message: i.message.slice(0, 500) }));
  } catch (e) {
    const reason = e instanceof Error ? e.message.slice(0, 300) : "erreur inconnue";
    return [{ stepId: step.id, severity: "error", message: `Vérification impossible : ${reason}` }];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const found = await routineForSession(guard.session, (await params).id);
  if (found.status !== 200) return NextResponse.json({ error: found.status === 403 ? "forbidden" : "not found" }, { status: found.status });
  const { routine } = found;
  if (routine.status === "archived") return NextResponse.json({ error: "Cette routine est archivée." }, { status: 409 });
  if (routine.lockedUntil && routine.lockedUntil.getTime() > Date.now()) {
    return NextResponse.json({ error: "La routine est en cours d'exécution : réessayez quand elle aura terminé." }, { status: 409 });
  }

  const body = await req.json().catch(() => null);
  const checked = validateProposal(body && typeof body === "object" && "proposal" in body ? body.proposal : body);
  if (!checked.ok) return NextResponse.json({ error: "proposition invalide", errors: checked.errors }, { status: 400 });
  const proposal = checked.value;

  const target: StepContext["routine"] = {
    id: routine.id, name: proposal.name, metaAccountId: routine.metaAccountId, googleCustomerId: routine.googleCustomerId,
    timezone: routine.timezone, maxItemsPerRun: proposal.maxItemsPerRun,
  };
  const issues = (await Promise.all(proposal.definition.steps.map((step) => preflightStep(step, target)))).flat();
  if (issues.some((i) => i.severity === "error")) {
    return NextResponse.json({ error: "vérification préalable en échec", issues }, { status: 422 });
  }

  const definitionHash = await applyDefinition(routine.id, {
    name: proposal.name, description: proposal.description, schedule: proposal.schedule,
    definition: proposal.definition, maxItemsPerRun: proposal.maxItemsPerRun,
    writesPlatform: writesPlatform(proposal.definition.steps),
  }, actorOf(guard.session));
  if (!definitionHash) return NextResponse.json({ error: "Cette routine est archivée." }, { status: 409 });

  const fresh = await getRoutine(routine.id);
  return NextResponse.json({ ok: true, definitionHash, issues, routine: routineView(fresh ?? routine) });
}
