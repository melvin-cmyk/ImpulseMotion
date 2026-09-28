import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_MAP, buildGuidePrompt, guidePaths, guideQuestion, safeGuideLinks } from "@/lib/app-guide";
import { effectiveRole, isRealAdminPath } from "@/lib/roles";

const APP = join(__dirname, "../../app");
const pageOf = (path: string) => [path, `(analyse)${path}`].some((p) => existsSync(join(APP, p, "page.tsx")));

describe("the guide knows the application", () => {
  it("only names pages that exist", () => {
    const missing = guidePaths().filter((p) => !pageOf(p));
    expect(missing).toEqual([]);
  });

  it("names every page of the staff menu", () => {
    for (const path of ["/cockpit", "/portfolio", "/reports", "/creatives", "/ai", "/d", "/bot", "/admin", "/admin/bots", "/admin/alerts", "/admin/auto-alerts", "/admin/usage", "/settings", "/me/alerts", "/me/budgets"]) {
      expect(APP_MAP).toContain(`(${path})`);
    }
  });

  it("stays small", () => {
    // About four characters per token: the whole prompt stays around two thousand tokens.
    expect(buildGuidePrompt().length).toBeLessThan(9000);
  });

  it("keeps its instructions identical for everybody, so that they are cached", () => {
    expect(buildGuidePrompt()).toBe(buildGuidePrompt());
    expect(buildGuidePrompt()).not.toContain("/reports)\nLe consultant");
    expect(guideQuestion("où sont les rapports ?", "/cockpit")).toBe("(page actuelle : /cockpit)\noù sont les rapports ?");
    expect(guideQuestion("où sont les rapports ?", null)).toBe("où sont les rapports ?");
  });

  it("keeps the links of the map and drops the others", () => {
    expect(safeGuideLinks("Allez sur [Rapports IA](/reports) puis [Clients](/portfolio/).")).toBe("Allez sur [Rapports IA](/reports) puis [Clients](/portfolio).");
    expect(safeGuideLinks("Voir [ici](https://exemple.com/x) ou [là](/admin/secret).")).toBe("Voir ici ou là.");
  });
});

describe("roles", () => {
  it("applies the admin role to a consultant, and leaves a client a client", () => {
    expect(effectiveRole("consultant")).toBe("admin");
    expect(effectiveRole("admin")).toBe("admin");
    expect(effectiveRole("client")).toBe("client");
    expect(effectiveRole(undefined)).toBe("client");
  });

  it("keeps people management apart", () => {
    expect(isRealAdminPath("/admin")).toBe(true);
    expect(isRealAdminPath("/admin/users/abc")).toBe(true);
    expect(isRealAdminPath("/api/admin/users/abc/ad-accounts")).toBe(true);
    expect(isRealAdminPath("/admin/auto-alerts")).toBe(false);
    expect(isRealAdminPath("/admin/bots")).toBe(true);
    expect(isRealAdminPath("/api/admin/bots/abc/access")).toBe(true);
    expect(isRealAdminPath("/admin/alerts")).toBe(false);
    expect(isRealAdminPath("/admin/usersettings")).toBe(false);
  });
});
