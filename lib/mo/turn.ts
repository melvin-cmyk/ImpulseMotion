/**
 * What a turn of Mo sends to the relay, shared by the chat route (a real
 * message), the warm-up route (no message: the persistent CLI starts while
 * the person is still talking) and the tests: the caller's scope, the closed
 * client list, the system prompt, the tool belt and its session key.
 */

import { getAllowedAccountIds } from "@/lib/acl";
import { getAccountScope } from "@/lib/scope";
import { listClientRegistry, type ClientRef } from "@/lib/clients/registry";
import { CLIENT_DATA_SERVER, HQ_SERVER, MCP_SERVER_WHITELIST, MO_SERVER, SANDBOX_SERVER, STAFF_MCP_SERVERS, TIKTOK_SERVER } from "@/lib/mcp-whitelist";
import { staffDataScopeForAll } from "@/lib/staff-data-scope";
import { MO_PROFILE } from "@/lib/ai-profiles";
import type { RelayChatBody } from "@/lib/relay-chat";
import { moSessionKey } from "@/lib/mo/model";
import { buildMoSystemPrompt } from "@/lib/mo/prompt";

export type MoSession = { userId: string; role?: string | null; user?: { name?: string | null; email?: string | null } | null };

/** A voice answer should come fast; the relay cuts a runaway turn. */
export const MO_BUDGET_MS = 5 * 60_000;
export const MO_MAX_TURNS = MO_PROFILE.maxTurns ?? 12;

export interface MoTurnContext {
  clients: ClientRef[];
  systemPrompt: string;
  accountScope: NonNullable<RelayChatBody["accountScope"]>;
  dataScope: Awaited<ReturnType<typeof staffDataScopeForAll>>;
}

/** Everything about the caller a turn needs (four reads, in parallel). */
export async function moTurnContext(session: MoSession): Promise<MoTurnContext> {
  const [scope, metaIds, googleIds, tiktokIds, dataScope] = await Promise.all([
    getAccountScope(session),
    getAllowedAccountIds(session.userId, "meta"),
    getAllowedAccountIds(session.userId, "google"),
    getAllowedAccountIds(session.userId, "tiktok"),
    staffDataScopeForAll(),
  ]);
  const clients = await listClientRegistry(scope);
  const author = session.user?.name ?? session.user?.email ?? null;
  return { clients, systemPrompt: buildMoSystemPrompt({ clients, author }), accountScope: { meta: metaIds, google: googleIds, tiktok: tiktokIds, unrestricted: session.role === "admin" }, dataScope };
}

/**
 * Two stable tool belts, each with its own relay session, so a turn always
 * RESUMES (the relay drops a session whose server list changed):
 *   - « mo » (default): Mo's own tools only — warehouse, generation, Drive, publication, Ad Library.
 *   - « wide »: the same plus the live ads platforms, HQ, the staff belt, the sandbox and the client
 *     warehouses, when the sentence clearly asks for them.
 */
export function moBeltFor(message: string, dataScope: boolean): { name: "mo" | "wide"; servers: string[] } {
  const t = message.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
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

/** The relay body of a turn minus its messages: the same for a real turn and for a warm-up (the relay matches them by signature). */
export function moRelayBase(ctx: MoTurnContext, session: MoSession, boardId: string, belt: ReturnType<typeof moBeltFor>, opts: { model?: RelayChatBody["model"]; effort?: RelayChatBody["effort"]; account?: string } = {}): Omit<RelayChatBody, "messages"> {
  return {
    systemPrompt: ctx.systemPrompt,
    hqGuidance: "caller",
    sessionKey: belt.name === "wide" ? `${moSessionKey(boardId)}:wide` : moSessionKey(boardId),
    model: opts.model ?? MO_PROFILE.model,
    effort: opts.effort ?? MO_PROFILE.effort,
    ...(opts.account ? { account: opts.account } : {}),
    maxTurns: MO_MAX_TURNS,
    budgetMs: MO_BUDGET_MS,
    allowedServers: belt.servers,
    mo: { userId: session.userId, boardId },
    ...(ctx.dataScope ? { dataScope: ctx.dataScope } : {}),
    accountScope: ctx.accountScope,
  };
}
