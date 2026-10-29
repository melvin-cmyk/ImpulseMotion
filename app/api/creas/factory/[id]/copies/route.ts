/**
 * The copies of a fabrique (staff).
 *   PATCH { copies?: [{ id, status?: approved|rejected|proposed, headline?, subline?, cta? }], feedback?: string, repropose?: true }
 *   → { run (with copies), hq? } — `feedback` is kept as a run-level CreativeFeedback (and journaled in HQ);
 *   `repropose` asks the AI again (approved copies stay).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveAlertClient } from "@/lib/creas/templates";
import { parseIdList } from "@/lib/creas/model";
import { FactoryError, addFeedback, loadRun, loadRunTemplates, proposeCopies, runCopies, runView, updateCopies, type CopyPatch } from "@/lib/creas/factory";

export const maxDuration = 300;

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const run = await loadRun(id);
  if (!run) return NextResponse.json({ error: "Fabrique introuvable." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const author = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { name: true, email: true } });
  const user = { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "", name: (author?.name ?? "").trim() || author?.email || "Consultant" };
  try {
    const patches: CopyPatch[] = (Array.isArray(body.copies) ? body.copies : []).filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof c.id === "string").map((c) => ({
      id: c.id as string, ...(c.status === "approved" || c.status === "rejected" || c.status === "proposed" ? { status: c.status } : {}),
      ...(typeof c.headline === "string" ? { headline: c.headline } : {}), ...(typeof c.subline === "string" ? { subline: c.subline } : {}), ...(typeof c.cta === "string" ? { cta: c.cta } : {}),
    }));
    let copies = patches.length ? await updateCopies(run, patches) : await runCopies(run.id);
    let hq: { ok: boolean; error?: string } | undefined;
    const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
    if (feedback) {
      const client = await resolveAlertClient(run.alertClientId);
      if (client) hq = (await addFeedback(client, user, { level: "run", runId: run.id, text: feedback })).hq;
    }
    let error: string | undefined;
    if (body.repropose === true) {
      if (run.status !== "copy_review") throw new FactoryError(409, "Les copys ne se reproposent plus une fois la génération lancée.");
      const out = await proposeCopies(run, await loadRunTemplates(parseIdList(run.templateIdsJson)), user);
      copies = out.copies; error = out.error;
    }
    const fresh = (await loadRun(run.id)) ?? run;
    return NextResponse.json({ run: runView(fresh, copies), ...(hq ? { hq } : {}), ...(error ? { error } : {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof FactoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
