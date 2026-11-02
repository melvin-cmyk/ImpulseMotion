/**
 * POST /api/ads/opportunities/:id/suggest — AI suggestion of an opportunity
 * (what attracts today + 3 concrete changes), generated through the relay and
 * stored. Staff only, account in scope.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { generateSuggestion, opportunityAccount } from "@/lib/ads-warehouse/opportunities-store";

export const maxDuration = 120;

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  const acc = await opportunityAccount(id);
  if (!acc) return NextResponse.json({ error: "opportunité inconnue" }, { status: 404 });
  const scope = await getAccountScope(guard.session);
  if (!platformAccountInScope(scope, acc.platform as never, acc.accountId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const suggestion = await generateSuggestion(id, { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "" });
    return NextResponse.json({ suggestion });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Suggestion impossible" }, { status: 502 });
  }
}
