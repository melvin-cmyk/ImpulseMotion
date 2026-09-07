/**
 * Who may talk to which private client bot.
 *
 *   - staff (admin / consultant): every ENABLED bot, so they can test them;
 *   - client: only bots they were granted on (ClientBotAccess), enabled only.
 *
 * Disabled bots are invisible to everyone here: the admin screens use their
 * own (admin-only) queries.
 */

import { prisma } from "@/lib/prisma";
import { isStaff } from "@/lib/auth-helpers";
import { parseSources, type BotSummary } from "@/lib/bot-types";

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
  const where = isStaff(session)
    ? { enabled: true }
    : { enabled: true, accesses: { some: { userId: session.userId } } };
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

export type LoadBotResult =
  | { status: 200; bot: BotWithDashboard }
  | { status: 403; bot: null }
  | { status: 404; bot: null };

/**
 * Loads one bot and checks the session may use it.
 *   404 → unknown or disabled bot (we do not reveal disabled bots exist)
 *   403 → exists and enabled, but the client has no access grant
 */
export async function loadBotFor(session: BotSession, botId: string): Promise<LoadBotResult> {
  if (!botId) return { status: 404, bot: null };
  const bot = await prisma.clientBot.findUnique({ where: { id: botId }, select: BOT_SELECT });
  if (!bot || !bot.enabled) return { status: 404, bot: null };
  if (isStaff(session)) return { status: 200, bot };
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
