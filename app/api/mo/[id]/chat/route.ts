/**
 * POST /api/mo/[id]/chat → one turn of Mo on this board, detached (lib/ai-jobs).
 *   body { message, model?, effort?, account?, page? } → 202 { jobId }
 *   `page` = the path the person is on (sent by the orb present on every page), so
 *   "ouvre l'analyse de ce client" resolves against the page.
 *
 * Staff tool belt (same as the console: ads servers within the ACL scope, HQ,
 * Sheets, web, sandbox, client warehouses); the session is resumed per board
 * so a follow-up ("compare avec la semaine d'avant") costs only the new
 * message. The answer is parsed into cards when the job ends.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAllowedAccountIds } from "@/lib/acl";
import { getAccountScope } from "@/lib/scope";
import { listClientRegistry } from "@/lib/clients/registry";
import { CLIENT_DATA_SERVER, SANDBOX_SERVER, STAFF_MCP_SERVERS } from "@/lib/mcp-whitelist";
import { staffDataScopeForAll } from "@/lib/staff-data-scope";
import { STAFF_CHAT_PROFILE } from "@/lib/ai-profiles";
import type { RelayChatBody, RelayEffort, RelayMessage, RelayModel } from "@/lib/relay-chat";
import { runningJobCount, runningJobOf, startAiJob } from "@/lib/ai-jobs";
import { describeCards, moSessionKey } from "@/lib/mo/model";
import { buildMoSystemPrompt } from "@/lib/mo/prompt";
import { appendMoUserMessage, loadBoard, parseMoCards, parseMoMessages } from "@/lib/mo/thread";

const MAX_RUNNING_JOBS_PER_USER = 3;
const MAX_HISTORY = 16;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TURNS = 25;
/** A voice answer should come fast; the relay cuts a runaway turn. */
const BUDGET_MS = 5 * 60_000;
const MODELS = new Set<RelayModel>(["sonnet", "opus", "fable"]);
const EFFORTS = new Set<RelayEffort>(["low", "medium", "high"]);
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const board = await loadBoard(id, guard.session.userId);
  if (!board) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { message?: unknown; model?: unknown; effort?: unknown; account?: unknown; page?: unknown };
  const page = typeof body.page === "string" && /^\/[A-Za-z0-9\-_./?=&%:+,]{0,300}$/.test(body.page) ? body.page : null;
  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE_CHARS) : "";
  if (!message) return NextResponse.json({ error: "message requis" }, { status: 400 });

  const running = await runningJobOf(board.id, guard.session.userId);
  if (running) return NextResponse.json({ error: "Mo répond déjà. Attends la fin de sa réponse.", jobId: running.id }, { status: 409 });
  if (await runningJobCount(guard.session.userId) >= MAX_RUNNING_JOBS_PER_USER) {
    return NextResponse.json({ error: `${MAX_RUNNING_JOBS_PER_USER} réponses sont déjà en cours sur ton compte. Attends qu'une se termine.` }, { status: 429 });
  }

  const [scope, metaIds, googleIds, tiktokIds, dataScope] = await Promise.all([
    getAccountScope(guard.session),
    getAllowedAccountIds(guard.session.userId, "meta"),
    getAllowedAccountIds(guard.session.userId, "google"),
    getAllowedAccountIds(guard.session.userId, "tiktok"),
    staffDataScopeForAll(),
  ]);
  const clients = await listClientRegistry(scope);
  const author = guard.session.user?.name ?? guard.session.user?.email ?? null;
  const systemPrompt = buildMoSystemPrompt({ clients, author });

  const cards = parseMoCards(board.cardsJson);
  const history = parseMoMessages(board.messagesJson).slice(-MAX_HISTORY);
  const at = new Date().toISOString();
  // The board's inventory travels with the question (never into storage) so
  // "compare with that" resolves to a card id.
  const context = `\n\n[${page ? `Page actuelle de la personne : ${page}\n` : ""}Cartes à l'écran :\n${describeCards(cards)}]`;
  const relayMessages: RelayMessage[] = [
    ...history.map((m) => ({ role: m.role, content: m.content.slice(0, 12_000) })),
    { role: "user", content: `${message}${context}` },
  ];

  const model: RelayModel = MODELS.has(body.model as RelayModel) ? (body.model as RelayModel) : STAFF_CHAT_PROFILE.model;
  const effort: RelayEffort = EFFORTS.has(body.effort as RelayEffort) ? (body.effort as RelayEffort) : STAFF_CHAT_PROFILE.effort;
  const account = typeof body.account === "string" && ACCOUNT_RE.test(body.account) && body.account !== "auto" ? body.account : undefined;

  const relayBody: RelayChatBody = {
    messages: relayMessages,
    systemPrompt,
    hqGuidance: "caller",
    sessionKey: moSessionKey(board.id),
    model,
    effort,
    ...(account ? { account } : {}),
    maxTurns: MAX_TURNS,
    budgetMs: BUDGET_MS,
    allowedServers: [...STAFF_MCP_SERVERS, SANDBOX_SERVER, ...(dataScope ? [CLIENT_DATA_SERVER] : [])],
    ...(dataScope ? { dataScope } : {}),
    accountScope: { meta: metaIds, google: googleIds, tiktok: tiktokIds, unrestricted: guard.session.role === "admin" },
  };

  await appendMoUserMessage(board.id, message, at);
  const started = await startAiJob({
    relayBody,
    surface: "mo",
    userId: guard.session.userId,
    conversationId: board.id,
    title: message,
    usageContext: { feature: "mo", clientName: "—", user: { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "" } },
  });
  if ("error" in started) return NextResponse.json({ error: started.error }, { status: 502 });
  return NextResponse.json({ jobId: started.jobId }, { status: 202 });
}
