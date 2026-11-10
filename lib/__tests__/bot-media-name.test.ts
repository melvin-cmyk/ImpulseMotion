import { describe, it, expect, vi, beforeEach } from "vitest";

const loadBot = vi.fn();
const findFirst = vi.fn();
vi.mock("@/lib/bot-access", () => ({ loadBotFor: (...a: unknown[]) => loadBot(...a) }));
vi.mock("@/lib/prisma", () => ({ prisma: { adCatalog: { findFirst: (...a: unknown[]) => findFirst(...a), findUnique: vi.fn(async () => null) } } }));
vi.mock("@/lib/tiktok-accounts", () => ({ getDashboardTikTokIds: async () => ["tt1"] }));
const graph = vi.fn();
vi.mock("@/lib/meta-api", () => ({ getMetaSystemToken: () => "", metaGraphGet: (...a: unknown[]) => graph(...a) }));
vi.mock("@/lib/meta-comments", () => ({ pageToken: vi.fn() }));

import { botAd, botAdByName } from "@/lib/bot-media";

const S = { userId: "c1", role: "client" } as never;

beforeEach(() => { loadBot.mockReset(); findFirst.mockReset(); graph.mockReset(); });

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

  it("nom écrit à la place de l'identifiant (ad=meta:Nom) : retrouvé par le nom", async () => {
    loadBot.mockResolvedValue({ status: 200, bot: { dashboard: { id: "d1", metaAccountId: "44", googleCustomerId: null } } });
    findFirst.mockResolvedValue({ platform: "meta", adId: "9", imageUrl: "https://x", thumbnailUrl: null, videoId: null });
    const r = await botAd(S, "b1", "meta:W42Y26 - SGL - IMG - laponie");
    expect("ad" in r && r.ad.adId).toBe("9");
    expect(findFirst.mock.calls[0][0].where.name).toEqual({ equals: "W42Y26 - SGL - IMG - laponie", mode: "insensitive" });
    expect(findFirst.mock.calls[0][0].where.OR[0]).toEqual({ platform: "meta", accountId: "44" });
  });
  it("adresse vide : toujours refusée", async () => {
    loadBot.mockResolvedValue({ status: 200, bot: { dashboard: { id: "d1", metaAccountId: "44", googleCustomerId: null } } });
    expect(await botAd(S, "b1", "")).toMatchObject({ status: 400 });
  });

  it("pub Meta pas encore dans l'entrepôt : lue en direct, seulement sur le compte du bot", async () => {
    loadBot.mockResolvedValue({ status: 200, bot: { dashboard: { id: "d1", metaAccountId: "act_44", googleCustomerId: null } } });
    graph.mockResolvedValueOnce({ account_id: "44", creative: { id: "c1", video_id: "v1" } }).mockResolvedValueOnce({ thumbnail_url: "https://cdn/t.jpg" });
    const r = await botAd(S, "b1", "meta:1201");
    expect(r).toEqual({ ad: { platform: "meta", adId: "1201", imageUrl: "https://cdn/t.jpg", thumbnailUrl: null, videoId: "v1", live: true } });
    // the ad of another account is refused
    graph.mockResolvedValueOnce({ account_id: "99", creative: { id: "c2", image_url: "https://cdn/x.jpg" } });
    expect(await botAd(S, "b1", "meta:1202")).toMatchObject({ status: 404 });
    // Meta unreadable → 404, never an error
    graph.mockRejectedValueOnce(new Error("boom"));
    expect(await botAd(S, "b1", "meta:1203")).toMatchObject({ status: 404 });
  });
});
