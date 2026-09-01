/** POST /api/reports/[id]/regenerate → staff: re-run generation on the same period. */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { generateClientReport } from "@/lib/report-generate";

export const maxDuration = 300;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const existing = await prisma.clientReport.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (existing.status === "generating") return NextResponse.json({ error: "génération déjà en cours" }, { status: 409 });

  try {
    await generateClientReport(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "génération échouée" }, { status: 502 });
  }
}
