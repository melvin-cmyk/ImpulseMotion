import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  groupDashboardsByAccount,
  attentionScore,
  totalsByCurrency,
  summarize,
  toClientError,
  type PortfolioClient,
  type PortfolioKpi,
} from "@/lib/portfolio";
import { MetaApiError } from "@/lib/meta-errors";

const D = (id: string, meta: string | null, google: string | null, createdAt: string, name = id) => ({
  id, name, metaAccountId: meta, googleCustomerId: google, createdAt: new Date(createdAt),
});

describe("groupDashboardsByAccount (union-find by account)", () => {
  it("merges meta-only + combined + google-only of the same brand into one client, oldest as primary", () => {
    const rows = [
      D("combined", "123", "999", "2026-02-01", "Brand combined"),
      D("meta", "act_123", null, "2026-01-01", "Brand meta"),
      D("google", null, "999", "2026-03-01", "Brand google"),
      D("other", "555", null, "2026-01-15", "Other"),
    ];
    const { groups, unlinked } = groupDashboardsByAccount(rows);
    expect(unlinked).toEqual([]);
    expect(groups).toHaveLength(2);
    const brand = groups.find((g) => g.dashboardIds.includes("meta"))!;
    expect(brand.primary.id).toBe("meta");
    expect(brand.dashboardIds).toEqual(["meta", "combined", "google"]);
    expect(brand.duplicates).toBe(2);
    expect(brand.metaAccountId).toBe("123");
    expect(brand.googleCustomerId).toBe("999");
    const other = groups.find((g) => g.primary.id === "other")!;
    expect(other.duplicates).toBe(0);
    expect(other.googleCustomerId).toBeNull();
  });

  it("groups transitively (A~B via meta, B~C via google → one client) even across owners", () => {
    const rows = [D("a", "1", null, "2026-01-01"), D("b", "1", "g1", "2026-01-02"), D("c", null, "g1", "2026-01-03"), D("d", null, "g2", "2026-01-04")];
    const { groups } = groupDashboardsByAccount(rows);
    expect(groups.map((g) => g.dashboardIds.sort())).toEqual(expect.arrayContaining([["a", "b", "c"], ["d"]]));
  });

  it("normalises ids (act_ prefix, dashes in Google customer ids)", () => {
    const rows = [D("a", "act_42", null, "2026-01-01"), D("b", "42", "123-456-7890", "2026-01-02"), D("c", null, "1234567890", "2026-01-03")];
    const { groups } = groupDashboardsByAccount(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].metaAccountId).toBe("42");
    expect(groups[0].googleCustomerId).toBe("1234567890");
  });

  it("lists unlinked dashboards apart instead of inventing a client", () => {
    const rows = [D("ghost", null, null, "2026-01-01", "Ghost"), D("a", "1", null, "2026-01-02")];
    const { groups, unlinked } = groupDashboardsByAccount(rows);
    expect(groups).toHaveLength(1);
    expect(unlinked.map((u) => u.id)).toEqual(["ghost"]);
  });
});

const kpi = (value: number, previous: number | null = null, extra: Partial<PortfolioKpi> = {}): PortfolioKpi => ({
  value,
  previous,
  deltaPct: previous && previous > 0 ? Math.round(((value - previous) / previous) * 1000) / 10 : null,
  ...extra,
});

const baseInput = () => ({
  fetchOk: true,
  spend: kpi(1000, 1000),
  roas: kpi(3, 3),
  cpa: kpi(20, 20),
  conversions: kpi(50, 50),
  frequency: 2,
  alertCount: 0,
  pacing: null,
});

describe("attentionScore", () => {
  it("is 0 when the fetch failed", () => {
    expect(attentionScore({ ...baseInput(), fetchOk: false, roas: kpi(0.2, 3) }).score).toBe(0);
  });

  it("ROAS drop ≥ 15 % with ≥ 10 previous conversions → points, with before/after values", () => {
    const r = attentionScore({ ...baseInput(), roas: kpi(2, 4) });
    const sig = r.signals.find((s) => s.code === "roas_drop")!;
    expect(sig).toBeDefined();
    expect(sig.before).toBe(4);
    expect(sig.after).toBe(2);
    expect(sig.points).toBe(40);
    expect(r.reasons[0]).toContain("4.00x → 2.00x");
    expect(r.reasons[0]).toContain("-50 %");
  });

  it("ignores ROAS signals when revenue is estimated or unavailable", () => {
    expect(attentionScore({ ...baseInput(), roas: kpi(2, 4, { estimated: true }) }).signals.map((s) => s.code)).not.toContain("roas_drop");
    expect(attentionScore({ ...baseInput(), roas: kpi(0, 4, { unavailable: true }), spend: kpi(500, 500) }).signals.map((s) => s.code)).not.toContain("roas_low");
    expect(attentionScore({ ...baseInput(), roas: kpi(0.5, 3, { unavailable: true }), spend: kpi(500, 500) }).score).toBe(0);
  });

  it("requires ≥ 10 previous conversions for ROAS / CPA signals", () => {
    const few = { ...baseInput(), conversions: kpi(3, 5), roas: kpi(1, 4), cpa: kpi(50, 20) };
    const codes = attentionScore(few).signals.map((s) => s.code);
    expect(codes).not.toContain("roas_drop");
    expect(codes).not.toContain("cpa_up");
    expect(codes).not.toContain("roas_low");
  });

  it("conversions collapsed to 0 with spend > 100 → critical +40", () => {
    const r = attentionScore({ ...baseInput(), conversions: kpi(0, 30), spend: kpi(400, 400), roas: kpi(0, 3), cpa: kpi(0, 20) });
    const sig = r.signals.find((s) => s.code === "conversions_zero")!;
    expect(sig.points).toBe(40);
    expect(sig.before).toBe(30);
    expect(sig.after).toBe(0);
    expect(r.reasons.join(" ")).toMatch(/Conversions 30 → 0/);
  });

  it("spend move ≥ 40 % (+20) and frequency > 4 (+15) when available", () => {
    const r = attentionScore({ ...baseInput(), spend: kpi(1500, 1000), frequency: 4.5 });
    expect(r.signals.find((s) => s.code === "spend_move")?.points).toBe(20);
    expect(r.signals.find((s) => s.code === "frequency")?.points).toBe(15);
    expect(r.reasons.find((x) => x.startsWith("Dépenses"))).toMatch(/1[\s\u202f\u00a0]000 → 1[\s\u202f\u00a0]500 \(\+50 %\)/);
    expect(attentionScore({ ...baseInput(), frequency: null }).signals.map((s) => s.code)).not.toContain("frequency");
  });

  it("caps the score at 100 and adds alerts / critical pacing", () => {
    const r = attentionScore({
      ...baseInput(),
      roas: kpi(0.5, 4),
      cpa: kpi(60, 20),
      spend: kpi(2000, 1000),
      frequency: 7,
      alertCount: 3,
      pacing: { status: "critical_under", pacingPct: 40 },
    });
    expect(r.score).toBe(100);
    expect(r.signals.find((s) => s.code === "alerts")?.points).toBe(20);
    expect(r.signals.find((s) => s.code === "pacing")?.points).toBe(20);
  });
});

function client(over: Partial<PortfolioClient> & { id: string }): PortfolioClient {
  return {
    name: over.id,
    metaAccountId: "1",
    googleCustomerId: null,
    reportFrequency: null,
    owner: { id: "u", name: null, email: null },
    memberCount: 0,
    dashboardIds: [over.id],
    duplicates: 0,
    duplicateIds: [],
    range: { since: "2026-08-01", until: "2026-08-30" },
    compare: { since: "2026-07-02", until: "2026-07-31" },
    currency: "EUR",
    timezone: null,
    spend: kpi(100, 100),
    revenue: kpi(300, 300),
    roas: kpi(3, 3),
    cpa: kpi(10, 10),
    conversions: kpi(10, 10),
    frequency: null,
    estimated: false,
    fetchOk: true,
    error: null,
    errors: [],
    fetchedAt: null,
    alertCount: 0,
    lastReport: null,
    pacing: null,
    attention: 0,
    attentionReasons: [],
    attentionSignals: [],
    ...over,
  };
}

describe("totalsByCurrency / summarize", () => {
  it("never sums across currencies and computes ROAS as revenue / spend (not an average of ratios)", () => {
    const clients = [
      client({ id: "a", currency: "EUR", spend: kpi(100, 100), revenue: kpi(400, 400), roas: kpi(4, 4) }),
      client({ id: "b", currency: "EUR", spend: kpi(900, 900), revenue: kpi(900, 900), roas: kpi(1, 1) }),
      client({ id: "c", currency: "ZAR", spend: kpi(5000, 4000), revenue: kpi(10000, 8000), roas: kpi(2, 2) }),
    ];
    const t = totalsByCurrency(clients);
    expect(Object.keys(t).sort()).toEqual(["EUR", "ZAR"]);
    expect(t.EUR.spend).toBe(1000);
    expect(t.EUR.roas).toBe(1.3); // 1300 / 1000, not (4 + 1) / 2
    expect(t.ZAR.spend).toBe(5000);
    expect(t.ZAR.spendDeltaPct).toBe(25);
    const s = summarize(clients, { unlinkedCount: 0, openAlerts: 0, range: { since: "2026-08-01", until: "2026-08-30" }, compare: { since: "2026-07-02", until: "2026-07-31" }, timedOut: false, unresolved: [], now: new Date("2026-08-31T10:00:00Z") });
    expect(s.totalSpend).toBeNull();
    expect(s.currency).toBeNull();
    expect(s.weightedRoas).toBeNull();
    expect(s.rangeLabel).toContain("30 j");
  });

  it("keeps totalSpend / weightedRoas only when every client shares one currency", () => {
    const clients = [client({ id: "a", spend: kpi(100, 50) }), client({ id: "b", spend: kpi(300, 250) })];
    const s = summarize(clients, { unlinkedCount: 1, openAlerts: 2, range: { since: "2026-08-01", until: "2026-08-30" }, compare: { since: "2026-07-02", until: "2026-07-31" }, timedOut: false, unresolved: [] });
    expect(s.currency).toBe("EUR");
    expect(s.totalSpend).toBe(400);
    expect(s.prevTotalSpend).toBe(300);
    expect(s.spendDeltaPct).toBe(33.3);
    expect(s.weightedRoas).toBe(1.5); // 600 / 400
    expect(s.unlinkedCount).toBe(1);
  });

  it("excludes clients without data from totals and counts them", () => {
    const clients = [
      client({ id: "ok", spend: kpi(100, 100) }),
      client({ id: "ko", fetchOk: false, error: { kind: "rate_limit", message: "limit" }, spend: kpi(999, 999) }),
    ];
    const s = summarize(clients, { unlinkedCount: 0, openAlerts: 0, range: { since: "2026-08-01", until: "2026-08-30" }, compare: { since: "2026-07-02", until: "2026-07-31" }, timedOut: false, unresolved: [] });
    expect(s.totalSpend).toBe(100);
    expect(s.clientsWithoutData).toBe(1);
    expect(s.clientCount).toBe(2);
  });

  it("computes the spend delta on a consistent set (clients with both windows only)", () => {
    const clients = [
      client({ id: "both", spend: kpi(200, 100) }),
      client({ id: "noprev", spend: kpi(500, null) }),
    ];
    const t = totalsByCurrency(clients).EUR;
    expect(t.spend).toBe(700);
    expect(t.prevSpend).toBe(100);
    expect(t.spendForDelta).toBe(200);
    expect(t.spendDeltaPct).toBe(100);
  });

  it("drops estimated / unavailable revenue from the ROAS numerator and flags estimates", () => {
    const clients = [
      client({ id: "tracked", spend: kpi(100, 100), revenue: kpi(300, 300) }),
      client({ id: "unavailable", spend: kpi(100, 100), revenue: kpi(0, 0, { unavailable: true }), roas: kpi(0, 0, { unavailable: true }) }),
      client({ id: "estimated", spend: kpi(100, 100), revenue: kpi(100, 100, { estimated: true }), roas: kpi(1, 1, { estimated: true }), estimated: true }),
    ];
    const t = totalsByCurrency(clients).EUR;
    expect(t.spend).toBe(300);
    expect(t.spendWithRevenue).toBe(200);
    expect(t.revenue).toBe(400);
    expect(t.roas).toBe(2);
    expect(t.revenueEstimated).toBe(true);
  });
});

describe("toClientError", () => {
  it("keeps the Meta error kind", () => {
    const e = new MetaApiError({ message: "User request limit reached", code: 17, httpStatus: 400 });
    expect(toClientError(e)).toEqual({ kind: "rate_limit", message: "User request limit reached" });
    expect(toClientError(new Error("Google: relay down")).kind).toBe("google");
    expect(toClientError(new Error("boom")).kind).toBe("widget");
  });
});
