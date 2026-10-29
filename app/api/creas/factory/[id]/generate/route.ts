/**
 * POST /api/creas/factory/[id]/generate → one pass of generation (staff), ≤ 12 images.
 *   First call (copies validated): { n, engine?, ratio?, textless? } — the quota is checked on the whole run (429 with a readable message).
 *   Next calls: {} — the browser calls again until `remaining` is 0.
 *   → { run, assets (made in this pass), remaining, failed, warn? }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveAlertClient } from "@/lib/creas/templates";
import { FactoryError, generatePass, loadRun } from "@/lib/creas/factory";

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const run = await loadRun(id);
  if (!run) return NextResponse.json({ error: "Fabrique introuvable." }, { status: 404 });
  const client = await resolveAlertClient(run.alertClientId);
  if (!client) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const author = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { name: true, email: true } });
  const user = { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "", name: (author?.name ?? "").trim() || author?.email || "Consultant" };
  try {
    const out = await generatePass(run, client, user, { n: typeof body.n === "number" ? body.n : undefined, engine: typeof body.engine === "string" ? body.engine : undefined, ratio: typeof body.ratio === "string" ? body.ratio : undefined, textless: body.textless === true });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof FactoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
