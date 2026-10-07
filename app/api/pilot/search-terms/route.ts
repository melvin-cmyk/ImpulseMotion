/**
 * GET /api/pilot/search-terms?clientId=…&accountId=…&days=30 — the search
 * terms of a Google Ads account of the client (staff, scope), highest spend
 * first, with their campaign and ad group so the page can add a negative
 * keyword or a keyword in one click. Read only.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveAccount } from "@/lib/pilot/service";
import { readSearchTerms } from "@/lib/pilot/search-terms";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const q = new URL(req.url).searchParams;
  const resolved = await resolveAccount(guard.session, q.get("clientId") ?? "", q.get("accountId") ?? "", "google");
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  const days = Math.min(Math.max(Number(q.get("days")) || 30, 7), 90);
  try {
    return NextResponse.json(await readSearchTerms(resolved.account.digits, days), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[pilot] search terms unreadable", e);
    return NextResponse.json({ error: "Les termes de recherche n'ont pas pu être lus : réessayez dans quelques minutes." }, { status: 503 });
  }
}
