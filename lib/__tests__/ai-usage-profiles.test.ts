import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { profilesCsv, summarizeByUser } from "@/lib/ai-usage";

const row = (over: Partial<Parameters<typeof summarizeByUser>[0][number]>) => ({
  dashboardId: null, clientName: "—", clientKey: null, userEmail: null, userRole: "admin", userId: null,
  feature: "console", provider: "subscription", costUsd: 0,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...over,
});

describe("usage per profile", () => {
  const rows = [
    row({ userId: "u1", userEmail: "pierre@impulse.fr", feature: "console", inputTokens: 100, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 50, costUsd: 0.014 }),
    row({ userId: "u1", userEmail: "pierre@impulse.fr", feature: "guide", outputTokens: 100, costUsd: 0.004 }),
    // A report records the person by id only.
    row({ userId: "u1", feature: "report", userRole: "staff", outputTokens: 400 }),
    row({ userId: "u2", userEmail: "client@marque.fr", userRole: "client", feature: "client_bot", provider: "bedrock", inputTokens: 300, outputTokens: 200 }),
    row({ feature: "auto_alert", userRole: "system", outputTokens: 500 }),
    row({ feature: "alert_ai", userRole: "system", outputTokens: 500 }),
  ];
  const profiles = summarizeByUser(rows);

  it("gathers every surface of a person, biggest consumer first", () => {
    expect(profiles.map((p) => p.key)).toEqual(["u1", "system", "u2"]);
    const pierre = profiles[0];
    expect(pierre).toMatchObject({ email: "pierre@impulse.fr", messages: 3, tokens: 1500, inputTokens: 100, cacheReadTokens: 800, outputTokens: 550 });
    expect(pierre.features.map((f) => [f.feature, f.tokens])).toEqual([["console", 1000], ["report", 400], ["guide", 100]]);
    expect(pierre.costUsd).toBe(0.02);
  });

  it("keeps what the application runs by itself on one line", () => {
    expect(profiles[1]).toMatchObject({ key: "system", role: "system", messages: 2, tokens: 1000 });
  });

  it("tells the subscription from Bedrock and sums to the month", () => {
    expect(profiles[2]).toMatchObject({ bedrockTokens: 500, subscriptionTokens: 0 });
    expect(profiles[0]).toMatchObject({ bedrockTokens: 0, subscriptionTokens: 1500 });
    expect(profiles.reduce((s, p) => s + p.tokens, 0)).toBe(3000);
    expect(profiles.reduce((s, p) => s + p.share, 0)).toBeCloseTo(1);
    expect(profiles[0].share).toBe(0.5);
  });

  it("exports one line per profile and surface", () => {
    const csv = profilesCsv("2026-09", profiles.map((p) => (p.key === "u1" ? { ...p, name: "Pierre; Martin" } : p)));
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(1 + 3 + 2 + 1);
    expect(lines[1]).toBe('2026-09;"Pierre; Martin";pierre@impulse.fr;admin;console;1;100;50;800;50;1000');
    expect(lines[4]).toContain("Automatique");
  });
});
