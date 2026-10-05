/**
 * Who may talk to which private client bot.
 *
 *   - admin:      every ENABLED bot;
 *   - consultant: the enabled bots of the clients they were assigned, so they
 *                 can test them — a bot answers from the client's own data
 *                 warehouse (orders, revenue, customers), so it follows the
 *                 same account scope as every other staff surface;
 *   - client:     only bots they were granted on (ClientBotAccess), enabled only.
 *
 * Disabled bots are invisible to clients. Staff in scope may still open one
 * (loadBotFor → "mode test"), and the staff panel (listBotOverviewFor) lists
 * every client of the agency in the scope (AlertClient, as /admin/bots), with
 * or without a dashboard or a bot, so a consultant can tell which assistant
 * they are on and whether clients can see it.
 */

import { prisma } from "@/lib/prisma";
import { isStaff } from "@/lib/auth-helpers";
import { parseSources, type BotSummary } from "@/lib/bot-types";
import { dashboardInScope, dashboardWhere, getAccountScope, googleInScope, metaInScope, platformAccountInScope, type AccountScope } from "@/lib/scope";
import { loadBotClients, type BotClientList, type BotDashboard as BotClientDashboard } from "@/lib/bot-clients";

export type BotSession = { userId: string; role?: string | null };

export type BotDashboard = {
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
};

export type BotWithDashboard = {
  id: string;
  dashboardId: string;
  enabled: boolean;
  name: string;
  clientKey: string;
  businessContext: string;
  sourcesJson: string;
  lastIngestAt: Date | null;
  lastIngestRows: number | null;
  dashboard: BotDashboard;
};

const BOT_SELECT = {
  id: true,
  dashboardId: true,
  enabled: true,
  name: true,
  clientKey: true,
  businessContext: true,
  sourcesJson: true,
  lastIngestAt: true,
  lastIngestRows: true,
  dashboard: { select: { id: true, name: true, metaAccountId: true, googleCustomerId: true } },
} as const;

/** Bots the session may open, as shown by GET /api/bot and /bot. */
export async function listBotsFor(session: BotSession): Promise<BotSummary[]> {
  let where;
  if (isStaff(session)) {
    const scope = await getAccountScope(session);
    where = scope.all ? { enabled: true } : { enabled: true, dashboard: dashboardWhere(scope) };
  } else {
    where = { enabled: true, accesses: { some: { userId: session.userId } } };
  }
  const bots = await prisma.clientBot.findMany({
    where,
    select: { id: true, name: true, sourcesJson: true, dashboard: { select: { name: true } } },
    orderBy: { dashboard: { name: "asc" } },
  });
  return bots.map((b) => ({
    id: b.id,
    name: b.name,
    dashboardName: b.dashboard.name,
    sources: parseSources(b.sourcesJson),
  }));
}

/** A bot as the staff panel of /bot shows it. */
export type BotOverviewBot = { id: string; name: string; enabled: boolean; accessCount: number; dashboardId: string; dashboardName: string };

/**
 * One row of the staff panel on /bot: a client of the agency (AlertClient, the
 * same list as /admin/bots — every client, with or without a dashboard) and
 * the bots of its dashboards. A dashboard that no known client claims is a row
 * of its own (`clientId` null), so that no bot ever vanishes from the panel.
 */
export type BotOverviewItem = {
  key: string;
  clientId: string | null;
  name: string;
  /** No account spent anything over the last ten days. */
  dormant: boolean;
  accounts: Array<{ platform: "meta" | "google"; accountId: string; name: string }>;
  /** Best first: reachable by clients, then enabled, then the rest. */
  bots: BotOverviewBot[];
};

const botRank = (b: BotOverviewBot) => (b.enabled && b.accessCount > 0 ? 0 : b.enabled ? 1 : 2);

/** Pure: the panel rows, from the list of /admin/bots, cut to the session's scope. */
export function buildBotOverview(list: BotClientList, scope: AccountScope): BotOverviewItem[] {
  const boardInScope = (d: BotClientDashboard) =>
    scope.all || metaInScope(scope, d.metaAccountId) || googleInScope(scope, d.googleCustomerId);
  const botsOf = (dashboards: BotClientDashboard[]): BotOverviewBot[] =>
    dashboards
      .filter((d) => d.bot && boardInScope(d))
      .map((d) => ({ id: d.bot!.id, name: d.bot!.name, enabled: d.bot!.enabled, accessCount: d.bot!.accessCount, dashboardId: d.id, dashboardName: d.name }))
      .sort((a, b) => botRank(a) - botRank(b) || a.dashboardName.localeCompare(b.dashboardName, "fr"));

  const items: BotOverviewItem[] = [];
  for (const c of list.clients) {
    const accounts = c.accounts.filter((a) => platformAccountInScope(scope, a.platform, a.accountId));
    if (!accounts.length) continue;
    items.push({
      key: c.id, clientId: c.id, name: c.name, dormant: c.dormant,
      accounts: accounts.map((a) => ({ platform: a.platform, accountId: a.accountId, name: a.name })),
      bots: botsOf(c.dashboards),
    });
  }
  for (const d of list.orphans) {
    if (!d.bot || !boardInScope(d)) continue;
    const accounts: BotOverviewItem["accounts"] = [];
    if (d.metaAccountId) accounts.push({ platform: "meta", accountId: d.metaAccountId, name: d.metaAccountId });
    if (d.googleCustomerId) accounts.push({ platform: "google", accountId: d.googleCustomerId, name: d.googleCustomerId });
    items.push({ key: `dashboard:${d.id}`, clientId: null, name: d.name, dormant: false, accounts, bots: botsOf([d]) });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, "fr") || a.key.localeCompare(b.key));
}

/**
 * Every client in the staff session's scope, ordered by name, with the state of
 * its bots: enabled + accessCount tell whether clients can actually reach them.
 * Staff only (the caller guards); a client session gets an empty list.
 */
export async function listBotOverviewFor(session: BotSession): Promise<BotOverviewItem[]> {
  if (!isStaff(session)) return [];
  const [scope, list] = await Promise.all([getAccountScope(session), loadBotClients()]);
  return buildBotOverview(list, scope);
}

export type LoadBotResult =
  | { status: 200; bot: BotWithDashboard }
  | { status: 403; bot: null }
  | { status: 404; bot: null };

/**
 * Loads one bot and checks the session may use it.
 *   404 → unknown bot, or disabled bot for a client (we do not reveal it exists)
 *   403 → in existence but out of scope (staff) / no access grant (client)
 *   200 → staff in scope, even on a disabled bot (test mode: the caller shows
 *         it is invisible to clients), or client with a grant on an enabled bot
 */
export async function loadBotFor(session: BotSession, botId: string): Promise<LoadBotResult> {
  if (!botId) return { status: 404, bot: null };
  const bot = await prisma.clientBot.findUnique({ where: { id: botId }, select: BOT_SELECT });
  if (!bot) return { status: 404, bot: null };
  if (isStaff(session)) {
    const scope = await getAccountScope(session);
    return dashboardInScope(scope, bot.dashboard) ? { status: 200, bot } : { status: 403, bot: null };
  }
  if (!bot.enabled) return { status: 404, bot: null };
  const access = await prisma.clientBotAccess.findUnique({
    where: { botId_userId: { botId, userId: session.userId } },
    select: { id: true },
  });
  if (!access) return { status: 403, bot: null };
  return { status: 200, bot };
}

/** Number of enabled bots the user was granted on (client chrome nav). */
export async function countEnabledBotAccess(userId: string): Promise<number> {
  return prisma.clientBotAccess.count({ where: { userId, bot: { enabled: true } } });
}
