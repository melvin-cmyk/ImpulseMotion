/**
 * GET /api/pilot/history?clientId=…&platform=meta|google&accountId=…&days=60&refresh=1
 * The history of a client: the changes sent from Pilotage, the changes the
 * platforms' logs say anyone made, the day-by-day figures of the chosen
 * account (for the curve), and the state of the log reads. `refresh=1` reads
 * the logs now when they were not read in the last ten minutes.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { clientHistory, HISTORY_DAYS_DEFAULT } from "@/lib/pilot/history";
import { metaAccountDigits } from "@/lib/routines/accounts";
import { normGoogle } from "@/lib/portfolio";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const q = new URL(req.url).searchParams;
  const clientId = q.get("clientId") ?? "";
  if (!clientId) return NextResponse.json({ error: "Client manquant." }, { status: 400 });
  const platform = q.get("platform");
  const rawAccount = q.get("accountId") ?? "";
  const accountId = platform === "meta" ? metaAccountDigits(rawAccount) : platform === "google" ? normGoogle(rawAccount) : null;
  const focus = platform && accountId ? { platform, accountId } : null;
  const days = Number(q.get("days")) || HISTORY_DAYS_DEFAULT;
  try {
    const view = await clientHistory(guard.session, { alertClientIds: [clientId], focus, days, refresh: q.get("refresh") === "1" });
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[pilot] history unreadable", e);
    return NextResponse.json({ error: "L'historique n'a pas pu être lu." }, { status: 503 });
  }
}
