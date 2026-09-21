import { describe, it, expect, vi, beforeEach } from "vitest";

const dashboardFindUnique = vi.fn();
const dashboardFindMany = vi.fn();
const userFindUnique = vi.fn();
const userCreate = vi.fn();
const memberUpsert = vi.fn();
const memberDeleteMany = vi.fn();
const botAccessDeleteMany = vi.fn();
const aclFindMany = vi.fn();
const aclDeleteMany = vi.fn();
const grant = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    dashboard: { findUnique: (...a: unknown[]) => dashboardFindUnique(...a), findMany: (...a: unknown[]) => dashboardFindMany(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a), create: (...a: unknown[]) => userCreate(...a) },
    dashboardMember: { upsert: (...a: unknown[]) => memberUpsert(...a), deleteMany: (...a: unknown[]) => memberDeleteMany(...a) },
    clientBotAccess: { deleteMany: (...a: unknown[]) => botAccessDeleteMany(...a) },
    userAdAccount: { findMany: (...a: unknown[]) => aclFindMany(...a), deleteMany: (...a: unknown[]) => aclDeleteMany(...a) },
  },
}));
// The real modules pull the whole widget/portfolio stack; only these are needed.
vi.mock("@/lib/dashboard-widgets", () => ({ grantDashboardAccess: (...a: unknown[]) => grant(...a) }));
vi.mock("@/lib/portfolio", () => ({
  normMeta: (id: string) => id.trim().replace(/^act_/, ""),
  normGoogle: (id: string) => id.trim().replace(/-/g, "").replace(/^0+/, ""),
}));
vi.mock("bcryptjs", () => ({ default: { hash: async () => "hashed" } }));

import { addDashboardMember, removeDashboardMember, parseEmails, MemberError } from "@/lib/dashboard-members";

const DASH = { id: "d1", name: "LPEV", metaAccountId: "111", googleCustomerId: "222" };

beforeEach(() => {
  for (const m of [dashboardFindUnique, dashboardFindMany, userFindUnique, userCreate, memberUpsert, memberDeleteMany, botAccessDeleteMany, aclFindMany, aclDeleteMany, grant]) m.mockReset();
  dashboardFindUnique.mockResolvedValue(DASH);
  memberUpsert.mockImplementation(async ({ create }: { create: { userId: string } }) => ({
    id: "m1", userId: create.userId, user: { id: create.userId, email: "x@y.fr", name: null, role: "client" },
  }));
});

describe("addDashboardMember", () => {
  it("email inconnu → crée le login avec le rôle demandé, mot de passe temporaire, et pose les droits", async () => {
    userFindUnique.mockResolvedValue(null);
    userCreate.mockResolvedValue({ id: "u9", role: "consultant" });
    const r = await addDashboardMember({ dashboardId: "d1", email: "  Sarah@Impulse.FR ", role: "consultant" });
    expect(userCreate.mock.calls[0][0].data).toMatchObject({ email: "sarah@impulse.fr", role: "consultant", passwordHash: "hashed" });
    expect(r.created).toBe(true);
    expect(r.tempPassword).toMatch(/^.{16}$/);
    expect(grant).toHaveBeenCalledWith("u9", DASH);
  });

  it("login existant du bon rôle → rattaché sans nouveau mot de passe", async () => {
    userFindUnique.mockResolvedValue({ id: "u1", role: "client" });
    const r = await addDashboardMember({ dashboardId: "d1", email: "c@marque.fr", role: "client" });
    expect(userCreate).not.toHaveBeenCalled();
    expect(r.created).toBe(false);
    expect(r.tempPassword).toBeUndefined();
    expect(grant).toHaveBeenCalledWith("u1", DASH);
  });

  it("refuse un admin et un rôle qui ne correspond pas — sans rien écrire", async () => {
    userFindUnique.mockResolvedValue({ id: "u1", role: "admin" });
    await expect(addDashboardMember({ dashboardId: "d1", email: "a@b.fr", role: "client" })).rejects.toMatchObject({ status: 409 });
    userFindUnique.mockResolvedValue({ id: "u2", role: "client" });
    await expect(addDashboardMember({ dashboardId: "d1", email: "a@b.fr", role: "consultant" })).rejects.toBeInstanceOf(MemberError);
    expect(memberUpsert).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });

  it("refuse un email invalide et un dashboard inconnu", async () => {
    await expect(addDashboardMember({ dashboardId: "d1", email: "pas-un-email", role: "client" })).rejects.toMatchObject({ status: 400 });
    dashboardFindUnique.mockResolvedValue(null);
    await expect(addDashboardMember({ dashboardId: "nope", email: "a@b.fr", role: "client" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("removeDashboardMember", () => {
  it("retire l'appartenance, l'accès au bot et les droits que plus rien ne justifie", async () => {
    dashboardFindUnique.mockResolvedValue({ ...DASH, bot: { id: "bot1" } });
    dashboardFindMany.mockResolvedValue([]); // no other dashboard for this user
    aclFindMany.mockResolvedValue([{ id: "acl-g", accountId: "222" }, { id: "acl-other", accountId: "999" }]);
    await removeDashboardMember("d1", "u1");
    expect(memberDeleteMany).toHaveBeenCalledWith({ where: { dashboardId: "d1", userId: "u1" } });
    expect(botAccessDeleteMany).toHaveBeenCalledWith({ where: { botId: "bot1", userId: "u1" } });
    expect(aclDeleteMany).toHaveBeenCalledWith({ where: { userId: "u1", platform: "meta", accountId: { in: ["111", "act_111"] } } });
    expect(aclDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["acl-g"] } } });
  });

  it("garde les droits encore couverts par un autre dashboard de la personne", async () => {
    dashboardFindUnique.mockResolvedValue({ ...DASH, bot: null });
    dashboardFindMany.mockResolvedValue([{ metaAccountId: "act_111", googleCustomerId: "222" }]);
    await removeDashboardMember("d1", "u1");
    expect(botAccessDeleteMany).not.toHaveBeenCalled();
    expect(aclDeleteMany).not.toHaveBeenCalled();
  });
});

describe("parseEmails", () => {
  it("accepte chaîne ou tableau, normalise et dédoublonne", () => {
    expect(parseEmails("A@x.fr, b@y.fr;  a@X.fr\n")).toEqual(["a@x.fr", "b@y.fr"]);
    expect(parseEmails(["C@z.fr", " c@z.fr "])).toEqual(["c@z.fr"]);
    expect(parseEmails(undefined)).toEqual([]);
  });
});
