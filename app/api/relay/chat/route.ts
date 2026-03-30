/**
 * POST /api/relay/chat
 * Server-side proxy for the relay chat API.
 * The browser calls this relative URL (always reachable), and the server
 * forwards the request to the relay using localhost:3457 (direct, fast) or
 * the configured tunnel URL as fallback.
 *
 * This avoids CORS issues and expired Cloudflare tunnel URLs in the browser.
 */

import { NextRequest } from "next/server";

export const maxDuration = 120;

const rawRelayUrl = (process.env.NEXT_PUBLIC_RELAY_URL || "").trim();
const CONFIGURED_URL = rawRelayUrl
  ? rawRelayUrl.startsWith("http") ? rawRelayUrl : `https://${rawRelayUrl}`
  : null;

// Always try localhost first (relay runs on the same machine), then tunnel as fallback
const RELAY_URLS = ["http://localhost:3457", ...(CONFIGURED_URL ? [CONFIGURED_URL] : [])];

export async function POST(req: NextRequest) {
  const body = await req.json();

  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(100000),
        // @ts-expect-error Node.js fetch option
        duplex: "half",
      });

      if (!res.ok) continue;

      // Stream the relay response directly back to the client
      return new Response(res.body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Relay-URL": url,
        },
      });
    } catch (e) {
      console.log(`[relay/chat] ${url} failed:`, String(e));
    }
  }

  return new Response(
    JSON.stringify({ error: "All relay URLs failed" }),
    { status: 502, headers: { "Content-Type": "application/json" } }
  );
}
