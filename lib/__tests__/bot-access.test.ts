import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
const accessFindUnique = vi.fn();
const accessCount = vi.fn();
const dashboardFindMany = vi.fn();
/** ACL rows behind getAccountScope — a consultant assigned Meta act_1 only. */
const aclFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientBot: { findMany: (...a: unknown[]) => findMany(...a), findUnique: (...a: unknown[]) => findUnique(...a) },
    clientBotAccess: { findUnique: (...a: unknown[]) => accessFindUnique(...a), count: (...a: unknown[]) => accessCount(...a) },
    userAdAccount: { findMany: (...a: unknown[]) => aclFindMany(...a) },
    dashboard: { findMany: (...a: unknown[]) => dashboardFindMany(...a) },
  },
}));

// auth-helpers pulls next-auth; only isStaff is needed here.
vi.mock("@/lib/auth-helpers", () => ({
  isStaff: (s: { role?: string | null } | null | undefined) => s?.role === "admin" || s?.role === "consultant",
}));

import { buildBotOverview, listBotsFor, listBotOverviewFor, loadBotFor, countEnabledBotAccess } from "@/lib/bot-access";
import { buildBotClients } from "@/lib/bot-clients";

const BOT = {
  id: "bot1",
  dashboardId: "d1",
  enabled: true,
  name: "Assistant",
  clientKey: "lpev",
  businessContext: "",
  sourcesJson: JSON.stringify({ meta: true, data: true }),
  lastIngestAt: null,
  lastIngestRows: null,
  dashboard: { id: "d1", name: "LPEV", metaAccountId: "act_1", googleCustomerId: null },
};

beforeEach(() => {
  findMany.mockReset();
  findUnique.mockReset();
  accessFindUnique.mockReset();
  accessCount.mockReset();
  dashboardFindMany.mockReset();
  aclFindMany.mockReset();
  aclFindMany.mockResolvedValue([{ platform: "meta", accountId: "act_1" }]);
});

describe("listBotsFor", () => {
  it("admin → tous les bots activés", async () => {
    findMany.mockResolvedValue([{ id: "b", name: "A", sourcesJson: '{"meta":true}', dashboard: { name: "LPEV" } }]);
    const bots = await listBotsFor({ userId: "u1", role: "admin" });
    expect(findMany.mock.calls[0][0].where).toEqual({ enabled: true });
    expect(bots).toEqual([{ id: "b", name: "A", dashboardName: "LPEV", sources: { meta: true } }]);
  });

  it("consultant → seulement les bots de ses clients attribués", async () => {
    findMany.mockResolvedValue([]);
    await listBotsFor({ userId: "u1", role: "consultant" });
    expect(findMany.mock.calls[0][0].where).toEqual({
      enabled: true,
      dashboard: { OR: [{ metaAccountId: { in: ["1", "act_1"] } }] },
    });
  });

  it("client → uniquement via ClientBotAccess, activés", async () => {
    findMany.mockResolvedValue([]);
    await listBotsFor({ userId: "u2", role: "client" });
    expect(findMany.mock.calls[0][0].where).toEqual({ enabled: true, accesses: { some: { userId: "u2" } } });
  });
});

describe("loadBotFor", () => {
  it("404 sur bot inconnu ou id vide", async () => {
    findUnique.mockResolvedValue(null);
    expect(await loadBotFor({ userId: "u", role: "admin" }, "nope")).toEqual({ status: 404, bot: null });
    expect(await loadBotFor({ userId: "u", role: "admin" }, "")).toEqual({ status: 404, bot: null });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("bot désactivé → 200 pour le staff (mode test), 404 pour le client", async () => {
    findUnique.mockResolvedValue({ ...BOT, enabled: false });
    const staff = await loadBotFor({ userId: "u", role: "admin" }, "bot1");
    expect(staff.status).toBe(200);
    expect(staff.bot?.enabled).toBe(false);
    expect((await loadBotFor({ userId: "c", role: "consultant" }, "bot1")).status).toBe(200);
    accessFindUnique.mockResolvedValue({ id: "acc" });
    expect(await loadBotFor({ userId: "c1", role: "client" }, "bot1")).toEqual({ status: 404, bot: null });
    // The client's grant is never consulted: the bot must not be revealed.
    expect(accessFindUnique).not.toHaveBeenCalled();
  });

  it("bot désactivé hors périmètre → 403 pour un consultant", async () => {
    findUnique.mockResolvedValue({ ...BOT, enabled: false, dashboard: { ...BOT.dashboard, metaAccountId: "act_999" } });
    expect(await loadBotFor({ userId: "c", role: "consultant" }, "bot1")).toEqual({ status: 403, bot: null });
  });

  it("staff → 200 sans consulter les accès", async () => {
    findUnique.mockResolvedValue(BOT);
    const r = await loadBotFor({ userId: "staff", role: "admin" }, "bot1");
    expect(r.status).toBe(200);
    expect(r.bot?.dashboard.name).toBe("LPEV");
    expect(accessFindUnique).not.toHaveBeenCalled();
  });

  it("consultant → 200 sur un client attribué", async () => {
    findUnique.mockResolvedValue(BOT);
    expect((await loadBotFor({ userId: "c", role: "consultant" }, "bot1")).status).toBe(200);
  });

  it("consultant → 403 sur le bot d'un client qui ne lui est pas attribué", async () => {
    // The bot answers from that client's own data warehouse (orders, revenue).
    findUnique.mockResolvedValue({ ...BOT, dashboard: { ...BOT.dashboard, metaAccountId: "act_999" } });
    expect(await loadBotFor({ userId: "c", role: "consultant" }, "bot1")).toEqual({ status: 403, bot: null });
  });

  it("client sans accès → 403", async () => {
    findUnique.mockResolvedValue(BOT);
    accessFindUnique.mockResolvedValue(null);
    const r = await loadBotFor({ userId: "c1", role: "client" }, "bot1");
    expect(r).toEqual({ status: 403, bot: null });
    expect(accessFindUnique.mock.calls[0][0].where).toEqual({ botId_userId: { botId: "bot1", userId: "c1" } });
  });

  it("client avec accès → 200", async () => {
    findUnique.mockResolvedValue(BOT);
    accessFindUnique.mockResolvedValue({ id: "acc" });
    const r = await loadBotFor({ userId: "c1", role: "client" }, "bot1");
    expect(r.status).toBe(200);
    expect(r.bot?.clientKey).toBe("lpev");
  });
});

describe("buildBotOverview", () => {
  const bot = (id: string, enabled: boolean, accessCount: number) => ({
    id, enabled, name: "Assistant", clientKey: id, sourcesJson: null, accessCount, lastIngestAt: null, lastIngestRows: null,
  });
  const LIST = buildBotClients({
    clients: [
      { id: "c1", name: "LPEV", dormant: false, accounts: [{ platform: "meta", accountId: "act_1", name: "LPEV FR" }] },
      // No dashboard at all: it is listed all the same (it was missing before).
      { id: "c2", name: "Decathlon Travel", dormant: true, accounts: [{ platform: "google", accountId: "123-456-7890", name: "Decathlon Travel" }, { platform: "meta", accountId: "act_9", name: "DT" }] },
    ],
    dashboards: [
      { id: "d1", name: "LPEV", metaAccountId: "act_1", googleCustomerId: null, ownerEmail: null, createdAt: "2026-01-01", bot: bot("b1", false, 0) },
      { id: "d1b", name: "LPEV bis", metaAccountId: "act_1", googleCustomerId: null, ownerEmail: null, createdAt: "2026-02-01", bot: bot("b2", true, 2) },
      { id: "d3", name: "Orphelin", metaAccountId: "act_77", googleCustomerId: null, ownerEmail: null, createdAt: "2026-01-01", bot: bot("b3", true, 0) },
      { id: "d4", name: "Orphelin sans bot", metaAccountId: "act_78", googleCustomerId: null, ownerEmail: null, createdAt: "2026-01-01", bot: null },
    ],
  });

  it("admin → tous les clients, avec ou sans dashboard, le meilleur bot d'abord, et les bots orphelins", () => {
    const items = buildBotOverview(LIST, { all: true });
    expect(items.map((i) => i.name)).toEqual(["Decathlon Travel", "LPEV", "Orphelin"]);
    const dt = items[0];
    expect(dt).toMatchObject({ clientId: "c2", dormant: true, bots: [] });
    expect(dt.accounts.map((a) => a.platform).sort()).toEqual(["google", "meta"]);
    expect(items[1].bots.map((b) => b.id)).toEqual(["b2", "b1"]);
    expect(items[2]).toMatchObject({ clientId: null, key: "dashboard:d3", bots: [{ id: "b3" }] });
  });

  it("consultant → seulement les clients et les bots de son périmètre", () => {
    const scope = { all: false as const, meta: new Set(["9"]), google: new Set<string>(), tiktok: new Set<string>() };
    const items = buildBotOverview(LIST, scope);
    expect(items.map((i) => i.name)).toEqual(["Decathlon Travel"]);
    expect(items[0].accounts).toEqual([{ platform: "meta", accountId: "9", name: "DT" }]);
  });
});

describe("listBotOverviewFor", () => {
  it("client → liste vide, sans requête", async () => {
    expect(await listBotOverviewFor({ userId: "u2", role: "client" })).toEqual([]);
    expect(dashboardFindMany).not.toHaveBeenCalled();
  });
});

describe("countEnabledBotAccess", () => {
  it("compte les accès sur bots activés", async () => {
    accessCount.mockResolvedValue(2);
    expect(await countEnabledBotAccess("c1")).toBe(2);
    expect(accessCount.mock.calls[0][0]).toEqual({ where: { userId: "c1", bot: { enabled: true } } });
  });
});
