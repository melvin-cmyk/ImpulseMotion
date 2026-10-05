/**
 * GET /api/pilot/ad-identities?clientId=…&accountId=… — the Pages the Meta ad
 * account may promote and its Instagram accounts, for the form « Nouvelle
 * publicité » of Pilotage (staff, account of the client and of the scope).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveAccount } from "@/lib/pilot/service";
import { adIdentities } from "@/lib/pilot/new-ad";

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const q = new URL(req.url).searchParams;
  const resolved = await resolveAccount(guard.session, q.get("clientId") ?? "", q.get("accountId") ?? "", "meta");
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  try {
    return NextResponse.json(await adIdentities(resolved.account.digits), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[pilot] ad identities unreadable", e);
    return NextResponse.json({ error: "Les Pages du compte n'ont pas pu être lues : réessayez dans quelques minutes." }, { status: 503 });
  }
}
