/**
 * GET /api/relay/tools
 * Server-side proxy for the relay tools list.
 */

import { NextResponse } from "next/server";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { requireSession } from "@/lib/auth-helpers";

export async function GET() {
  const authResult = await requireSession();
  if ("error" in authResult) return authResult.error;

  for (const url of RELAY_URLS) {
    const isLocalhost = url.includes("localhost");
    try {
      const res = await fetch(`${url}/api/tools`, {
        headers: relayHeaders(),
        signal: AbortSignal.timeout(isLocalhost ? 3000 : 10000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      return NextResponse.json(data);
    } catch (e) {
      console.log(`[relay/tools] ${url} failed:`, String(e));
    }
  }
  return NextResponse.json({ tools: [] }, { status: 502 });
}
