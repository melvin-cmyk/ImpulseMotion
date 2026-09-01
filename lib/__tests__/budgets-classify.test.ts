import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { classify, monthProgress, projectPacing, pickBudget } from "@/lib/budgets";

describe("classify (budget pacing)", () => {
  it("maps pacing % to the 5 documented buckets", () => {
    expect(classify(50)).toBe("critical_under");
    expect(classify(69.9)).toBe("critical_under");
    expect(classify(70)).toBe("under");
    expect(classify(89.9)).toBe("under");
    expect(classify(90)).toBe("on_track");
    expect(classify(100)).toBe("on_track");
    expect(classify(110)).toBe("on_track");
    expect(classify(110.1)).toBe("over");
    expect(classify(130)).toBe("over");
    expect(classify(130.1)).toBe("critical_over");
  });
});

describe("monthProgress (yesterday-based, fractional)", () => {
  it("counts full days up to yesterday plus the fraction of today, in the account timezone", () => {
    // 2026-08-05 12:00 UTC = 14:00 in Johannesburg → 4 full days + 14/24
    const p = monthProgress({ tz: "Africa/Johannesburg", now: new Date("2026-08-05T12:00:00Z") });
    expect(p.first).toBe("2026-08-01");
    expect(p.lastClosed).toBe("2026-08-04");
    expect(p.fullDays).toBe(4);
    expect(p.daysElapsed).toBe(4.58);
    expect(p.daysInMonth).toBe(31);
  });

  it("has no closed day on the 1st", () => {
    const p = monthProgress({ now: new Date("2026-09-01T06:00:00Z") });
    expect(p.first).toBe("2026-09-01");
    expect(p.fullDays).toBe(0);
    expect(p.daysElapsed).toBe(0.25);
    expect(p.daysInMonth).toBe(30);
  });

  it("switches month according to the timezone", () => {
    // 2026-08-31 23:30 UTC is already 1 Sept in Johannesburg
    const p = monthProgress({ tz: "Africa/Johannesburg", now: new Date("2026-08-31T23:30:00Z") });
    expect(p.first).toBe("2026-09-01");
    expect(p.fullDays).toBe(0);
  });
});

describe("projectPacing", () => {
  it("projects from the run-rate over closed days only", () => {
    const progress = monthProgress({ now: new Date("2026-08-11T00:00:00Z") }); // 10 full days of 31
    const r = projectPacing({ monthlyTarget: 3100, mtdSpend: 1000, progress });
    expect(r.dailyRunRate).toBe(100);
    expect(r.projectedSpend).toBe(3100);
    expect(r.pacingPct).toBe(100);
    expect(r.status).toBe("on_track");
    expect(r.daysRemaining).toBe(21);
  });

  it("is unknown (never 'under') when no day is closed yet", () => {
    const progress = monthProgress({ now: new Date("2026-08-01T15:00:00Z") });
    const r = projectPacing({ monthlyTarget: 3100, mtdSpend: 0, progress });
    expect(r.status).toBe("unknown");
    expect(r.pacingPct).toBe(0);
  });
});

describe("pickBudget (Dashboard.monthlyBudget first, then AccountBudget)", () => {
  it("prefers the oldest dashboard budget", () => {
    const r = pickBudget(
      [
        { monthlyBudget: 500, budgetCurrency: null, createdAt: "2026-02-01" },
        { monthlyBudget: 900, budgetCurrency: "ZAR", createdAt: "2026-01-01" },
        { monthlyBudget: null, budgetCurrency: null, createdAt: "2025-01-01" },
      ],
      [{ monthlyTarget: 100, currency: "EUR" }],
      "USD",
    );
    expect(r).toEqual({ monthlyTarget: 900, currency: "ZAR", source: "dashboard" });
  });

  it("falls back to any AccountBudget of the account, with the account currency when the budget has none", () => {
    expect(pickBudget([{ monthlyBudget: null, budgetCurrency: null }], [{ monthlyTarget: 100, currency: "" }], "ZAR"))
      .toEqual({ monthlyTarget: 100, currency: "ZAR", source: "account_budget" });
    expect(pickBudget([], [], "ZAR")).toBeNull();
  });
});
