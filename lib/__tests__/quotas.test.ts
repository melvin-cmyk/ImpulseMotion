import { describe, expect, it } from "vitest";
import { botDailyCap, checkGeneration, parisDayStart, parseQuotas, DEFAULT_QUOTAS } from "@/lib/quotas";

describe("quotas — settings", () => {
  it("falls back to the defaults and clamps the odd values", () => {
    expect(parseQuotas(null)).toEqual(DEFAULT_QUOTAS);
    expect(parseQuotas("not json")).toEqual(DEFAULT_QUOTAS);
    const q = parseQuotas(JSON.stringify({ teamDailyUsd: 20.555, userDailyUsd: -3, teamDailyImages: 50.4, botDailyMessages: 120, warnAtPct: 300 }));
    expect(q).toEqual({ teamDailyUsd: 20.56, userDailyUsd: DEFAULT_QUOTAS.userDailyUsd, teamDailyImages: 50, botDailyMessages: 120, warnAtPct: 100 });
  });
  it("bot cap: its own first, else the agency's", () => {
    const q = parseQuotas(JSON.stringify({ botDailyMessages: 40 }));
    expect(botDailyCap({ dailyMessages: null }, q)).toBe(40);
    expect(botDailyCap({ dailyMessages: 0 }, q)).toBe(0);
    expect(botDailyCap({ dailyMessages: 5 }, q)).toBe(5);
  });
});

describe("quotas — a generation against today's spend", () => {
  const q = parseQuotas(JSON.stringify({ teamDailyUsd: 10, userDailyUsd: 5, teamDailyImages: 100, warnAtPct: 80 }));
  it("passes when under every cap", () => {
    expect(checkGeneration(q, { team: { usd: 1, images: 10 }, user: { usd: 0.5, images: 4 } }, 0.08, 2)).toEqual({ ok: true });
  });
  it("warns near a cap, refuses over it", () => {
    const warn = checkGeneration(q, { team: { usd: 7.9, images: 10 }, user: { usd: 1, images: 4 } }, 0.2, 2);
    expect(warn.ok).toBe(true);
    expect(warn.warn).toMatch(/l'équipe sera à 8,10 \$ sur 10,00 \$/);
    const over = checkGeneration(q, { team: { usd: 9.95, images: 10 }, user: { usd: 1, images: 4 } }, 0.08, 2);
    expect(over.ok).toBe(false);
    expect(over.reason).toMatch(/Plafond de l'équipe atteint/);
    const user = checkGeneration(q, { team: { usd: 2, images: 10 }, user: { usd: 4.98, images: 4 } }, 0.08, 2);
    expect(user.ok).toBe(false);
    expect(user.reason).toMatch(/Ton plafond du jour/);
    const images = checkGeneration(q, { team: { usd: 2, images: 99 }, user: { usd: 1, images: 4 } }, 0, 2);
    expect(images.ok).toBe(false);
    expect(images.reason).toMatch(/images du jour/);
  });
  it("0 = no cap", () => {
    const none = parseQuotas(JSON.stringify({ teamDailyUsd: 0, userDailyUsd: 0, teamDailyImages: 0 }));
    expect(checkGeneration(none, { team: { usd: 999, images: 9999 }, user: { usd: 999, images: 9999 } }, 50, 50)).toEqual({ ok: true });
  });
});

describe("quotas — Paris day", () => {
  it("starts at Paris midnight (summer and winter)", () => {
    expect(parisDayStart(new Date("2026-07-15T10:00:00Z")).toISOString()).toBe("2026-07-14T22:00:00.000Z");
    expect(parisDayStart(new Date("2026-01-15T10:00:00Z")).toISOString()).toBe("2026-01-14T23:00:00.000Z");
    // 00:30 Paris on the 16th (summer) is still 22:30Z on the 15th: the day started 30 minutes ago.
    expect(parisDayStart(new Date("2026-07-15T22:30:00Z")).toISOString()).toBe("2026-07-15T22:00:00.000Z");
  });
});
