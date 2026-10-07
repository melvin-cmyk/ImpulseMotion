/**
 * GET /api/pilot/creatives?clientId=…&accountId=… — the ads of a Meta account
 * of the client as creatives: last 7 full days against the 7 before, visual,
 * and what to look at (fatigue, spend without conversion, new winner). Staff,
 * scope. Read only.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveAccount } from "@/lib/pilot/service";
import { readCreatives } from "@/lib/pilot/creatives";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const q = new URL(req.url).searchParams;
  const resolved = await resolveAccount(guard.session, q.get("clientId") ?? "", q.get("accountId") ?? "", "meta");
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  try {
    return NextResponse.json(await readCreatives(resolved.account.digits), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[pilot] creatives unreadable", e);
    return NextResponse.json({ error: "Les créas n'ont pas pu être lues sur Meta : réessayez dans quelques minutes." }, { status: 503 });
  }
}
