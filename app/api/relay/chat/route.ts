/**
 * POST /api/relay/chat
 * Server-side proxy for the relay chat API (console /ai).
 *
 * The browser only knows /api/relay/chat; the relay URL and shared secret
 * stay server-side. Only whitelisted fields of the browser's body reach the
 * relay (messages with attachments, conversation id, model/effort for staff):
 * the MCP servers, the account scope, the system prompt and the provider are
 * decided here from the session and the caller's ACL.
 *
 * Staff (admin, consultant): ads servers within their scope, HQ read-only,
 * Google Sheets, web, and the Python sandbox whose workspace is the named
 * conversation (`console:<userId>:<conversationId>`, see ./files).
 * Clients: only the servers of their ACL, no HQ, no sandbox, no web.
 */

import { HQ_SERVER, SANDBOX_SERVER, STAFF_MCP_SERVERS } from "@/lib/mcp-whitelist";
import { STAFF_CHAT_PROFILE } from "@/lib/ai-profiles";
import { teeRelayStream, type RelayChatBody, type RelayEffort, type RelayModel } from "@/lib/relay-chat";
import { sanitizeThread, toRelayMessages } from "@/lib/relay-attachments";
import { recordAiUsage } from "@/lib/ai-usage";
import { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { getAllowedMcpServers, getAllowedAccountIds } from "@/lib/acl";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { buildConsoleSystemPrompt } from "@/lib/ai-tool-guidance";

export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The relay session budget already bounds a turn; the history the browser
// resends is only replayed when the relay starts a new session.
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 20000;
const STAFF_MAX_TURNS = 40;
const STAFF_BUDGET_MS = 280_000;
const MODELS = new Set<RelayModel>(["sonnet", "opus", "fable"]);
const EFFORTS = new Set<RelayEffort>(["low", "medium", "high"]);
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => ({}));
  const thread = sanitizeThread(body?.messages, { maxMessages: MAX_MESSAGES, maxChars: MAX_MESSAGE_CHARS });
  if (!thread) return new Response(JSON.stringify({ error: "messages invalid" }), { status: 400, headers: { "Content-Type": "application/json" } });
  const conversationId = typeof body?.conversationId === "string" && UUID_RE.test(body.conversationId) ? body.conversationId : null;

  const [allowedServers, metaIds, googleIds, tiktokIds] = await Promise.all([
    getAllowedMcpServers(guard.session.userId),
    getAllowedAccountIds(guard.session.userId, "meta"),
    getAllowedAccountIds(guard.session.userId, "google"),
    getAllowedAccountIds(guard.session.userId, "tiktok"),
  ]);

  const isStaff = guard.session.role === "admin" || guard.session.role === "consultant";
  const relayBody: RelayChatBody = {
    messages: toRelayMessages(thread),
    systemPrompt: isStaff ? buildConsoleSystemPrompt() : undefined,
    sessionKey: conversationId ? `console:${guard.session.userId}:${conversationId}` : undefined,
    // Staff pick the model and effort in the console (staff profile as the
    // fallback); clients keep the relay default.
    model: isStaff ? (MODELS.has(body?.model) ? body.model : STAFF_CHAT_PROFILE.model) : undefined,
    effort: isStaff ? (EFFORTS.has(body?.effort) ? body.effort : STAFF_CHAT_PROFILE.effort) : undefined,
    // Preferred Claude Max account of the pool ("auto" → the relay chooses).
    account: isStaff && typeof body?.account === "string" && ACCOUNT_RE.test(body.account) && body.account !== "auto" ? body.account : undefined,
    maxTurns: isStaff ? STAFF_MAX_TURNS : undefined,
    budgetMs: isStaff ? STAFF_BUDGET_MS : undefined,
    allowedServers: isStaff
      ? [...STAFF_MCP_SERVERS, ...(conversationId ? [SANDBOX_SERVER] : [])]
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

  for (const url of RELAY_URLS) {
    const isLocalhost = url.includes("localhost");
    const timeoutMs = isLocalhost ? 3000 : 100000;

    try {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: relayHeaders(),
        body: JSON.stringify(relayBody),
        signal: AbortSignal.timeout(timeoutMs),
        // @ts-expect-error Node.js fetch option
        duplex: "half",
      });

      if (!res.ok || !res.body) continue;

      const ledger = teeRelayStream(res.body, async (_text, _done, usage) => {
        if (usage) await recordAiUsage(usage, {
          feature: "console",
          clientName: "—",
          user: { id: guard.session.userId, email: guard.session.user?.email, role: guard.session.role },
        });
      });
      return new Response(ledger, {
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
