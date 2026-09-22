/** POST /api/reports/[id]/regenerate { instructions? } → staff: re-run generation on
 *  the same period. New instructions replace the stored ones (empty string clears). */

import { getAccountScope, reportIdInScope } from "@/lib/scope";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { generateClientReport } from "@/lib/report-generate";

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  if (!(await reportIdInScope(await getAccountScope(guard.session), id))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const existing = await prisma.clientReport.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (existing.status === "generating") return NextResponse.json({ error: "génération déjà en cours" }, { status: 409 });

  const body = await req.json().catch(() => ({}));
  if (typeof body.instructions === "string") {
    await prisma.clientReport.update({ where: { id }, data: { instructions: body.instructions.trim().slice(0, 2000) || null } });
  }

  try {
    await generateClientReport(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "génération échouée" }, { status: 502 });
  }
}
