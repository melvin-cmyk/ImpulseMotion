import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/ads-warehouse/query", () => ({ queryAds: vi.fn() }));
const states = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { adSyncState: { findMany: (...a: unknown[]) => states(...a) } } }));
import { queryAds } from "@/lib/ads-warehouse/query";
import { buildBotAdsPack, imageUrl, window } from "@/lib/bot-ads-pack";
import { buildBotSystemPrompt } from "@/lib/bot-prompt";

describe("bot ads pack", () => {
  it("window: last N complete days and the N before", () => {
    const w = window(7, new Date("2026-11-03T10:00:00Z"));
    expect(w.range).toEqual({ since: "2026-10-27", until: "2026-11-02" });
    expect(w.compare).toEqual({ since: "2026-10-20", until: "2026-10-26" });
  });
  it("image url is same-origin and scoped to the bot", () => {
    expect(imageUrl("bot1", "meta", "123")).toBe("/api/bot/bot1/image?ad=meta%3A123");
  });
  it("the pack sits after the sources and before the date", () => {
    const p = buildBotSystemPrompt({ bot: { name: "B", businessContext: "", sources: { meta: true } }, dashboard: { name: "D" }, adsPack: "CRÉAS ET PERFORMANCES PUBLICITAIRES test" });
    const i = p.indexOf("CRÉAS ET PERFORMANCES PUBLICITAIRES test");
    expect(i).toBeGreaterThan(0);
    expect(p.indexOf("CRÉAS ET PERFORMANCES", 0)).toBeGreaterThan(p.indexOf("MÉTHODE DE TRAVAIL"));
  });
});

const metrics = (spend: number, impressions: number) => ({ spend, impressions, ctr: 0.01, cpm: 5, hookRate: 0, conversions: 0, cpa: 0, roas: 0, roasUnavailable: true, conversionValue: 0, videoPlays: 0, estimated: false });
const result = (spend: number, impressions: number) => ({ currency: "EUR", rows: [], benchmark: metrics(spend, impressions), benchmarkPrevious: null });
const NOW = new Date("2026-11-05T10:00:00Z");

describe("bot ads pack — données manquantes → recherche en direct", () => {
  it("compte absent de l'entrepôt → note ⚠ qui envoie vers l'outil Meta en direct", async () => {
    vi.mocked(queryAds).mockResolvedValue(result(0, 0) as never);
    states.mockResolvedValue([]);
    const t = await buildBotAdsPack("b-empty", { meta: "act_1" }, NOW);
    expect(t).toContain("### Meta Ads");
    expect(t).toContain("⚠ Meta Ads");
    expect(t).toContain("mcp__meta-ads-impulse__*");
  });
  it("entrepôt en retard → chiffres gardés + note ⚠ avec la date", async () => {
    vi.mocked(queryAds).mockResolvedValue(result(100, 5000) as never);
    states.mockResolvedValue([{ syncedTo: new Date("2026-11-01T00:00:00Z") }]);
    const t = await buildBotAdsPack("b-late", { meta: "1" }, NOW);
    expect(t).toContain("impressions 5");
    expect(t).toContain("à jour que jusqu'au 01/11");
  });
  it("impressions à zéro malgré la dépense → note ⚠", async () => {
    vi.mocked(queryAds).mockResolvedValue(result(100, 0) as never);
    states.mockResolvedValue([{ syncedTo: new Date("2026-11-04T00:00:00Z") }]);
    const t = await buildBotAdsPack("b-noimp", { meta: "1" }, NOW);
    expect(t).toContain("impressions absentes");
  });
  it("entrepôt à jour et complet → aucune note", async () => {
    vi.mocked(queryAds).mockResolvedValue(result(100, 5000) as never);
    states.mockResolvedValue([{ syncedTo: new Date("2026-11-04T00:00:00Z") }]);
    const t = await buildBotAdsPack("b-ok", { meta: "1" }, NOW);
    expect(t).not.toContain("⚠ Meta");
  });
});

describe("bot ads pack — visuels", () => {
  it("demande toujours les visuels et donne le modèle d'adresse pour une créa trouvée en direct", async () => {
    vi.mocked(queryAds).mockResolvedValue(result(100, 5000) as never);
    states.mockResolvedValue([{ syncedTo: new Date("2026-11-04T00:00:00Z") }]);
    const t = await buildBotAdsPack("bot9", { meta: "1" }, NOW);
    expect(t).toContain("LES CLIENTS VEULENT VOIR LEURS CRÉAS");
    expect(t).toContain("/api/bot/bot9/image?ad=PLATEFORME%3AID");
  });
});
