/**
 * GET /api/relay/accounts — comptes Claude Max du pool (staff only) : libellé
 * et niveau d'utilisation, jamais les jetons. Sert le sélecteur « Compte »
 * des surfaces IA staff.
 */

import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/accounts`, { headers: relayHeaders(), signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const json = await res.json();
      const accounts = (Array.isArray(json.accounts) ? json.accounts : []).map((a: Record<string, unknown>) => ({
        id: String(a.id), label: String(a.label), level: typeof a.level === "number" ? a.level : null, fallbackActive: !!a.fallbackActive, usageVisible: a.usageVisible === false ? false : null,
        fiveHour: (a.fiveHour as { utilization?: number } | null)?.utilization ?? null, sevenDay: (a.sevenDay as { utilization?: number } | null)?.utilization ?? null,
      }));
      return NextResponse.json({ accounts, fallbackEnabled: !!json.fallbackEnabled }, { headers: { "Cache-Control": "no-store" } });
    } catch { /* next url */ }
  }
  return NextResponse.json({ error: "relay indisponible" }, { status: 502 });
}
