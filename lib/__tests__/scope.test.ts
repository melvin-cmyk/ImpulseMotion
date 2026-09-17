import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { ALL_ACCOUNTS, accountIdInScope, bindingOutOfScope, dashboardInScope, dashboardWhere, metaInScope, googleInScope, type AccountScope } from "@/lib/scope";

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
});
