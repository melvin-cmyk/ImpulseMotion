/**
 * One fabrique (staff): GET → { run (with copies), assets, templates, feedback }.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { assetView } from "@/lib/studio-assets";
import { templateView } from "@/lib/creas/templates";
import { parseIdList } from "@/lib/creas/model";
import { listFeedback, loadRun, loadRunTemplates, runAssets, runCopies, runView } from "@/lib/creas/factory";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const run = await loadRun(id);
  if (!run) return NextResponse.json({ error: "Fabrique introuvable." }, { status: 404 });
  const [copies, assets, templates, feedback] = await Promise.all([runCopies(run.id), runAssets(run.id), loadRunTemplates(parseIdList(run.templateIdsJson)), listFeedback({ runId: run.id })]);
  return NextResponse.json({ run: runView(run, copies), assets: assets.map((a) => assetView(a, guard.session.userId)), templates: templates.map((t) => templateView(t, guard.session.userId)), feedback }, { headers: { "Cache-Control": "no-store" } });
}
