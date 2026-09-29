/**
 * Dry run of a routine — staff only.
 *
 * POST → runs every step without writing anything: `ctx.write` is null, no
 *        item is reserved, and what would have been written comes back in
 *        `planned`. A successful dry run is remembered with the hash of the
 *        definition it ran (dryRunHash): activation asks for it.
 *
 *        A dry run that found nothing to create, for a routine that creates
 *        ads, still opens the activation (a routine of « new rows » has an
 *        empty Sheet on some days), and says so loudly: `warning`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { compactResult, runRoutine } from "@/lib/routines/engine";
import { countsText } from "@/lib/routines/counts";
import { actorOf, getRoutine, recordDryRun, routineForSession, routineView } from "@/lib/routines/store";
import { RUN_BUDGET_MS } from "@/lib/routines/types";

export const maxDuration = 300;

/** Rows of each step sent back to the browser. */
const PREVIEW_ROWS = 50;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const found = await routineForSession(guard.session, (await params).id);
  if (found.status !== 200) return NextResponse.json({ error: found.status === 403 ? "forbidden" : "not found" }, { status: found.status });
  const { routine } = found;
  if (routine.status === "archived") return NextResponse.json({ error: "Cette routine est archivée." }, { status: 409 });
  if (routine.status === "draft" || !routine.definitionHash) {
    return NextResponse.json({ error: "Cette routine n'a pas encore de définition." }, { status: 409 });
  }

  const now = new Date();
  const result = await runRoutine(routine, {
    mode: "dry_run", trigger: "dry_run", startedById: guard.session.userId,
    now, deadlineAt: now.getTime() + RUN_BUDGET_MS,
  });
  // The hash is the one of the definition that ran: changed meanwhile, it will not match at activation.
  if (result.status === "success") {
    // By nature of write, as the history shows them: ads, rows of a Sheet and messages are not added up.
    const seen = countsText(result.counts, "dry_run");
    await recordDryRun(routine.id, result.definitionHash, now, actorOf(guard.session), [seen, ...result.warnings].join(" — "));
  }

  const fresh = await getRoutine(routine.id);
  return NextResponse.json({
    ok: result.status === "success",
    warning: result.warnings[0] ?? null,
    warnings: result.warnings,
    result: compactResult(result, PREVIEW_ROWS),
    routine: routineView(fresh ?? routine),
  });
}
