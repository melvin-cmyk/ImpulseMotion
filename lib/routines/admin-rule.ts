/**
 * Routines — who may put a routine that writes on an ad platform to work.
 *
 * With ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN=1, a routine that creates ads is
 * activated, resumed after a pause and run by hand by a real administrator
 * (baseRole) only. One rule, asked by the three routes: what a consultant
 * cannot activate, a consultant cannot resume or launch either.
 */

import { requireRealAdmin } from "@/lib/auth-helpers";
import { writesPlatform } from "@/lib/routines/steps";
import { parseStoredDefinition } from "@/lib/routines/validate";
import { platformWriteNeedsAdmin } from "@/lib/routines/types";

export type GatedAction = "activate" | "resume" | "run";

const VERB: Record<GatedAction, string> = { activate: "l'activer", resume: "la reprendre", run: "l'exécuter" };

export interface AdminRuleRefusal { status: 403; body: { error: string; code: "admin_required" } }

/**
 * Null when the person may go on, the 403 to answer otherwise. The routine is
 * read as it is stored: its `writesPlatform` column or its definition, either
 * says so.
 */
export async function adminRuleRefusal(
  routine: { writesPlatform: boolean; definitionJson: string }, action: GatedAction,
): Promise<AdminRuleRefusal | null> {
  if (!platformWriteNeedsAdmin()) return null;
  const definition = parseStoredDefinition(routine.definitionJson);
  const platform = routine.writesPlatform || (definition.ok && writesPlatform(definition.value.steps));
  if (!platform) return null;
  const admin = await requireRealAdmin();
  if (!("error" in admin)) return null;
  return { status: 403, body: { error: `Cette routine crée des publicités : seul un administrateur peut ${VERB[action]}.`, code: "admin_required" } };
}
