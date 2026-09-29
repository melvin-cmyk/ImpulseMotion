import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

type Board = { id: string; userId: string; name: string; metaAccountId: string | null; googleCustomerId: string | null; createdAt: Date };

let session: { userId: string; role: string; baseRole: string } | null = null;
const alertClients: Array<{ id: string; name: string; dormant: boolean; gone: boolean; accountsJson: string }> = [];
const boards: Board[] = [];
const created: Array<{ userId: string; name?: string; metaAccountId?: string | null; googleCustomerId?: string | null }> = [];

vi.mock("@/lib/auth-helpers", () => ({
  requireRealAdmin: async () => {
    if (!session) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
    if (session.baseRole !== "admin") return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
    return { session };
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    alertClient: {
      findMany: async ({ where }: { where: { gone: boolean } }) => alertClients.filter((c) => c.gone === where.gone),
    },
    dashboard: {
      findMany: async () => boards.map((b) => ({ ...b, user: { email: `${b.userId}@agence.fr` }, bot: null })),
    },
  },
}));
vi.mock("@/lib/cockpit/fetch", () => ({ listMetaAccounts: vi.fn(), listGoogleAccounts: vi.fn() }));
vi.mock("@/lib/cockpit/build", () => ({ syncAccounts: vi.fn() }));
vi.mock("@/lib/dashboard-widgets", () => ({
  createDashboardForUser: async (input: { userId: string; name?: string; metaAccountId?: string | null; googleCustomerId?: string | null }) => {
    created.push(input);
    const row: Board = { id: `new${created.length}`, userId: input.userId, name: input.name ?? "", metaAccountId: input.metaAccountId ?? null, googleCustomerId: input.googleCustomerId ?? null, createdAt: new Date() };
    boards.push(row);
    return row;
  },
}));

import { GET as LIST, POST } from "@/app/api/admin/bots/route";

const accounts = (...list: Array<["meta" | "google", string]>) => JSON.stringify(list.map(([platform, accountId]) => ({ platform, accountId, name: `Compte ${platform}`, currency: "EUR" })));
const GET = async () => (await LIST())!;
const post = async (body: unknown) => (await POST(new Request("http://x/api/admin/bots", { method: "POST", body: JSON.stringify(body) })))!;

describe("/api/admin/bots", () => {
  beforeEach(() => {
    session = { userId: "admin1", role: "admin", baseRole: "admin" };
    created.length = 0;
    boards.length = 0;
    alertClients.length = 0;
    alertClients.push(
      { id: "c1", name: "Dufour", dormant: false, gone: false, accountsJson: accounts(["meta", "111111"], ["google", "2222222222"]) },
      { id: "c2", name: "LuxTrust", dormant: true, gone: false, accountsJson: accounts(["google", "3333333333"]) },
      { id: "c3", name: "Parti", dormant: false, gone: true, accountsJson: accounts(["meta", "444444"]) },
    );
  });

  it("is closed to anyone but a real admin, reading or creating", async () => {
    for (const who of [null, { userId: "u", role: "consultant", baseRole: "consultant" }, { userId: "u", role: "admin", baseRole: "consultant" }, { userId: "u", role: "client", baseRole: "client" }]) {
      session = who;
      const status = who ? 403 : 401;
      expect((await GET()).status).toBe(status);
      expect((await post({ clientId: "c1", metaAccountId: "111111" })).status).toBe(status);
    }
    expect(created).toEqual([]);
  });

  it("lists every client that is not gone, and keeps the list by dashboard", async () => {
    boards.push({ id: "d1", userId: "admin1", name: "Dufour", metaAccountId: "act_111111", googleCustomerId: null, createdAt: new Date("2026-01-01") });
    const json = await (await GET()).json();
    expect(json.clients.map((c: { name: string; dashboards: unknown[] }) => [c.name, c.dashboards.length])).toEqual([["Dufour", 1], ["LuxTrust", 0]]);
    expect(json.counts).toEqual({ clients: 2, active: 1, dormant: 1, withDashboard: 1, withoutDashboard: 1, withBot: 0, withoutBot: 2, orphans: 0 });
    expect(json.dashboards).toEqual([{ id: "d1", name: "Dufour", metaAccountId: "act_111111", googleCustomerId: null, ownerEmail: "admin1@agence.fr", bot: null }]);
  });

  it("creates the dashboard of a client that has none, owned by the admin, on the accounts sent", async () => {
    const res = await post({ clientId: "c1", metaAccountId: "act_111111", googleCustomerId: "222-222-2222" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ dashboardId: "new1", created: true });
    expect(created).toEqual([{ userId: "admin1", name: "Dufour", metaAccountId: "111111", googleCustomerId: "2222222222" }]);
  });

  it("refuses an account that is not the client's", async () => {
    const res = await post({ clientId: "c1", metaAccountId: "111111", googleCustomerId: "3333333333" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("n'appartient pas à Dufour");
    expect((await post({ clientId: "c2", metaAccountId: "111111" })).status).toBe(403);
    expect(created).toEqual([]);
  });

  it("refuses an unknown or gone client, and a request that names no account", async () => {
    expect((await post({ clientId: "nope", metaAccountId: "111111" })).status).toBe(404);
    expect((await post({ clientId: "c3", metaAccountId: "444444" })).status).toBe(404);
    expect((await post({ clientId: "c1" })).status).toBe(400);
    expect((await post({ metaAccountId: "111111" })).status).toBe(400);
    expect((await post({ clientId: "c1", metaAccountId: ["111111"] })).status).toBe(400);
    expect(created).toEqual([]);
  });

  it("does not create a second dashboard for the same client", async () => {
    expect((await (await post({ clientId: "c1", metaAccountId: "111111" })).json()).created).toBe(true);
    const again = await post({ clientId: "c1", metaAccountId: "111111" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ dashboardId: "new1", created: false });
    expect(await (await post({ clientId: "c1", metaAccountId: "111111", googleCustomerId: "2222222222" })).json()).toEqual({ dashboardId: "new1", created: false });
    expect(created).toHaveLength(1);
    expect(boards).toHaveLength(1);
  });
});
