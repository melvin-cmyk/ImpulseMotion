/**
 * POST /api/ads/demographics { accountId, adIds, range } — age × gender
 * breakdown of a creative's Meta ads over the period (Motion's demographic
 * breakdown). Staff only; the account must be in the viewer's scope.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { validateRange } from "@/lib/date-ranges";
import { getDemographics } from "@/lib/ads-warehouse/demographics";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const b = (await req.json().catch(() => ({}))) as { accountId?: string; adIds?: string[]; range?: { since?: string; until?: string } };
  const accountId = String(b.accountId ?? "").replace(/^act_/, "");
  const adIds = (b.adIds ?? []).map(String).filter((x) => /^\d{5,30}$/.test(x));
  if (!/^\d{5,25}$/.test(accountId) || !adIds.length) return NextResponse.json({ error: "compte ou annonces manquants" }, { status: 400 });
  const range = validateRange(b.range?.since ?? null, b.range?.until ?? null);
  if (!range.ok) return NextResponse.json({ error: range.error }, { status: 400 });
  const scope = await getAccountScope(guard.session);
  if (!platformAccountInScope(scope, "meta", accountId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    return NextResponse.json(await getDemographics(accountId, adIds, range.range), { headers: { "Cache-Control": "private, max-age=600" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Répartition indisponible" }, { status: 502 });
  }
}
