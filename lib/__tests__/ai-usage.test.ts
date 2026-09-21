import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { aiUsage: { create: (...a: unknown[]) => create(...a) } } }));

import { parseUsageEvent, recordBotUsage, summarizeUsage, monthRange, usageCsv, type UsageRow } from "@/lib/ai-usage";

beforeEach(() => create.mockReset());

const EVENT = {
  type: "usage", cost: 0.0421, turns: 3, duration: 8123.6, provider: "bedrock", model: "eu.anthropic.claude-sonnet-4-6",
  tokens: { input: 120, output: 640, cacheRead: 9000, cacheWrite: 2200 },
};

describe("parseUsageEvent", () => {
  it("lit l'événement usage du relay", () => {
    expect(parseUsageEvent(EVENT)).toEqual({
      provider: "bedrock", model: "eu.anthropic.claude-sonnet-4-6", costUsd: 0.0421, turns: 3, durationMs: 8124,
      inputTokens: 120, outputTokens: 640, cacheReadTokens: 9000, cacheWriteTokens: 2200,
    });
  });

  it("ignore les autres événements et tolère un relay plus ancien (sans tokens)", () => {
    expect(parseUsageEvent({ type: "delta", text: "x" })).toBeNull();
    expect(parseUsageEvent(null)).toBeNull();
    expect(parseUsageEvent({ type: "usage", cost: "NaN", turns: -2 })).toMatchObject({ provider: "unknown", costUsd: 0, turns: 0, inputTokens: 0 });
  });
});

describe("recordBotUsage", () => {
  const bot = { id: "b1", clientKey: "lpev", dashboard: { id: "d1", name: "LPEV" } };
  const user = { id: "u1", email: "c@lpev.fr", role: "client" };

  it("écrit une ligne avec le nom du client figé", async () => {
    await recordBotUsage({ usage: parseUsageEvent(EVENT)!, bot, user });
    expect(create.mock.calls[0][0].data).toMatchObject({
      provider: "bedrock", feature: "client_bot", dashboardId: "d1", clientName: "LPEV", clientKey: "lpev",
      userEmail: "c@lpev.fr", userRole: "client", outputTokens: 640, costUsd: 0.0421,
    });
  });

  it("n'enregistre rien hors Bedrock", async () => {
    await recordBotUsage({ usage: { ...parseUsageEvent(EVENT)!, provider: "subscription" }, bot, user });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("summarizeUsage", () => {
  const row = (o: Partial<UsageRow>): UsageRow => ({
    dashboardId: "d1", clientName: "LPEV", clientKey: "lpev", userEmail: "c@lpev.fr", userRole: "client",
    inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1, ...o,
  });

  it("sépare le facturable (clients) des tests staff, par client, trié par volume de tokens", () => {
    const out = summarizeUsage([
      row({}), row({}),
      row({ userEmail: "melvin@impulse-analytics.com", userRole: "admin", outputTokens: 2 }),
      row({ dashboardId: "d2", clientName: "Sumix", clientKey: null, cacheWriteTokens: 50000 }),
    ]);
    expect(out.map((c) => c.clientName)).toEqual(["Sumix", "LPEV"]);
    const lpev = out[1];
    // the four token kinds stay apart: AWS prices each differently
    expect(lpev.billable).toEqual({ messages: 2, inputTokens: 20, cacheWriteTokens: 2, cacheReadTokens: 10, outputTokens: 40 });
    expect(lpev.staff).toMatchObject({ messages: 1, outputTokens: 2 });
    expect(lpev.users.map((u) => u.email)).toEqual(["c@lpev.fr", "melvin@impulse-analytics.com"]);
  });

  it("garde l'historique d'un dashboard supprimé (sans id) sous son nom", () => {
    const out = summarizeUsage([row({ dashboardId: null }), row({ dashboardId: null })]);
    expect(out).toHaveLength(1);
    expect(out[0].billable.messages).toBe(2);
  });
});

describe("monthRange / usageCsv", () => {
  it("borne le mois en UTC et retombe sur le mois courant", () => {
    const r = monthRange("2026-12");
    expect(r.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(monthRange("2026-13", new Date("2026-09-21T10:00:00Z")).month).toBe("2026-09");
    expect(monthRange(null, new Date("2026-09-21T10:00:00Z")).month).toBe("2026-09");
  });

  it("exporte une ligne par client × utilisateur, cellules échappées", () => {
    const clients = summarizeUsage([{
      dashboardId: "d1", clientName: "Saveurs; Vie", clientKey: null, userEmail: "a@b.fr", userRole: "client",
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
    }]);
    const csv = usageCsv("2026-09", clients).trim().split("\n");
    expect(csv).toHaveLength(2);
    expect(csv[0]).toContain("tokens_entree;tokens_cache_ecrit;tokens_cache_lu;tokens_sortie");
    expect(csv[1]).toBe('2026-09;"Saveurs; Vie";;a@b.fr;client;oui;1;1;4;3;2');
  });
});
