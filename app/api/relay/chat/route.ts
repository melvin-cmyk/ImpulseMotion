/**
 * POST /api/relay/chat
 * Server-side proxy for the relay chat API.
 *
 * The browser only knows /api/relay/chat; the relay URL and shared secret
 * stay server-side. This proxy also enriches the request with the caller's
 * MCP permissions and ad-account ACL so the relay can scope the AI.
 */

import { MCP_SERVER_WHITELIST } from "@/lib/mcp-whitelist";
import { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { getAllowedMcpServers, getAllowedAccountIds } from "@/lib/acl";

export const maxDuration = 120;

import { RELAY_URLS } from "@/lib/relay-server";

const RELAY_SECRET = process.env.RELAY_SHARED_SECRET || "";

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const body = await req.json();

  const [allowedServers, metaIds, googleIds, tiktokIds] = await Promise.all([
    getAllowedMcpServers(guard.session.userId),
    getAllowedAccountIds(guard.session.userId, "meta"),
    getAllowedAccountIds(guard.session.userId, "google"),
    getAllowedAccountIds(guard.session.userId, "tiktok"),
  ]);

  const enrichedBody = {
    ...body,
    allowedServers: guard.session.role === "admin" || guard.session.role === "consultant"
      ? [...MCP_SERVER_WHITELIST]
      : allowedServers,
    accountScope: {
      meta: metaIds,
      google: googleIds,
      tiktok: tiktokIds,
    },
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (RELAY_SECRET) headers.Authorization = `Bearer ${RELAY_SECRET}`;

  for (const url of RELAY_URLS) {
    const isLocalhost = url.includes("localhost");
    const timeoutMs = isLocalhost ? 3000 : 100000;

    try {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(enrichedBody),
        signal: AbortSignal.timeout(timeoutMs),
        // @ts-expect-error Node.js fetch option
        duplex: "half",
      });

      if (!res.ok) continue;

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
