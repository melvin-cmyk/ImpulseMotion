/**
 * GET /api/pilot/targeting?clientId=…&accountId=…&adsetId=… — the targeting
 * of a Meta ad set as Meta holds it now, with the custom audiences of the
 * account, for the editor « Ciblage » of Pilotage (staff, account of the
 * client and of the scope). Read only.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveAccount } from "@/lib/pilot/service";
import { readCustomAudiences, readObject } from "@/lib/pilot/meta";
import { summarizeTargeting } from "@/lib/pilot/targeting";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const q = new URL(req.url).searchParams;
  const resolved = await resolveAccount(guard.session, q.get("clientId") ?? "", q.get("accountId") ?? "", "meta");
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  const adsetId = q.get("adsetId") ?? "";
  if (!/^\d{5,25}$/.test(adsetId)) return NextResponse.json({ error: "Ensemble de publicités invalide." }, { status: 400 });
  try {
    const [adset, audiences] = await Promise.all([readObject(adsetId, "adset"), readCustomAudiences(resolved.account.digits).catch(() => [])]);
    if (!adset || adset.accountId !== resolved.account.digits) return NextResponse.json({ error: "Cet ensemble n'appartient pas au compte." }, { status: 404 });
    let targeting: Record<string, unknown> = {};
    try { targeting = JSON.parse(adset.targeting ?? "{}"); } catch { targeting = {}; }
    return NextResponse.json({ targeting, summary: summarizeTargeting(targeting), audiences, adsetName: adset.name }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[pilot] targeting unreadable", e);
    return NextResponse.json({ error: "Le ciblage n'a pas pu être lu sur Meta : réessayez dans quelques minutes." }, { status: 503 });
  }
}
