import { describe, expect, it, vi } from "vitest";
const aggregate = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { aiUsage: { aggregate: (...a: unknown[]) => aggregate(...a) } } }));
import { botBudgetSpent, clientBotsSpendThisMonth, DEFAULT_QUOTAS, parisMonthStart, parseQuotas } from "@/lib/quotas";

describe("budget mensuel des bots clients", () => {
  it("défaut 200 $, 0 = illimité, valeur enregistrée relue", () => {
    expect(parseQuotas(null).botMonthlyUsd).toBe(200);
    expect(parseQuotas(JSON.stringify({ botMonthlyUsd: 0 })).botMonthlyUsd).toBe(0);
    expect(parseQuotas(JSON.stringify({ botMonthlyUsd: 350.5 })).botMonthlyUsd).toBe(350.5);
  });
  it("le mois commence le 1er à minuit, heure de Paris (hiver et été)", () => {
    expect(parisMonthStart(new Date("2026-11-10T13:00:00Z")).toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(parisMonthStart(new Date("2026-07-01T00:30:00Z")).toISOString()).toBe("2026-06-30T22:00:00.000Z");
    // 31/10 23:30 UTC = 1er novembre 00:30 à Paris
    expect(parisMonthStart(new Date("2026-10-31T23:30:00Z")).toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });
  it("dépense = lignes Bedrock des bots depuis le début du mois (le staff sur abonnement n'y est pas)", async () => {
    aggregate.mockResolvedValue({ _sum: { costUsd: 12.3456 } });
    expect(await clientBotsSpendThisMonth(new Date("2026-11-10T13:00:00Z"))).toBe(12.35);
    expect(aggregate.mock.calls[0][0].where).toEqual({ provider: "bedrock", botId: { not: null }, createdAt: { gte: new Date("2026-10-31T23:00:00.000Z") } });
    aggregate.mockResolvedValue({ _sum: { costUsd: null } });
    expect(await clientBotsSpendThisMonth()).toBe(0);
  });
  it("blocage au plafond, jamais en illimité", () => {
    expect(botBudgetSpent(DEFAULT_QUOTAS, 199.99)).toBe(false);
    expect(botBudgetSpent(DEFAULT_QUOTAS, 200)).toBe(true);
    expect(botBudgetSpent({ ...DEFAULT_QUOTAS, botMonthlyUsd: 0 }, 5000)).toBe(false);
  });
});
