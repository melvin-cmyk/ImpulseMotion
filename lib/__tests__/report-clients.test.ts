import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/cockpit/fetch", () => ({ listMetaAccounts: vi.fn(), listGoogleAccounts: vi.fn() }));
vi.mock("@/lib/cockpit/build", () => ({ syncAccounts: vi.fn() }));

import { buildPending, parsePendingId, pendingId, type PendingInput } from "@/lib/report-clients";
import { aclVersion } from "@/lib/acl-version";

const input = (over: Partial<PendingInput>): PendingInput => ({
  scope: { meta: [], google: [] }, covered: { meta: new Set(), google: new Set() }, labels: new Map(), groups: [], ...over,
});

describe("clients without a dashboard", () => {
  it("lists the assigned accounts no dashboard covers", () => {
    const list = buildPending(input({
      scope: { meta: ["act_111111", "222222"], google: ["333-333-3333"] },
      covered: { meta: new Set(["222222"]), google: new Set() },
      labels: new Map([["meta:111111", "Vorwerk"]]),
    }));
    expect(list.map((c) => [c.name, c.metaAccountId, c.googleCustomerId])).toEqual([["Compte 3333333333", null, "3333333333"], ["Vorwerk", "111111", null]]);
  });

  it("puts the Meta and Google accounts of one client side by side, under its name", () => {
    const list = buildPending(input({
      scope: { meta: ["111111"], google: ["3333333333"] },
      groups: [{ name: "Naturalia", accounts: [{ platform: "meta", accountId: "111111", name: "Naturalia IA" }, { platform: "google", accountId: "3333333333", name: "NATURALIA SAS" }] }],
    }));
    expect(list).toEqual([{ id: "account:meta=111111,google=3333333333", name: "Naturalia", metaAccountId: "111111", googleCustomerId: "3333333333" }]);
  });

  it("tells apart the accounts of a client that has several on a platform", () => {
    const list = buildPending(input({
      scope: { meta: ["111111", "222222"], google: [] },
      groups: [{ name: "Cotton Bird", accounts: [{ platform: "meta", accountId: "111111", name: "Cotton Bird España" }, { platform: "meta", accountId: "222222", name: "Cotton Bird Nederland" }] }],
    }));
    expect(list.map((c) => c.name)).toEqual(["Cotton Bird — Cotton Bird España", "Cotton Bird — Cotton Bird Nederland"]);
  });

  it("reads back the id it wrote and nothing else", () => {
    expect(parsePendingId(pendingId("111111", null))).toEqual({ metaAccountId: "111111", googleCustomerId: null });
    expect(parsePendingId(pendingId(null, "3333333333"))).toEqual({ metaAccountId: null, googleCustomerId: "3333333333" });
    expect(parsePendingId("cmtbhxw5p00016lg0w01nwl6g")).toBeNull();
    expect(parsePendingId("account:")).toBeNull();
    expect(parsePendingId("account:meta=1 or 1=1")).toBeNull();
  });
});

describe("aclVersion", () => {
  it("changes with the role and with the accounts, not with their order", () => {
    const a = [{ platform: "meta", accountId: "act_1" }, { platform: "google", accountId: "2" }];
    expect(aclVersion("consultant", a)).toBe(aclVersion("consultant", [...a].reverse()));
    expect(aclVersion("consultant", a)).not.toBe(aclVersion("admin", a));
    expect(aclVersion("consultant", a)).not.toBe(aclVersion("consultant", a.slice(0, 1)));
    expect(aclVersion("consultant", a)).not.toBe(aclVersion("consultant", [a[0], { platform: "google", accountId: "3" }]));
  });
});

describe("TikTok accounts without a dashboard", () => {
  const TT = "7000000000000000001";
  it("lists an assigned TikTok advertiser no dashboard carries, on its own", () => {
    const list = buildPending(input({
      scope: { meta: [], google: [], tiktok: [TT, "7000000000000000002"] },
      covered: { meta: new Set(), google: new Set(), tiktok: new Set(["7000000000000000002"]) },
      labels: new Map([[`tiktok:${TT}`, "Jow TikTok"]]),
    }));
    expect(list).toEqual([{ id: `account:tiktok=${TT}`, name: "Jow TikTok", metaAccountId: null, googleCustomerId: null, tiktokAdvertiserId: TT }]);
  });

  it("round-trips a TikTok pending id; meta/google ids are unchanged", () => {
    expect(parsePendingId(pendingId(null, null, TT))).toEqual({ metaAccountId: null, googleCustomerId: null, tiktokAdvertiserId: TT });
    expect(parsePendingId(pendingId("111111", null))).toEqual({ metaAccountId: "111111", googleCustomerId: null });
    expect(parsePendingId("account:tiktok=12")).toBeNull();
  });
});
