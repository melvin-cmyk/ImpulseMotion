/**
 * PATCH /api/ads/opportunities/:id — { status?: active|completed|archived,
 * aiScore?: 1|-1|null } (Motion: mark as completed, archive / restore, rate the
 * AI suggestion). Staff only, account in scope.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { opportunityAccount, updateOpportunity } from "@/lib/ads-warehouse/opportunities-store";
import type { OpportunityStatus } from "@/lib/ads-warehouse/opportunities";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  const acc = await opportunityAccount(id);
  if (!acc) return NextResponse.json({ error: "opportunité inconnue" }, { status: 404 });
  const scope = await getAccountScope(guard.session);
  if (!platformAccountInScope(scope, acc.platform as never, acc.accountId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { status?: string; aiScore?: number | null };
  const patch: { status?: OpportunityStatus; aiScore?: number | null } = {};
  if (body.status !== undefined) {
    if (!["active", "completed", "archived"].includes(body.status)) return NextResponse.json({ error: "statut invalide" }, { status: 400 });
    patch.status = body.status as OpportunityStatus;
  }
  if (body.aiScore !== undefined) {
    if (body.aiScore !== null && body.aiScore !== 1 && body.aiScore !== -1) return NextResponse.json({ error: "note invalide" }, { status: 400 });
    patch.aiScore = body.aiScore;
  }
  const who = { id: guard.session.userId, name: guard.session.user?.name ?? guard.session.user?.email ?? "" };
  return NextResponse.json(await updateOpportunity(id, patch, who));
}
