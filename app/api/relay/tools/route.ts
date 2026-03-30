/**
 * GET /api/relay/tools
 * Server-side proxy for the relay tools list.
 */

import { NextResponse } from "next/server";

const rawRelayUrl = (process.env.NEXT_PUBLIC_RELAY_URL || "").trim();
const CONFIGURED_URL = rawRelayUrl
  ? rawRelayUrl.startsWith("http") ? rawRelayUrl : `https://${rawRelayUrl}`
  : null;

const RELAY_URLS = ["http://localhost:3457", ...(CONFIGURED_URL ? [CONFIGURED_URL] : [])];

export async function GET() {
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/tools`, {
        signal: AbortSignal.timeout(10000),
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
