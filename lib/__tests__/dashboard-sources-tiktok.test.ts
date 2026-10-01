/**
 * POST /api/dashboards/[id]/sources with kind "tiktok": the advertiser is shown
 * before it is stored, and what is stored is TikTok's answer — never what the
 * browser sent. The HubSpot path of the same route must not move.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const m = vi.hoisted(() => ({
  session: null as { userId: string; role: string } | null,
  outOfScope: false,
  findDashboard: vi.fn(),
  checkAdvertiser: vi.fn(),
  dashboardsWithAdvertiser: vi.fn(),
  attachTikTokAdvertiser: vi.fn(),
  listSources: vi.fn(),
  upsertHubspotSource: vi.fn(),
  testHubspotConnection: vi.fn(),
  scope: { all: true } as { all: true } | { all: false; meta: Set<string>; google: Set<string>; tiktok: Set<string> },
  grant: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  requireStaff: async () => {
    if (!m.session) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
    if (m.session.role !== "admin" && m.session.role !== "consultant") return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
    return { session: m.session };
  },
}));
vi.mock("@/lib/dashboard-auth", () => ({
  denyIfDashboardOutOfScope: async () => (m.outOfScope ? NextResponse.json({ error: "forbidden" }, { status: 403 }) : null),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { dashboard: { findUnique: m.findDashboard } } }));
vi.mock("@/lib/relay-tool", () => ({ relayDirectTool: vi.fn() }));
// normalizeAdvertiserId stays the real one: the route must refuse what it refuses.
vi.mock("@/lib/tiktok-accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tiktok-accounts")>()),
  checkAdvertiser: m.checkAdvertiser,
  dashboardsWithAdvertiser: m.dashboardsWithAdvertiser,
  attachTikTokAdvertiser: m.attachTikTokAdvertiser,
}));
vi.mock("@/lib/sources", () => ({ listSources: m.listSources, upsertHubspotSource: m.upsertHubspotSource }));
vi.mock("@/lib/secrets", () => ({ hasSecretsKey: () => true }));
vi.mock("@/lib/hubspot/client", () => ({ testHubspotConnection: m.testHubspotConnection }));
vi.mock("@/lib/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scope")>()),
  getAccountScope: async () => m.scope,
}));
vi.mock("@/lib/dashboard-widgets", () => ({ grantDashboardAccess: m.grant }));

import { POST } from "@/app/api/dashboards/[id]/sources/route";

const ID = "7111111111111111111";
const ADVERTISER = { id: ID, name: "Client Démo", currency: "EUR", timezone: "Europe/Paris", status: "STATUS_ENABLE" };
const SOURCE = { id: "s1", kind: "tiktok", externalId: ID, label: "Client Démo", config: { currency: "EUR", timezone: "Europe/Paris" }, status: "active", lastSyncAt: null, lastError: null, hasSecret: false, legacy: false };

const post = async (body: unknown, dashboardId = "d1") =>
  (await POST(new NextRequest(`http://x/api/dashboards/${dashboardId}/sources`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: dashboardId }) }))!;

const nothingWritten = () => {
  expect(m.attachTikTokAdvertiser).not.toHaveBeenCalled();
  expect(m.upsertHubspotSource).not.toHaveBeenCalled();
};

beforeEach(() => {
  m.session = { userId: "u1", role: "consultant" };
  m.outOfScope = false;
  m.scope = { all: true };
  for (const f of [m.findDashboard, m.checkAdvertiser, m.dashboardsWithAdvertiser, m.attachTikTokAdvertiser, m.listSources, m.upsertHubspotSource, m.testHubspotConnection, m.grant]) f.mockReset();
  m.findDashboard.mockResolvedValue({ id: "d1", name: "Client Démo", userId: "owner", members: [{ userId: "c1" }] });
  m.checkAdvertiser.mockResolvedValue({ ok: true, advertiser: ADVERTISER });
  m.dashboardsWithAdvertiser.mockResolvedValue([]);
  m.attachTikTokAdvertiser.mockResolvedValue({ id: "s1" });
  m.listSources.mockResolvedValue([SOURCE]);
});

describe("POST /api/dashboards/[id]/sources — TikTok", () => {
  it("is closed to anyone but the staff, and to a dashboard out of reach", async () => {
    for (const [who, status] of [[null, 401], [{ userId: "c1", role: "client" }, 403]] as const) {
      m.session = who;
      expect((await post({ kind: "tiktok", advertiserId: ID, confirm: true })).status).toBe(status);
    }
    m.session = { userId: "u1", role: "consultant" };
    m.outOfScope = true;
    expect((await post({ kind: "tiktok", advertiserId: ID, confirm: true })).status).toBe(403);
    m.outOfScope = false;
    m.findDashboard.mockResolvedValue(null);
    expect((await post({ kind: "tiktok", advertiserId: ID, confirm: true })).status).toBe(404);
    expect(m.checkAdvertiser).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("refuses what is not an advertiser id, without asking TikTok", async () => {
    for (const advertiserId of [undefined, "", "abc", "act_123456", "123", `${ID},7222222222222222222`, 7111111111111111111, [ID]]) {
      const res = await post({ kind: "tiktok", advertiserId, confirm: true });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("Identifiant du compte TikTok Ads invalide");
    }
    expect(m.checkAdvertiser).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("gives TikTok's reason when it refuses the account, confirmed or not", async () => {
    m.checkAdvertiser.mockResolvedValue({ ok: false, error: "TikTok ne connaît pas ce compte, ou l'agence n'y a pas accès." });
    for (const confirm of [undefined, true]) {
      const res = await post({ kind: "tiktok", advertiserId: ID, confirm });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "TikTok ne connaît pas ce compte, ou l'agence n'y a pas accès." });
    }
    nothingWritten();
  });

  it("shows the account and the other clients it is on, and stores nothing, until confirmed", async () => {
    m.dashboardsWithAdvertiser.mockResolvedValue(["Client A"]);
    // Pasted with spaces: the id asked to TikTok is the cleaned one.
    const res = await post({ kind: "tiktok", advertiserId: " 7111 1111 1111 1111 111 " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ check: { advertiser: ADVERTISER, alreadyOn: ["Client A"] } });
    expect(m.checkAdvertiser).toHaveBeenCalledWith(ID);
    expect(m.dashboardsWithAdvertiser).toHaveBeenCalledWith(ID, "d1");
    nothingWritten();
    expect(m.listSources).not.toHaveBeenCalled();
  });

  it("takes only confirm: true for a confirmation", async () => {
    for (const confirm of [false, "true", 1, null, {}]) {
      const res = await post({ kind: "tiktok", advertiserId: ID, confirm });
      expect(res.status).toBe(200);
      expect(Object.keys(await res.json())).toEqual(["check"]);
    }
    nothingWritten();
  });

  it("asks TikTok again on confirmation, then stores the account and returns the stored source", async () => {
    const order: string[] = [];
    m.checkAdvertiser.mockImplementation(async () => { order.push("check"); return { ok: true, advertiser: ADVERTISER }; });
    m.attachTikTokAdvertiser.mockImplementation(async () => { order.push("attach"); return { id: "s1" }; });
    m.listSources.mockResolvedValue([{ ...SOURCE, id: null, kind: "meta", legacy: true }, { ...SOURCE, id: "s0", externalId: "7222222222222222222" }, SOURCE]);
    const res = await post({ kind: "tiktok", advertiserId: ID, confirm: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ source: SOURCE, check: { advertiser: ADVERTISER, alreadyOn: [] } });
    expect(order).toEqual(["check", "attach"]);
    expect(m.attachTikTokAdvertiser).toHaveBeenCalledTimes(1);
    expect(m.attachTikTokAdvertiser).toHaveBeenCalledWith("d1", ADVERTISER);
    expect(m.listSources).toHaveBeenCalledWith("d1");
    // Access follows the binding: the owner and the members get the advertiser.
    expect(m.grant.mock.calls.map((c) => c[0])).toEqual(["owner", "c1"]);
    expect(m.grant).toHaveBeenCalledWith("owner", expect.objectContaining({ tiktokAdvertiserIds: [ID] }));
  });

  it("refuses an advertiser outside the staff member's scope, without asking TikTok", async () => {
    m.scope = { all: false, meta: new Set(), google: new Set(), tiktok: new Set(["7222222222222222222"]) };
    const res = await post({ kind: "tiktok", advertiserId: ID, confirm: true });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(`compte hors périmètre : ${ID}`);
    expect(m.checkAdvertiser).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("stores the name TikTok gives, not one sent by the browser", async () => {
    const res = await post({
      kind: "tiktok", advertiserId: ID, confirm: true,
      name: "Autre client", label: "Autre client", currency: "USD", timezone: "America/New_York",
      advertiser: { id: "7222222222222222222", name: "Autre client" }, check: { advertiser: { id: "7222222222222222222", name: "Autre client" } },
    });
    expect(res.status).toBe(200);
    expect(m.checkAdvertiser).toHaveBeenCalledWith(ID);
    expect(m.attachTikTokAdvertiser).toHaveBeenCalledWith("d1", ADVERTISER);
  });

  it("does not store when TikTok refuses at confirmation what it accepted at the check", async () => {
    expect((await post({ kind: "tiktok", advertiserId: ID })).status).toBe(200);
    m.checkAdvertiser.mockResolvedValue({ ok: false, error: "TikTok n'a pas pu être interrogé (Relay unreachable)." });
    expect((await post({ kind: "tiktok", advertiserId: ID, confirm: true })).status).toBe(400);
    expect(m.checkAdvertiser).toHaveBeenCalledTimes(2);
    nothingWritten();
  });

  it("answers an error, not an exception, when the write fails", async () => {
    m.attachTikTokAdvertiser.mockRejectedValue(new Error("base indisponible"));
    const res = await post({ kind: "tiktok", advertiserId: ID, confirm: true });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "base indisponible" });
  });
});

describe("POST /api/dashboards/[id]/sources — the rest of the route", () => {
  it("still attaches a HubSpot source from a tested token", async () => {
    const hubspot = { ...SOURCE, id: "h1", kind: "hubspot", externalId: "12345", label: "CRM", hasSecret: true };
    m.testHubspotConnection.mockResolvedValue({ ok: true, portalId: "12345", hubDomain: "client.fr", scopesOk: true, missingScopes: [] });
    m.upsertHubspotSource.mockResolvedValue(hubspot);
    const res = await post({ kind: "hubspot", token: " pat-eu1-abc ", label: "CRM", advertiserId: ID, confirm: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ source: hubspot, test: { portalId: "12345", hubDomain: "client.fr", scopesOk: true, missingScopes: [] } });
    expect(m.testHubspotConnection).toHaveBeenCalledWith("pat-eu1-abc");
    expect(m.upsertHubspotSource).toHaveBeenCalledWith({ dashboardId: "d1", portalId: "12345", token: "pat-eu1-abc", label: "CRM", config: undefined });
    expect(m.checkAdvertiser).not.toHaveBeenCalled();
    expect(m.attachTikTokAdvertiser).not.toHaveBeenCalled();
  });

  it("still refuses a HubSpot token that HubSpot refuses, or one of another portal", async () => {
    m.testHubspotConnection.mockResolvedValue({ ok: false, error: "401" });
    const refused = await post({ kind: "hubspot", token: "pat-eu1-abc" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe("Connexion HubSpot refusée : 401");
    m.testHubspotConnection.mockResolvedValue({ ok: true, portalId: "12345", hubDomain: null, scopesOk: true, missingScopes: [] });
    expect((await post({ kind: "hubspot", token: "pat-eu1-abc", portalId: "99999" })).status).toBe(400);
    expect((await post({ kind: "hubspot" })).status).toBe(400);
    nothingWritten();
  });

  it("still refuses any other kind", async () => {
    for (const kind of [undefined, "", "shopify", "meta", "google", "TikTok", ["tiktok"]]) {
      expect((await post({ kind, advertiserId: ID, confirm: true, token: "pat-eu1-abc" })).status).toBe(400);
    }
    expect(m.checkAdvertiser).not.toHaveBeenCalled();
    expect(m.testHubspotConnection).not.toHaveBeenCalled();
    nothingWritten();
  });
});
