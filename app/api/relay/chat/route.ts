/**
 * POST /api/relay/chat → starts a detached turn of the console (/ai).
 *   body { messages, conversationId, model?, effort?, account? }  →  202 { jobId }
 *
 * The browser only knows /api/relay/chat; the relay URL and shared secret
 * stay server-side. Only whitelisted fields of the browser's body reach the
 * relay (messages with attachments, conversation id, model/effort for staff):
 * the MCP servers, the account scope, the system prompt and the provider are
 * decided here from the session and the caller's ACL.
 *
 * The turn runs in the relay whatever the browser does next; it is followed
 * through GET /api/ai/jobs/[jobId]/events. The user message is written to
 * the conversation here, the answer by lib/ai-jobs.ts when the job ends —
 * the browser no longer stores the thread itself.
 *
 * Staff (admin, consultant): ads servers within their scope, HQ read-only,
 * Google Sheets, web, and the Python sandbox whose workspace is the named
 * conversation (`console:<userId>:<conversationId>`, see ./files).
 * Clients: only the servers of their ACL, no HQ, no sandbox, no web.
 */

import { CLIENT_DATA_SERVER, HQ_SERVER, SANDBOX_SERVER, STAFF_MCP_SERVERS } from "@/lib/mcp-whitelist";
import { listStaffDataClients, staffDataClientsLine, staffDataScopeForAll } from "@/lib/staff-data-scope";
import { STAFF_CHAT_PROFILE } from "@/lib/ai-profiles";
import type { RelayChatBody, RelayEffort, RelayModel } from "@/lib/relay-chat";
import { sanitizeThread, toRelayMessages } from "@/lib/relay-attachments";
import { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { getAllowedMcpServers, getAllowedAccountIds } from "@/lib/acl";
import { buildConsoleSystemPrompt } from "@/lib/ai-tool-guidance";
import { appendConsoleMessages, runningJobOf, startAiJob } from "@/lib/ai-jobs";
import { isConversationId, type StoredConsoleMessage } from "@/lib/console-conversations";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The relay session budget already bounds a turn; the history the browser
// resends is only replayed when the relay starts a new session.
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 20000;
const STAFF_MAX_TURNS = 40;
/** Detached: no serverless function holds the stream, the relay caps it (15 min). */
const STAFF_BUDGET_MS = 14 * 60_000;
const MODELS = new Set<RelayModel>(["sonnet", "opus", "fable"]);
const EFFORTS = new Set<RelayEffort>(["low", "medium", "high"]);
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
/** Hidden user turns (automatic relaunch after a time-budget cut) are not stored. */
const AUTO_CONTINUE_PREFIX = "[Poursuite automatique]";

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => ({}));
  const thread = sanitizeThread(body?.messages, { maxMessages: MAX_MESSAGES, maxChars: MAX_MESSAGE_CHARS });
  if (!thread) return json({ error: "messages invalid" }, 400);
  const conversationId = typeof body?.conversationId === "string" && UUID_RE.test(body.conversationId) ? body.conversationId : null;
  if (!conversationId || !isConversationId(conversationId)) return json({ error: "conversationId requis" }, 400);
  const last = thread[thread.length - 1];
  if (last.role !== "user") return json({ error: "le dernier message doit être celui du consultant" }, 400);

  const running = await runningJobOf(conversationId, guard.session.userId);
  if (running) return json({ error: "Une réponse est déjà en cours sur cette conversation. Attendez qu'elle soit terminée avant d'envoyer la suite.", jobId: running.id }, 409);

  const [allowedServers, metaIds, googleIds, tiktokIds] = await Promise.all([
    getAllowedMcpServers(guard.session.userId),
    getAllowedAccountIds(guard.session.userId, "meta"),
    getAllowedAccountIds(guard.session.userId, "google"),
    getAllowedAccountIds(guard.session.userId, "tiktok"),
  ]);

  const isStaff = guard.session.role === "admin" || guard.session.role === "consultant";
  // Warehouses the staff may read (e-commerce orders, dropped files), as a
  // closed list of client keys pinned by the relay.
  const dataClients = isStaff ? await listStaffDataClients() : [];
  const dataScope = isStaff ? await staffDataScopeForAll() : undefined;
  const relayBody: RelayChatBody = {
    messages: toRelayMessages(thread),
    systemPrompt: isStaff ? buildConsoleSystemPrompt(guard.session.user?.email ?? null, staffDataClientsLine(dataClients)) : undefined,
    // The staff prompt teaches HQ itself (reads, and writes on request).
    hqGuidance: isStaff ? "caller" : undefined,
    sessionKey: `console:${guard.session.userId}:${conversationId}`,
    // Staff pick the model and effort in the console (staff profile as the
    // fallback); clients keep the relay default.
    model: isStaff ? (MODELS.has(body?.model) ? body.model : STAFF_CHAT_PROFILE.model) : undefined,
    effort: isStaff ? (EFFORTS.has(body?.effort) ? body.effort : STAFF_CHAT_PROFILE.effort) : undefined,
    // Preferred Claude Max account of the pool ("auto" → the relay chooses).
    account: isStaff && typeof body?.account === "string" && ACCOUNT_RE.test(body.account) && body.account !== "auto" ? body.account : undefined,
    maxTurns: isStaff ? STAFF_MAX_TURNS : undefined,
    budgetMs: isStaff ? STAFF_BUDGET_MS : undefined,
    allowedServers: isStaff
      ? [...STAFF_MCP_SERVERS, SANDBOX_SERVER, ...(dataScope ? [CLIENT_DATA_SERVER] : [])]
      : allowedServers.filter((s) => s !== HQ_SERVER),
    ...(dataScope ? { dataScope } : {}),
    accountScope: {
      meta: metaIds,
      google: googleIds,
      tiktok: tiktokIds,
      // Admins are business-manager wide (same rule as lib/scope.ts); everyone
      // else is confined by the relay to the ids listed above.
      unrestricted: guard.session.role === "admin",
    },
  };

  // The question joins the stored thread now (image pixels left out, file
  // notes kept); an automatic relaunch is not a message of the consultant.
  if (!last.content.startsWith(AUTO_CONTINUE_PREFIX)) {
    const stored: StoredConsoleMessage = {
      id: typeof body?.messageId === "string" ? body.messageId.slice(0, 80) : `u-${Date.now().toString(36)}`,
      role: "user",
      content: last.content,
      ...(last.images?.length ? { images: last.images.map((im) => ({ mediaType: im.mediaType, data: "" as const, ...(im.name ? { name: im.name } : {}) })) } : {}),
      ...(last.files?.length ? { files: last.files } : {}),
    };
    await appendConsoleMessages(conversationId, guard.session.userId, [stored]);
  }

  const started = await startAiJob({
    relayBody,
    surface: "console",
    userId: guard.session.userId,
    conversationId,
    title: last.content.startsWith(AUTO_CONTINUE_PREFIX) ? "Poursuite de la tâche" : last.content,
    usageContext: {
      feature: "console",
      clientName: "—",
      user: { id: guard.session.userId, email: guard.session.user?.email, role: guard.session.role },
    },
  });
  if ("error" in started) {
    await appendConsoleMessages(conversationId, guard.session.userId, [{ id: `e-${Date.now().toString(36)}`, role: "assistant", content: `**Erreur de connexion :** ${started.error}` }]);
    return json({ error: started.error }, 502);
  }
  return json({ jobId: started.jobId, conversationId }, 202);
}
