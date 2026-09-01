import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

const db = vi.hoisted(() => ({
  dashboard: { findUnique: vi.fn() },
  dashboardSource: { findUnique: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { getHubspotSource, listSources, markSourceSync, removeSource, SourceNotFoundError, toSourceRef, upsertHubspotSource } from "@/lib/sources";
import { decryptSecret, encryptSecret } from "@/lib/secrets";

process.env.SOURCE_SECRETS_KEY = randomBytes(32).toString("base64");

const row = (over: Partial<Parameters<typeof toSourceRef>[0]> = {}) => ({
  id: "src1", kind: "hubspot", externalId: "12345", label: "CRM", config: '{"currency":"EUR"}', secretEnc: "v1:x:y:z",
  status: "active", lastSyncAt: new Date("2026-09-01T06:00:00Z"), lastError: null, ...over,
});

beforeEach(() => { Object.values(db.dashboard).forEach((f) => f.mockReset()); Object.values(db.dashboardSource).forEach((f) => f.mockReset()); });

describe("listSources", () => {
  it("synthesises legacy meta/google from the dashboard columns, then stored rows, never the secret", async () => {
    db.dashboard.findUnique.mockResolvedValue({ metaAccountId: "act_123", googleCustomerId: "123-456-7890", sources: [row()] });
    const out = await listSources("d1");
    expect(out.map((s) => s.kind)).toEqual(["meta", "google", "hubspot"]);
    expect(out[0]).toMatchObject({ id: null, kind: "meta", externalId: "123", legacy: true, hasSecret: false, status: "active" });
    expect(out[1]).toMatchObject({ id: null, kind: "google", externalId: "1234567890", legacy: true });
    expect(out[2]).toEqual({
      id: "src1", kind: "hubspot", externalId: "12345", label: "CRM", config: { currency: "EUR" }, status: "active",
      lastSyncAt: "2026-09-01T06:00:00.000Z", lastError: null, hasSecret: true, legacy: false,
    });
    for (const s of out) expect(JSON.stringify(s)).not.toContain("secretEnc");
  });

  it("returns only stored rows for an unlinked dashboard and tolerates broken config JSON", async () => {
    db.dashboard.findUnique.mockResolvedValue({ metaAccountId: null, googleCustomerId: null, sources: [row({ config: "{oops", secretEnc: null, status: "error", lastError: "401" })] });
    const out = await listSources("d1");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ config: {}, hasSecret: false, status: "error", lastError: "401" });
  });

  it("throws when the dashboard does not exist", async () => {
    db.dashboard.findUnique.mockResolvedValue(null);
    await expect(listSources("nope")).rejects.toBeInstanceOf(SourceNotFoundError);
  });
});

describe("getHubspotSource", () => {
  it("decrypts the stored token and exposes the config", async () => {
    db.dashboardSource.findFirst.mockResolvedValue(row({ secretEnc: encryptSecret("pat-eu1-abc"), config: '{"pipelineIds":["p1"]}' }));
    const got = await getHubspotSource("d1");
    expect(got?.token).toBe("pat-eu1-abc");
    expect(got?.config).toEqual({ pipelineIds: ["p1"] });
    expect(got?.ref.hasSecret).toBe(true);
    expect(db.dashboardSource.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { dashboardId: "d1", kind: "hubspot" } }));
  });

  it("returns null when there is no source or no token", async () => {
    db.dashboardSource.findFirst.mockResolvedValue(null);
    expect(await getHubspotSource("d1")).toBeNull();
    db.dashboardSource.findFirst.mockResolvedValue(row({ secretEnc: null }));
    expect(await getHubspotSource("d1")).toBeNull();
  });
});

describe("upsertHubspotSource", () => {
  it("encrypts the token, merges config, and keys on (dashboardId, hubspot, portalId)", async () => {
    db.dashboardSource.findUnique.mockResolvedValue({ config: '{"currency":"USD","pipelineIds":["old"]}' });
    db.dashboardSource.upsert.mockImplementation(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => row({ ...args.update, id: "src1" } as never));
    const ref = await upsertHubspotSource({ dashboardId: "d1", portalId: " 999 ", token: "pat-eu1-xyz", label: "  ", config: { pipelineIds: ["p1", ""], currency: "eur", utmCampaignProperty: null } });
    const call = db.dashboardSource.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ dashboardId_kind_externalId: { dashboardId: "d1", kind: "hubspot", externalId: "999" } });
    expect(call.create.secretEnc).toMatch(/^v1:/);
    expect(decryptSecret(call.create.secretEnc)).toBe("pat-eu1-xyz");
    expect(call.update).toMatchObject({ status: "active", lastError: null, label: null });
    expect(JSON.parse(call.update.config)).toEqual({ currency: "EUR", pipelineIds: ["p1"], utmCampaignProperty: null });
    expect(ref.hasSecret).toBe(true);
    expect("secretEnc" in ref).toBe(false);
  });

  it("does not touch the secret / status / label when only config is provided", async () => {
    db.dashboardSource.findUnique.mockResolvedValue(null);
    db.dashboardSource.upsert.mockResolvedValue(row({ secretEnc: null }));
    const ref = await upsertHubspotSource({ dashboardId: "d1", portalId: "1", config: { wonStageIds: ["w"] } });
    const call = db.dashboardSource.upsert.mock.calls[0][0];
    expect(call.update).toEqual({ config: JSON.stringify({ wonStageIds: ["w"] }) });
    expect(call.create.secretEnc).toBeNull();
    expect(ref.hasSecret).toBe(false);
  });

  it("refuses an empty portalId and fails loudly without SOURCE_SECRETS_KEY", async () => {
    await expect(upsertHubspotSource({ dashboardId: "d1", portalId: "  ", token: "t" })).rejects.toThrow(/portalId/);
    const saved = process.env.SOURCE_SECRETS_KEY;
    delete process.env.SOURCE_SECRETS_KEY;
    try {
      await expect(upsertHubspotSource({ dashboardId: "d1", portalId: "1", token: "t" })).rejects.toThrow(/SOURCE_SECRETS_KEY manquante/);
    } finally { process.env.SOURCE_SECRETS_KEY = saved; }
    expect(db.dashboardSource.upsert).not.toHaveBeenCalled();
  });
});

describe("removeSource / markSourceSync", () => {
  it("deletes scoped to the dashboard and throws when nothing matched", async () => {
    db.dashboardSource.deleteMany.mockResolvedValue({ count: 1 });
    await removeSource("d1", "src1");
    expect(db.dashboardSource.deleteMany).toHaveBeenCalledWith({ where: { id: "src1", dashboardId: "d1" } });
    db.dashboardSource.deleteMany.mockResolvedValue({ count: 0 });
    await expect(removeSource("d1", "other")).rejects.toBeInstanceOf(SourceNotFoundError);
  });

  it("records ok / error outcomes", async () => {
    db.dashboardSource.update.mockResolvedValue({});
    await markSourceSync("src1", { ok: true });
    expect(db.dashboardSource.update.mock.calls[0][0].data).toMatchObject({ status: "active", lastError: null });
    expect(db.dashboardSource.update.mock.calls[0][0].data.lastSyncAt).toBeInstanceOf(Date);
    await markSourceSync("src1", { ok: false, error: "401 unauthorized" });
    expect(db.dashboardSource.update.mock.calls[1][0].data).toEqual({ status: "error", lastError: "401 unauthorized" });
  });
});
