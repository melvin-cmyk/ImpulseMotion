import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/ads-warehouse/query", () => ({ queryAds: vi.fn() }));
import { imageUrl, window } from "@/lib/bot-ads-pack";
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
