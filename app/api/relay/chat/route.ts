/**
 * POST /api/relay/chat
 * Server-side proxy for the relay chat API.
 *
 * The browser only knows /api/relay/chat; the relay URL and shared secret
 * stay server-side. This proxy also enriches the request with the caller's
 * MCP permissions and ad-account ACL so the relay can scope the AI.
 */

import { HQ_SERVER, STAFF_MCP_SERVERS } from "@/lib/mcp-whitelist";
import { STAFF_CHAT_PROFILE } from "@/lib/ai-profiles";
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

  const isStaff = guard.session.role === "admin" || guard.session.role === "consultant";
  const enrichedBody = {
    ...body,
    // The browser never picks the model: staff chats with MCP tools run on
    // the staff profile (Opus 5, low effort); clients keep the relay default.
    model: isStaff ? STAFF_CHAT_PROFILE.model : undefined,
    effort: isStaff ? STAFF_CHAT_PROFILE.effort : undefined,
    maxTurns: undefined,
    allowedServers: isStaff
      ? [...STAFF_MCP_SERVERS]
      : allowedServers.filter((s) => s !== HQ_SERVER),
    accountScope: {
      meta: metaIds,
      google: googleIds,
      tiktok: tiktokIds,
      // Admins are business-manager wide (same rule as lib/scope.ts); everyone
      // else is confined by the relay to the ids listed above.
      unrestricted: guard.session.role === "admin",
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
