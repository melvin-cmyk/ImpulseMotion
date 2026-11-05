import { describe, it, expect, vi, beforeEach } from "vitest";

const loadBot = vi.fn();
const findFirst = vi.fn();
vi.mock("@/lib/bot-access", () => ({ loadBotFor: (...a: unknown[]) => loadBot(...a) }));
vi.mock("@/lib/prisma", () => ({ prisma: { adCatalog: { findFirst: (...a: unknown[]) => findFirst(...a), findUnique: vi.fn() } } }));
vi.mock("@/lib/tiktok-accounts", () => ({ getDashboardTikTokIds: async () => ["tt1"] }));
vi.mock("@/lib/meta-api", () => ({ getMetaSystemToken: () => "", metaGraphGet: vi.fn() }));
vi.mock("@/lib/meta-comments", () => ({ pageToken: vi.fn() }));

import { botAdByName } from "@/lib/bot-media";

const S = { userId: "c1", role: "client" } as never;

beforeEach(() => { loadBot.mockReset(); findFirst.mockReset(); });

describe("botAdByName — visuel d'une créa trouvée par son nom", () => {
  it("cherche le nom exact sur les seuls comptes du bot", async () => {
    loadBot.mockResolvedValue({ status: 200, bot: { dashboard: { id: "d1", metaAccountId: "act_44", googleCustomerId: "123-456" } } });
    findFirst.mockResolvedValue({ platform: "meta", adId: "9", imageUrl: "https://x", thumbnailUrl: null, videoId: null });
    const r = await botAdByName(S, "b1", " DPA - CAR - IMG ");
    expect("ad" in r && r.ad.adId).toBe("9");
    const where = findFirst.mock.calls[0][0].where;
    expect(where.name).toEqual({ equals: "DPA - CAR - IMG", mode: "insensitive" });
    expect(where.OR).toEqual([{ platform: "meta", accountId: "44" }, { platform: "google", accountId: "123456" }, { platform: "tiktok", accountId: "tt1" }]);
  });
  it("refuse sans accès au bot, 404 si aucun nom ne correspond", async () => {
    loadBot.mockResolvedValue({ status: 403 });
    expect(await botAdByName(S, "b1", "X")).toMatchObject({ status: 403 });
    loadBot.mockResolvedValue({ status: 200, bot: { dashboard: { id: "d1", metaAccountId: "44", googleCustomerId: null } } });
    findFirst.mockResolvedValue(null);
    expect(await botAdByName(S, "b1", "Inconnue")).toMatchObject({ status: 404 });
  });

  it("nom raccourci par l'IA : retrouvé par le début du nom", async () => {
    loadBot.mockResolvedValue({ status: 200, bot: { dashboard: { id: "d1", metaAccountId: "44", googleCustomerId: null } } });
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ platform: "google", adId: "7", imageUrl: null, thumbnailUrl: "https://t", videoId: "yt" });
    const r = await botAdByName(S, "b1", "W5Y26 - SGL - VID - [g-");
    expect("ad" in r && r.ad.adId).toBe("7");
    expect(findFirst.mock.calls[1][0].where.name).toEqual({ startsWith: "W5Y26 - SGL - VID - [g-", mode: "insensitive" });
  });
});
