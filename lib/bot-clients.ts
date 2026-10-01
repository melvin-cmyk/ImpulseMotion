/**
 * Client bots — who can be given one.
 *
 * The admin list (/admin/bots) shows every client of the agency, not only
 * those that have a dashboard. The clients are those of the automatic
 * alerting (AlertClient, lib/auto-alerts/clients.ts), as for the reports
 * (lib/report-clients.ts). A dashboard belongs to the clients that own one of
 * its accounts; a dashboard no client claims is listed apart.
 *
 * The grouping of accounts into clients is partly guessed from names. It is
 * only SHOWN here: what a bot reads is what is written on its dashboard,
 * chosen by the admin when the dashboard is created — never « every account
 * of the client ».
 */

import { prisma } from "@/lib/prisma";
import { normGoogle, normMeta } from "@/lib/portfolio";
import { parseAccounts, type ClassicAlertAccount } from "@/lib/auto-alerts/clients";
import { parseBotSources, type BotSources } from "@/lib/admin-bots";

export type BotPlatform = "meta" | "google";

export interface ClientInput {
  id: string;
  name: string;
  dormant: boolean;
  accounts: Array<Pick<ClassicAlertAccount, "platform" | "accountId" | "name">>;
}

export interface DashboardInput {
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  ownerEmail: string | null;
  createdAt: Date | string;
  bot: {
    id: string;
    enabled: boolean;
    name: string;
    clientKey: string;
    sourcesJson: string | null;
    accessCount: number;
    lastIngestAt: Date | string | null;
    lastIngestRows: number | null;
  } | null;
}

export interface OtherClient { id: string; name: string }

export interface BotState {
  id: string;
  enabled: boolean;
  name: string;
  clientKey: string;
  sources: BotSources;
  /** Client logins that were given the bot. */
  accessCount: number;
  lastIngestAt: string | null;
  lastIngestRows: number | null;
}

export interface BotDashboard {
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  ownerEmail: string | null;
  createdAt: string;
  bot: BotState | null;
  /** Other clients that own an account of this dashboard: its bot would read across two clients. */
  otherClients: OtherClient[];
}

export interface BotClientAccount {
  platform: BotPlatform;
  accountId: string;
  name: string;
  /** Where this account is also found at ANOTHER client: its list, or a dashboard (and bot) it shares. */
  conflicts: Array<{ client: OtherClient; dashboardId: string | null; dashboardName: string | null; bot: boolean }>;
}

export interface BotClientRow {
  id: string;
  name: string;
  /** No account spent anything over the last ten days (AlertClient.dormant). */
  dormant: boolean;
  accounts: BotClientAccount[];
  /** Oldest first. */
  dashboards: BotDashboard[];
}

export interface BotClientList {
  clients: BotClientRow[];
  /** Dashboards whose accounts belong to no known client. */
  orphans: BotDashboard[];
}

const norm = (platform: BotPlatform, id: string) => (platform === "meta" ? normMeta(id) : normGoogle(id));
const iso = (d: Date | string | null): string | null => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/** Accounts written on a dashboard, as the clients write them. */
function boardKeys(d: { metaAccountId: string | null; googleCustomerId: string | null }): { meta: string | null; google: string | null; keys: string[] } {
  const meta = d.metaAccountId ? norm("meta", d.metaAccountId) || null : null;
  const google = d.googleCustomerId ? norm("google", d.googleCustomerId) || null : null;
  return { meta, google, keys: [meta ? `meta:${meta}` : "", google ? `google:${google}` : ""].filter(Boolean) };
}

/** Pure: one row per client, with its accounts, its dashboards and their bots. */
export function buildBotClients(input: { clients: ClientInput[]; dashboards: DashboardInput[] }): BotClientList {
  const clients = input.clients.map((c) => ({
    ...c,
    accounts: c.accounts
      .map((a) => ({ platform: a.platform, accountId: norm(a.platform, a.accountId), name: a.name }))
      .filter((a, i, all) => a.accountId && all.findIndex((b) => b.platform === a.platform && b.accountId === a.accountId) === i),
  }));
  const owners = new Map<string, OtherClient[]>();
  for (const c of clients) {
    for (const a of c.accounts) {
      const key = `${a.platform}:${a.accountId}`;
      owners.set(key, [...(owners.get(key) ?? []), { id: c.id, name: c.name }]);
    }
  }

  const boards = [...input.dashboards]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id))
    .map((d) => {
      const { meta, google, keys } = boardKeys(d);
      const claimed = new Map<string, OtherClient>();
      for (const k of keys) for (const o of owners.get(k) ?? []) claimed.set(o.id, o);
      return { d, meta, google, keys, claimed: [...claimed.values()] };
    });

  const view = (b: (typeof boards)[number], clientId: string | null): BotDashboard => ({
    id: b.d.id,
    name: b.d.name,
    metaAccountId: b.meta,
    googleCustomerId: b.google,
    ownerEmail: b.d.ownerEmail,
    createdAt: iso(b.d.createdAt) ?? "",
    bot: b.d.bot
      ? {
          id: b.d.bot.id,
          enabled: b.d.bot.enabled,
          name: b.d.bot.name,
          clientKey: b.d.bot.clientKey,
          sources: parseBotSources(b.d.bot.sourcesJson),
          accessCount: b.d.bot.accessCount,
          lastIngestAt: iso(b.d.bot.lastIngestAt),
          lastIngestRows: b.d.bot.lastIngestRows,
        }
      : null,
    otherClients: b.claimed.filter((o) => o.id !== clientId),
  });

  const rows = clients.map((c): BotClientRow => {
    const mine = new Set(c.accounts.map((a) => `${a.platform}:${a.accountId}`));
    const dashboards = boards.filter((b) => b.keys.some((k) => mine.has(k)));
    return {
      id: c.id,
      name: c.name,
      dormant: c.dormant,
      accounts: c.accounts.map((a) => {
        const key = `${a.platform}:${a.accountId}`;
        const conflicts: BotClientAccount["conflicts"] = [];
        for (const b of dashboards) {
          if (!b.keys.includes(key)) continue;
          for (const o of b.claimed) if (o.id !== c.id) conflicts.push({ client: o, dashboardId: b.d.id, dashboardName: b.d.name, bot: !!b.d.bot });
        }
        // Listed by another client too, with no dashboard yet to show it.
        for (const o of owners.get(key) ?? []) {
          if (o.id !== c.id && !conflicts.some((x) => x.client.id === o.id)) conflicts.push({ client: o, dashboardId: null, dashboardName: null, bot: false });
        }
        return { ...a, conflicts };
      }),
      dashboards: dashboards.map((b) => view(b, c.id)),
    };
  });

  return {
    clients: rows.sort((a, b) => a.name.localeCompare(b.name, "fr") || a.id.localeCompare(b.id)),
    orphans: boards.filter((b) => !b.claimed.length).map((b) => view(b, null)).sort((a, b) => a.name.localeCompare(b.name, "fr")),
  };
}

export interface BotListCounts {
  clients: number;
  active: number;
  dormant: number;
  withDashboard: number;
  withoutDashboard: number;
  withBot: number;
  withoutBot: number;
  orphans: number;
}

export function countBotClients(list: BotClientList): BotListCounts {
  const n = (f: (c: BotClientRow) => boolean) => list.clients.filter(f).length;
  const hasBot = (c: BotClientRow) => c.dashboards.some((d) => d.bot);
  return {
    clients: list.clients.length,
    active: n((c) => !c.dormant),
    dormant: n((c) => c.dormant),
    withDashboard: n((c) => c.dashboards.length > 0),
    withoutDashboard: n((c) => c.dashboards.length === 0),
    withBot: n(hasBot),
    withoutBot: n((c) => !hasBot(c)),
    orphans: list.orphans.length,
  };
}

export type DashboardPlan =
  | { kind: "reuse"; dashboardId: string }
  | { kind: "create"; metaAccountId: string | null; googleCustomerId: string | null }
  | { kind: "refuse"; status: 400 | 403 | 409; error: string };

/**
 * Pure: what opening a bot to a client does. The accounts are the ones the
 * admin picked; each must be one of the client's, and of this client only.
 * A dashboard of the client that already reads them is used again.
 */
export function planBotDashboard(client: BotClientRow, choice: { metaAccountId?: string | null; googleCustomerId?: string | null }): DashboardPlan {
  const meta = choice.metaAccountId ? norm("meta", choice.metaAccountId) || null : null;
  const google = choice.googleCustomerId ? norm("google", choice.googleCustomerId) || null : null;
  const clean = client.dashboards.filter((d) => !d.otherClients.length);

  if (!meta && !google) {
    if (clean.length) return { kind: "reuse", dashboardId: clean[0].id };
    return client.dashboards.length
      ? { kind: "refuse", status: 409, error: `Le dashboard de ${client.name} lit aussi un compte d'un autre client (${client.dashboards[0].otherClients.map((o) => o.name).join(", ")}). Corrigez-le avant d'ouvrir un bot.` }
      : { kind: "refuse", status: 400, error: "Choisissez le compte Meta ou Google Ads que le bot lira." };
  }

  for (const [platform, id] of [["meta", meta], ["google", google]] as const) {
    if (!id) continue;
    const account = client.accounts.find((a) => a.platform === platform && a.accountId === id);
    if (!account) {
      return { kind: "refuse", status: 403, error: `Le compte ${platform === "meta" ? "Meta" : "Google Ads"} ${id} n'appartient pas à ${client.name}.` };
    }
    const others = [...new Set(account.conflicts.map((x) => x.client.name))];
    if (others.length) {
      return { kind: "refuse", status: 409, error: `Le compte ${account.name} (${id}) figure aussi chez ${others.join(", ")} : à quel client il appartient n'est pas établi. Aucun bot n'est ouvert sur un compte partagé.` };
    }
  }

  // Same accounts, or one set within the other: the dashboard is already there.
  const within = (d: BotDashboard) => (!d.metaAccountId || d.metaAccountId === meta) && (!d.googleCustomerId || d.googleCustomerId === google);
  const covers = (d: BotDashboard) => (!meta || d.metaAccountId === meta) && (!google || d.googleCustomerId === google);
  const exact = clean.find((d) => within(d) && covers(d));
  const near = exact ?? clean.find((d) => (d.metaAccountId || d.googleCustomerId) && (within(d) || covers(d)));
  if (near) return { kind: "reuse", dashboardId: near.id };
  return { kind: "create", metaAccountId: meta, googleCustomerId: google };
}

/** What the list is built from. Reads only. */
export async function loadBotClientInputs(): Promise<{ clients: ClientInput[]; dashboards: DashboardInput[] }> {
  const [clients, dashboards] = await Promise.all([
    prisma.alertClient.findMany({ where: { gone: false }, select: { id: true, name: true, dormant: true, accountsJson: true }, orderBy: { name: "asc" } }),
    prisma.dashboard.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        metaAccountId: true,
        googleCustomerId: true,
        createdAt: true,
        user: { select: { email: true } },
        bot: {
          select: {
            id: true, enabled: true, name: true, clientKey: true, sourcesJson: true,
            lastIngestAt: true, lastIngestRows: true,
            _count: { select: { accesses: true } },
          },
        },
      },
    }),
  ]);
  return {
    clients: clients
      .map(({ accountsJson, ...c }) => ({ ...c, accounts: parseAccounts(accountsJson) }))
      .filter((c) => c.accounts.length),
    dashboards: dashboards.map(({ user, bot, ...d }) => ({
      ...d,
      ownerEmail: user.email,
      bot: bot ? { id: bot.id, enabled: bot.enabled, name: bot.name, clientKey: bot.clientKey, sourcesJson: bot.sourcesJson, accessCount: bot._count.accesses, lastIngestAt: bot.lastIngestAt, lastIngestRows: bot.lastIngestRows } : null,
    })),
  };
}

export async function loadBotClients(): Promise<BotClientList> {
  return buildBotClients(await loadBotClientInputs());
}
