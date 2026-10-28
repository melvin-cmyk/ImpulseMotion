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
import { CLIENT_DATA_SERVER, HQ_SERVER, MCP_SERVER_WHITELIST, MO_SERVER, SANDBOX_SERVER, STAFF_MCP_SERVERS, TIKTOK_SERVER } from "@/lib/mcp-whitelist";
import { staffDataScopeForAll } from "@/lib/staff-data-scope";
import { MO_PROFILE } from "@/lib/ai-profiles";
import type { RelayChatBody, RelayEffort, RelayMessage, RelayModel } from "@/lib/relay-chat";
import { runningJobCount, runningJobOf, startAiJob } from "@/lib/ai-jobs";
import { describeCards, moSessionKey } from "@/lib/mo/model";
import { buildMoSystemPrompt } from "@/lib/mo/prompt";
import { appendMoUserMessage, loadBoard, parseMoCards, parseMoMessages } from "@/lib/mo/thread";

const MAX_RUNNING_JOBS_PER_USER = 3;
const MAX_HISTORY = 16;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TURNS = MO_PROFILE.maxTurns ?? 12;

/**
 * Servers attached to the turn, by what the sentence asks for: the three ads
 * platforms by default (plus GA4), HQ when the context of a client is asked,
 * the heavy belt (sheets, Notion, sandbox, warehouses…) only on explicit
 * words. Fewer servers = seconds saved at every start of the CLI.
 */
/**
 * Two stable tool belts, each with its own relay session, so a turn always
 * RESUMES (the relay drops a session whose server list changed — the old
 * per-sentence list restarted Mo almost every turn):
 *   - « mo » (default): Mo's own tools only — warehouse, generation, Drive, publication, Ad Library. Starts in a second.
 *   - « wide »: the same plus the live ads platforms, HQ, the staff belt, the sandbox and the client warehouses,
 *     when the sentence clearly asks for them (live insights, audiences, HQ context, sheets, Python…).
 */
function beltFor(message: string, dataScope: boolean): { name: "mo" | "wide"; servers: string[] } {
  const t = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const live = /\b(en direct|temps reel|insights?|ga4|analytics|trafic|sessions?|audiences?|ciblages?|encheres?|placements?|frequence|statuts?|google ads|tiktok|adset|ensembles? de pub|pixel|evenements? de conversion|catalogue)\b/.test(t);
  const hq = /\b(hq|contexte|historique|objectifs?|brief|memoire|persona|strategie)\b/.test(t);
  const staff = /\b(sheet|sheets|tableur|excel|feuille|notion|merchant|magento|drive|gmail|agenda|calendar|web|internet|cherche sur)\b/.test(t);
  const sandbox = /\b(calcul|python|script|graphique avance|fichier|csv|sandbox)\b/.test(t);
  const data = dataScope && /\b(commandes?|entrepot|dataset|datasets|ventes? en base|panier|clients? finaux)\b/.test(t);
  if (!live && !hq && !staff && !sandbox && !data) return { name: "mo", servers: [MO_SERVER] };
  const servers = new Set<string>([MO_SERVER, ...MCP_SERVER_WHITELIST, TIKTOK_SERVER, HQ_SERVER, ...STAFF_MCP_SERVERS, SANDBOX_SERVER]);
  if (dataScope) servers.add(CLIENT_DATA_SERVER);
  return { name: "wide", servers: [...servers] };
}
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

  const model: RelayModel = MODELS.has(body.model as RelayModel) ? (body.model as RelayModel) : MO_PROFILE.model;
  const effort: RelayEffort = EFFORTS.has(body.effort as RelayEffort) ? (body.effort as RelayEffort) : MO_PROFILE.effort;
  const account = typeof body.account === "string" && ACCOUNT_RE.test(body.account) && body.account !== "auto" ? body.account : undefined;

  const belt = beltFor(message, !!dataScope);
  const relayBody: RelayChatBody = {
    messages: relayMessages,
    systemPrompt,
    hqGuidance: "caller",
    sessionKey: belt.name === "wide" ? `${moSessionKey(board.id)}:wide` : moSessionKey(board.id),
    model,
    effort,
    ...(account ? { account } : {}),
    maxTurns: MAX_TURNS,
    budgetMs: BUDGET_MS,
    allowedServers: belt.servers,
    mo: { userId: guard.session.userId, boardId: board.id },
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
