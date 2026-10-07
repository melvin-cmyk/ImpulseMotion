/**
 * GET /api/pilot/clients — every client whose Meta or Google Ads accounts the
 * person may change from Pilotage (staff, accounts of their scope), dormant
 * ones included: a client with no recent spend is often the one to restart.
 */

import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { loadAlertClients } from "@/lib/auto-alerts/clients";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const scope = await getAccountScope(guard.session);
  try {
    const clients = await loadAlertClients(scope);
    return NextResponse.json({
      clients: clients
        .map((c) => ({ id: c.id, name: c.name, dormant: c.dormant, accounts: c.accounts.filter((a) => (a.platform === "meta" || a.platform === "google" || a.platform === "tiktok") && platformAccountInScope(scope, a.platform, a.accountId)) }))
        .filter((c) => c.accounts.length),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[pilot] clients unreadable", e);
    return NextResponse.json({ error: "La liste des clients n'a pas pu être lue." }, { status: 503 });
  }
}
