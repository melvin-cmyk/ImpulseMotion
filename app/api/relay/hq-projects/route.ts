/**
 * GET /api/relay/hq-projects — dossiers clients HQ (staff only), pour choisir
 * où consigner une note depuis la console. Liste servie par le relay avec son
 * jeton HQ (cache 10 min côté relay).
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
      const res = await fetch(`${url}/api/hq/projects`, { headers: relayHeaders(), signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const json = await res.json();
      return NextResponse.json({ projects: Array.isArray(json.projects) ? json.projects : [] });
    } catch { /* next url */ }
  }
  return NextResponse.json({ error: "relay indisponible" }, { status: 502 });
}
