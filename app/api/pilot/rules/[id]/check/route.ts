/**
 * POST /api/pilot/rules/[id]/check → the figures of the rule's objects now and
 * which ones would fire. Reads only, nothing sent.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { checkRule } from "@/lib/pilot/rules";

export const maxDuration = 60;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const rule = await prisma.pilotRule.findUnique({ where: { id: (await params).id } });
  if (!rule || !platformAccountInScope(await getAccountScope(guard.session), rule.platform, rule.accountId)) return NextResponse.json({ error: "Règle introuvable." }, { status: 404 });
  try {
    return NextResponse.json({ checks: await checkRule(rule) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: `Lecture impossible : ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` }, { status: 503 });
  }
}
