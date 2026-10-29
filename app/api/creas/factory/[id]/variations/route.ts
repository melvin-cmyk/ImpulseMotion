/**
 * POST /api/creas/factory/[id]/variations { assetIds? (default: the kept ones), persona?, season?, instructions?, perTemplate? (2) } (staff)
 *   → 201 { run, templates, error? } : a « variation » run on the kept visuals of this fabrique; its copies go through
 *   validation again (Fabrique tab, step 2), then each visual is made with the kept one as first reference.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveAlertClient, templateView } from "@/lib/creas/templates";
import { FactoryError, createVariationRun, loadRun } from "@/lib/creas/factory";

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const parent = await loadRun(id);
  if (!parent) return NextResponse.json({ error: "Fabrique introuvable." }, { status: 404 });
  const client = await resolveAlertClient(parent.alertClientId);
  if (!client) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const author = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { name: true, email: true } });
  const user = { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "", name: (author?.name ?? "").trim() || author?.email || "Consultant" };
  try {
    const out = await createVariationRun(parent, client, user, {
      assetIds: Array.isArray(body.assetIds) ? body.assetIds.filter((x): x is string => typeof x === "string").slice(0, 24) : undefined,
      perTemplate: typeof body.perTemplate === "number" ? body.perTemplate : undefined, persona: str(body.persona, 200), season: str(body.season, 200), instructions: str(body.instructions, 1500),
    });
    return NextResponse.json({ run: out.run, templates: out.templates.map((t) => templateView(t, guard.session.userId)), ...(out.error ? { error: out.error } : {}) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof FactoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
