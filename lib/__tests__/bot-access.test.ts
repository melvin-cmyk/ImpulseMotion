import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
const accessFindUnique = vi.fn();
const accessCount = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientBot: { findMany: (...a: unknown[]) => findMany(...a), findUnique: (...a: unknown[]) => findUnique(...a) },
    clientBotAccess: { findUnique: (...a: unknown[]) => accessFindUnique(...a), count: (...a: unknown[]) => accessCount(...a) },
  },
}));

// auth-helpers pulls next-auth; only isStaff is needed here.
vi.mock("@/lib/auth-helpers", () => ({
  isStaff: (s: { role?: string | null } | null | undefined) => s?.role === "admin" || s?.role === "consultant",
}));

import { listBotsFor, loadBotFor, countEnabledBotAccess } from "@/lib/bot-access";

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
});

describe("listBotsFor", () => {
  it("staff → tous les bots activés (aucun filtre d'accès)", async () => {
    findMany.mockResolvedValue([{ id: "b", name: "A", sourcesJson: '{"meta":true}', dashboard: { name: "LPEV" } }]);
    const bots = await listBotsFor({ userId: "u1", role: "consultant" });
    expect(findMany.mock.calls[0][0].where).toEqual({ enabled: true });
    expect(bots).toEqual([{ id: "b", name: "A", dashboardName: "LPEV", sources: { meta: true } }]);
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

  it("404 sur bot désactivé, même pour le staff", async () => {
    findUnique.mockResolvedValue({ ...BOT, enabled: false });
    expect((await loadBotFor({ userId: "u", role: "admin" }, "bot1")).status).toBe(404);
  });

  it("staff → 200 sans consulter les accès", async () => {
    findUnique.mockResolvedValue(BOT);
    const r = await loadBotFor({ userId: "staff", role: "admin" }, "bot1");
    expect(r.status).toBe(200);
    expect(r.bot?.dashboard.name).toBe("LPEV");
    expect(accessFindUnique).not.toHaveBeenCalled();
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

describe("countEnabledBotAccess", () => {
  it("compte les accès sur bots activés", async () => {
    accessCount.mockResolvedValue(2);
    expect(await countEnabledBotAccess("c1")).toBe(2);
    expect(accessCount.mock.calls[0][0]).toEqual({ where: { userId: "c1", bot: { enabled: true } } });
  });
});
