/** GET /api/admin/quota → admin: Claude Max utilisation + Bedrock fallback state, straight from the relay. */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const refresh = req.nextUrl.searchParams.get("refresh") === "1" ? "?refresh=1" : "";
  let lastError = "relay unreachable";
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/quota${refresh}`, { headers: relayHeaders(), signal: AbortSignal.timeout(url.includes("localhost") ? 3000 : 15000) });
      if (!res.ok) { lastError = `relay ${res.status}`; continue; }
      return NextResponse.json(await res.json(), { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return NextResponse.json({ error: lastError }, { status: 502 });
}
