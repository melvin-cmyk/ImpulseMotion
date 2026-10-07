/**
 * POST /api/pilot/changes/[id]/impact-now → the effect of a change read on the
 * platform, as of yesterday. Provisional: nothing stored. Staff, account in scope.
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
  const change = await prisma.platformChange.findUnique({ where: { id }, select: { platform: true, accountId: true } });
  if (!change || !platformAccountInScope(await getAccountScope(guard.session), change.platform, change.accountId)) return NextResponse.json({ error: "Modification introuvable." }, { status: 404 });
  const out = await impactNow({ kind: "change", id });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
}
