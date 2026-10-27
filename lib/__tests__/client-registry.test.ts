import { describe, expect, it } from "vitest";
import { mergeSameName, type ClientRef } from "@/lib/clients/registry";

const base = (o: Partial<ClientRef>): ClientRef => ({ id: "x", clientId: "x", aliasIds: [], name: "X", accounts: [], dashboardId: null, dashboardIds: [], metaAccountId: null, googleCustomerId: null, tiktokAdvertiserIds: [], driveFolderId: null, hqSlug: null, ...o });

describe("client registry — same name, same brand", () => {
  it("merges two rows of one brand: union of accounts, the row with a dashboard leads", () => {
    const a = base({ id: "c_a", clientId: "a", name: "Le Barth Villas", accounts: [{ platform: "google", id: "111", name: "LBV Google" }] });
    const b = base({ id: "dash1", clientId: "b", name: "Le Barth  Villas", dashboardId: "dash1", dashboardIds: ["dash1"], accounts: [{ platform: "meta", id: "222", name: "LBV Meta" }, { platform: "google", id: "111", name: "LBV" }], driveFolderId: "f1" });
    const [m] = mergeSameName([a, b]);
    expect(m.clientId).toBe("b");
    expect(m.aliasIds).toEqual(["a", "c_a"]);
    expect(m.accounts.map((x) => `${x.platform}:${x.id}`).sort()).toEqual(["google:111", "meta:222"]);
    expect(m.metaAccountId).toBe("222"); expect(m.googleCustomerId).toBe("111"); expect(m.driveFolderId).toBe("f1");
  });
  it("ignores accents and case, keeps different brands apart", () => {
    const out = mergeSameName([base({ clientId: "1", name: "Émprunte Mon Toutou" }), base({ clientId: "2", name: "emprunte mon toutou" }), base({ clientId: "3", name: "Emprunte Mon Chat" })]);
    expect(out).toHaveLength(2);
  });
});
