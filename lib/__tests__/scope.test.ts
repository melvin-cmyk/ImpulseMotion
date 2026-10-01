import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { ALL_ACCOUNTS, accountIdInScope, bindingOutOfScope, dashboardInScope, dashboardWhere, metaInScope, googleInScope, platformAccountInScope, tiktokInScope, type AccountScope } from "@/lib/scope";

const consultant: AccountScope = { all: false, meta: new Set(["123"]), google: new Set(["999"]), tiktok: new Set() };
const nothing: AccountScope = { all: false, meta: new Set(), google: new Set(), tiktok: new Set() };

describe("account scope", () => {
  it("admin sees everything, including unlinked dashboards", () => {
    expect(dashboardInScope(ALL_ACCOUNTS, { metaAccountId: null, googleCustomerId: null })).toBe(true);
    expect(dashboardWhere(ALL_ACCOUNTS)).toEqual({});
  });

  it("matches Meta ids with or without the act_ prefix", () => {
    expect(metaInScope(consultant, "act_123")).toBe(true);
    expect(metaInScope(consultant, "123")).toBe(true);
    expect(metaInScope(consultant, "act_456")).toBe(false);
    expect(metaInScope(consultant, null)).toBe(false);
  });

  it("a client is visible when one of its accounts is assigned", () => {
    expect(dashboardInScope(consultant, { metaAccountId: "act_123", googleCustomerId: null })).toBe(true);
    expect(dashboardInScope(consultant, { metaAccountId: "456", googleCustomerId: "999" })).toBe(true);
    expect(dashboardInScope(consultant, { metaAccountId: "456", googleCustomerId: "111" })).toBe(false);
    expect(dashboardInScope(consultant, { metaAccountId: null, googleCustomerId: null })).toBe(false);
    expect(googleInScope(consultant, "999")).toBe(true);
  });

  it("builds the equivalent Prisma filter (both Meta id variants)", () => {
    expect(dashboardWhere(consultant)).toEqual({
      OR: [{ metaAccountId: { in: ["123", "act_123"] } }, { googleCustomerId: { in: ["999"] } }],
    });
  });

  it("matches a bare account id against both platforms (alert rules & events)", () => {
    expect(accountIdInScope(consultant, "act_123")).toBe(true);
    expect(accountIdInScope(consultant, "999")).toBe(true);
    expect(accountIdInScope(consultant, "456")).toBe(false);
    // An account-agnostic rule (clientId null) spans the whole BM → admins only.
    expect(accountIdInScope(consultant, null)).toBe(false);
    expect(accountIdInScope(ALL_ACCOUNTS, null)).toBe(true);
  });

  it("refuses binding a dashboard to an account outside the scope", () => {
    // Binding grants a UserAdAccount row, so an unchecked bind = self-service ACL.
    expect(bindingOutOfScope(consultant, { metaAccountId: "act_123" })).toBe(null);
    expect(bindingOutOfScope(consultant, { googleCustomerId: "999" })).toBe(null);
    expect(bindingOutOfScope(consultant, { metaAccountId: "act_456" })).toBe("act_456");
    expect(bindingOutOfScope(consultant, { metaAccountId: "act_123", googleCustomerId: "111" })).toBe("111");
    // Unbinding (null) and admins are always allowed.
    expect(bindingOutOfScope(consultant, { metaAccountId: null, googleCustomerId: null })).toBe(null);
    expect(bindingOutOfScope(ALL_ACCOUNTS, { metaAccountId: "act_456" })).toBe(null);
  });

  it("a user with no assigned account matches nothing", () => {
    expect(dashboardInScope(nothing, { metaAccountId: "123", googleCustomerId: null })).toBe(false);
    expect(dashboardWhere(nothing)).toEqual({ id: "__none__" });
  });

  describe("TikTok", () => {
    const TT = "6869676251863318529";
    const withTikTok: AccountScope = { all: false, meta: new Set(), google: new Set(), tiktok: new Set([TT]) };
    const src = (externalId: string, status = "active") => ({ kind: "tiktok", externalId, status });

    it("sees a client through a TikTok advertiser attached as a source, not through a disabled one", () => {
      expect(tiktokInScope(withTikTok, TT)).toBe(true);
      expect(tiktokInScope(withTikTok, "7640043625339715604")).toBe(false);
      expect(dashboardInScope(withTikTok, { metaAccountId: null, googleCustomerId: null, sources: [src(TT)] })).toBe(true);
      expect(dashboardInScope(withTikTok, { metaAccountId: null, googleCustomerId: null, sources: [src(TT, "disabled")] })).toBe(false);
      // A HubSpot portal with the same digits is not a TikTok account.
      expect(dashboardInScope(withTikTok, { metaAccountId: null, googleCustomerId: null, sources: [{ kind: "hubspot", externalId: TT }] })).toBe(false);
      expect(dashboardWhere(withTikTok)).toEqual({ OR: [{ sources: { some: { kind: "tiktok", externalId: { in: [TT] }, status: { not: "disabled" } } } }] });
    });

    it("checks a TikTok id on its own platform only", () => {
      expect(accountIdInScope(withTikTok, TT)).toBe(true);
      expect(platformAccountInScope(withTikTok, "tiktok", TT)).toBe(true);
      expect(platformAccountInScope(withTikTok, "meta", TT)).toBe(false);
      expect(platformAccountInScope(withTikTok, "linkedin", TT)).toBe(false);
      expect(platformAccountInScope(ALL_ACCOUNTS, "tiktok", "1")).toBe(true);
    });

    it("refuses attaching a TikTok advertiser outside the scope", () => {
      expect(bindingOutOfScope(withTikTok, { tiktokAdvertiserIds: [TT] })).toBe(null);
      expect(bindingOutOfScope(withTikTok, { tiktokAdvertiserIds: [TT, "7640043625339715604"] })).toBe("7640043625339715604");
    });
  });
});
