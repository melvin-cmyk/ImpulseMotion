/**
 * TikTok advertisers attached to a client (lib/tiktok-accounts.ts): what is
 * accepted as an id, and how TikTok's answer about an advertiser is read.
 * The error envelope is the API's own, read on 2026-09-30.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const relayDirectTool = vi.fn();
const findMany = vi.fn();
const upsert = vi.fn();
vi.mock("@/lib/relay-tool", () => ({ relayDirectTool: (...a: unknown[]) => relayDirectTool(...a) }));
vi.mock("@/lib/prisma", () => ({ prisma: { dashboardSource: { findMany: (...a: unknown[]) => findMany(...a), upsert: (...a: unknown[]) => upsert(...a) } } }));

import { attachTikTokAdvertiser, checkAdvertiser, dashboardsWithAdvertiser, getDashboardTikTokIds, normalizeAdvertiserId, parseAdvertiserInfo } from "@/lib/tiktok-accounts";

const ID = "7111111111111111111";
const ok = (row: Record<string, unknown>) => ({ code: 0, message: "OK", request_id: "r", data: { list: [row] } });

beforeEach(() => { relayDirectTool.mockReset(); findMany.mockReset(); upsert.mockReset(); });

describe("normalizeAdvertiserId", () => {
  it("keeps digits, whatever the spaces pasted with them", () => {
    expect(normalizeAdvertiserId(ID)).toBe(ID);
    expect(normalizeAdvertiserId(` ${ID}\n`)).toBe(ID);
    expect(normalizeAdvertiserId("7111 1111 1111 1111 111")).toBe(ID);
  });

  it("refuses anything that is not an advertiser id", () => {
    for (const bad of ["", "abc", "act_123456", "123", "7111111111111111111.0", "-7111111111111111111", '["7111111111111111111"]', "7111111111111111111,7222222222222222222", "1".repeat(26), 7111111111111111111, null, undefined, ["7111111111111111111"]]) {
      expect(normalizeAdvertiserId(bad)).toBeNull();
    }
  });
});

describe("parseAdvertiserInfo", () => {
  it("reads the name, currency and timezone of the account", () => {
    expect(parseAdvertiserInfo(ok({ advertiser_id: ID, name: " Client Démo ", currency: "eur", timezone: "Etc/GMT-1", display_timezone: "Europe/Paris", status: "STATUS_ENABLE", balance: 12 }), ID))
      .toEqual({ ok: true, advertiser: { id: ID, name: "Client Démo", currency: "EUR", timezone: "Europe/Paris", status: "STATUS_ENABLE" } });
  });

  it("reads an answer the relay returns wrapped in a list", () => {
    expect(parseAdvertiserInfo([ok({ advertiser_id: ID, name: "Client" })], ID)).toMatchObject({ ok: true, advertiser: { name: "Client", currency: null, timezone: null } });
  });

  it("says why TikTok refused", () => {
    const out = parseAdvertiserInfo({ code: 40001, message: "The advertiser 7000000000000000001 doesn't exist or has been deleted.", request_id: "r", data: {} }, "7000000000000000001");
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toContain("doesn't exist");
  });

  it("refuses an answer about another account", () => {
    expect(parseAdvertiserInfo(ok({ advertiser_id: "7222222222222222222", name: "Autre client" }), ID).ok).toBe(false);
  });

  it("does not compare an id that arrived as a number (its last digits are lost)", () => {
    expect(parseAdvertiserInfo(ok({ advertiser_id: 7111111111111111000, name: "Client" }), ID).ok).toBe(true);
  });

  it("refuses an empty or unreadable answer", () => {
    for (const bad of [null, "texte", { code: 0, data: { list: [] } }, { code: 0, data: {} }, { code: 0, data: { list: [{ advertiser_id: ID }] } }, {}]) {
      expect(parseAdvertiserInfo(bad, ID).ok).toBe(false);
    }
  });
});

describe("checkAdvertiser", () => {
  it("asks the relay for this advertiser only, in the form the tool takes", async () => {
    relayDirectTool.mockResolvedValue(ok({ advertiser_id: ID, name: "Client" }));
    expect((await checkAdvertiser(ID)).ok).toBe(true);
    expect(relayDirectTool).toHaveBeenCalledTimes(1);
    expect(relayDirectTool.mock.calls[0].slice(0, 2)).toEqual(["mcp-tiktok-ads.get_advertiser_info", { advertiser_ids: `["${ID}"]` }]);
  });

  it("never calls TikTok with something that is not an id", async () => {
    for (const bad of ["abc", ` ${ID}`, `${ID},7222222222222222222`, '["7222222222222222222"]']) expect((await checkAdvertiser(bad)).ok).toBe(false);
    expect(relayDirectTool).not.toHaveBeenCalled();
  });

  it("turns a relay failure into a message, not an exception", async () => {
    relayDirectTool.mockRejectedValue(new Error("Relay unreachable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await checkAdvertiser(ID);
    expect(out.ok).toBe(false);
    // The cause goes to the logs, not to the consultant's screen.
    expect(!out.ok && out.error).not.toContain("Relay");
    expect(String(logged.mock.calls[0])).toContain("Relay unreachable");
    logged.mockRestore();
  });
});

describe("what is stored on a dashboard", () => {
  it("lists the advertisers in service, and only well-formed ids", async () => {
    findMany.mockResolvedValue([{ externalId: ID }, { externalId: "pas-un-id" }, { externalId: " 7222222222222222222 " }]);
    expect(await getDashboardTikTokIds("d1")).toEqual([ID, "7222222222222222222"]);
    expect(findMany.mock.calls[0][0].where).toEqual({ dashboardId: "d1", kind: "tiktok", status: { not: "disabled" } });
  });

  it("names the other dashboards an advertiser is already attached to, once each", async () => {
    findMany.mockResolvedValue([{ dashboard: { name: "Client A" } }, { dashboard: { name: "Client A" } }, { dashboard: { name: "Client B" } }]);
    expect(await dashboardsWithAdvertiser(ID, "d1")).toEqual(["Client A", "Client B"]);
    expect(findMany.mock.calls[0][0].where).toEqual({ kind: "tiktok", externalId: ID, dashboardId: { not: "d1" } });
  });

  it("stores the checked account under its id, with its name and settings", async () => {
    upsert.mockResolvedValue({ id: "s1" });
    await attachTikTokAdvertiser("d1", { id: ID, name: "Client", currency: "EUR", timezone: "Europe/Paris", status: "STATUS_ENABLE" });
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ dashboardId_kind_externalId: { dashboardId: "d1", kind: "tiktok", externalId: ID } });
    expect(arg.create).toMatchObject({ dashboardId: "d1", kind: "tiktok", externalId: ID, label: "Client", status: "active" });
    expect(JSON.parse(arg.create.config)).toEqual({ currency: "EUR", timezone: "Europe/Paris" });
    expect("secretEnc" in arg.create).toBe(false);
  });
});
