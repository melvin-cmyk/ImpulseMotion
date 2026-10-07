/**
 * POST /api/pilot/actions/[id]/impact-now → the effect of a sent change as of
 * yesterday (every full day since, at most 14, against as many before).
 * Provisional: nothing stored, nothing written in HQ. Staff, account in scope.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { impactNow } from "@/lib/pilot/impact-run";

export const maxDuration = 60;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const action = await prisma.pilotAction.findUnique({ where: { id }, select: { platform: true, accountId: true } });
  if (!action || !platformAccountInScope(await getAccountScope(guard.session), action.platform, action.accountId)) return NextResponse.json({ error: "Modification introuvable." }, { status: 404 });
  const out = await impactNow({ kind: "action", id });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
}
