import { describe, expect, it } from "vitest";
import { buildClient, classify, pacingOf, seriesMetrics, sortClients, worsening, type ClientInput, type WeekPoint } from "@/lib/cockpit/engine";
import { accountLabel, accountMatches, matchAccounts } from "@/lib/cockpit/match";
import { brandToken, commonName, parseAmount, parseBudgetSheet, parseCsv, parseMonth, parsePlatform, sheetClients } from "@/lib/cockpit/sheet";
import { bucket, cockpitCalendar } from "@/lib/cockpit/weeks";
import { parseEcb } from "@/lib/cockpit/fx";

const week = (spend: number, conv: number, value = 0, impressions = 100_000, clicks = 1000): WeekPoint => ({ spend, conv, value, impressions, clicks });
const flat = (n: number, w: WeekPoint): WeekPoint[] => Array.from({ length: n }, () => ({ ...w }));
const ctx = { fx: { EUR: 1, USD: 0.9, ZAR: 0.05 }, month: { elapsed: 27, days: 30 } };
const client = (over: Partial<ClientInput>): ClientInput => ({
  key: "demo", name: "Demo", kpi_mode: "cpa", team: null, target_roas: null, target_cpl: null,
  budgets: { meta: null, google: null }, platforms: [], ...over,
});
const meta = (weeks: WeekPoint[], over: Partial<ClientInput["platforms"][number]> = {}) => ({
  key: "meta", plat: "meta" as const, label: "Meta", accountId: "1", ccy: "EUR", mode: "cpa" as const,
  weeks, mtd: 0, budget: null, err: null, ...over,
});

describe("cockpit engine", () => {
  it("compares the week with the 8 previous ones and with the week before", () => {
    const m = seriesMetrics([...flat(8, week(1000, 50)), week(1500, 50)], "cpa");
    expect(m.spend).toBe(1500);
    expect(m.n_base).toBe(8);
    expect(m.spend_d).toBeCloseTo(0.5);
    expect(m.kpi).toBe(30);
    expect(m.kpi_base).toBe(20);
    expect(m.kpi_d).toBeCloseTo(0.5);
    expect(m.spend_d_wow).toBeCloseTo(0.5);
    expect(m.weeks).toHaveLength(9);
  });

  it("reads ROAS the other way round and splits the drift by funnel step", () => {
    const m = seriesMetrics([...flat(8, week(1000, 20, 5000, 100_000, 1000)), week(1000, 10, 2500, 100_000, 1000)], "roas");
    expect(m.kpi).toBe(2.5);
    expect(worsening(m.kpi_d, "roas")).toBeCloseTo(0.5);
    expect(m.diag?.cvr).toBeCloseTo(-0.5);
    expect(m.diag?.cpm).toBeCloseTo(0);
    expect(m.diag?.aov).toBeCloseTo(0);
  });

  it("flags zero conversion and low volume instead of a meaningless KPI", () => {
    const zero = seriesMetrics([...flat(8, week(1000, 50)), week(1000, 0)], "cpa");
    expect(zero.zero_conv).toBe(true);
    expect(zero.kpi_d).toBeNull();
    const low = seriesMetrics([...flat(8, week(1000, 50)), week(1000, 4)], "cpa");
    expect(low.low_vol).toBe(true);
    expect(seriesMetrics(flat(9, week(1000, 0)), "brand").zero_conv).toBe(false);
  });

  it("ignores weeks without spend in the baseline", () => {
    const m = seriesMetrics([...flat(6, week(0, 0)), ...flat(2, week(1000, 50)), week(1000, 50)], "cpa");
    expect(m.n_base).toBe(2);
    expect(m.spend_base).toBe(1000);
  });

  it("paces the budget against the share of the month elapsed", () => {
    const p = pacingOf(10_000, 6900, { elapsed: 27, days: 30 })!;
    expect(p.pct_spent).toBe(0.69);
    expect(p.pct_month).toBe(0.9);
    expect(p.daily_needed).toBe(1033);
    expect(pacingOf(null, 100, { elapsed: 1, days: 30 })).toBeNull();
    expect(pacingOf(1000, 1500, { elapsed: 27, days: 30 })!.daily_needed).toBe(0);
  });

  it("raises an urgency only on a big account with a strong drift", () => {
    const drift = [...flat(8, week(20_000, 1000)), week(20_000, 600)];
    const big = buildClient(client({ platforms: [meta(drift)] }), ctx);
    expect(big.alert.severity).toBe("urgent");
    expect(big.alert.category).toBe("performance");
    expect(big.alert.reason).toBe("Meta : dégradation du KPI de 67%");
    const small = buildClient(client({ platforms: [meta(drift.map((w) => ({ ...w, spend: w.spend / 10, conv: w.conv / 10 })))] }), ctx);
    expect(small.alert.severity).toBe("action");
  });

  it("keeps the most severe finding and says nothing when all is in range", () => {
    const calm = buildClient(client({ platforms: [meta(flat(9, week(2000, 100)))] }), ctx);
    expect(calm.alert).toEqual({ severity: "ok", category: "delivery", reason: "Aucun seuil franchi", next_action: "" });
    const budget = buildClient(client({ budgets: { meta: 10_000, google: null }, platforms: [meta(flat(9, week(2000, 100)), { mtd: 6900, budget: 10_000 })] }), ctx);
    expect(budget.alert.category).toBe("budget");
    expect(budget.alert.severity).toBe("action");
    expect(budget.alert.reason).toBe("Écart au rythme linéaire : -21 points");
    expect(budget.platforms.meta.pacing?.pct_spent).toBe(0.69);
  });

  it("reports unreadable accounts and spend without conversion", () => {
    const broken = buildClient(client({ platforms: [meta([], { err: "Accès refusé" })] }), ctx);
    expect(broken.alert.category).toBe("data");
    const silent = buildClient(client({ platforms: [meta([...flat(7, week(3000, 80)), week(3000, 0), week(3000, 0)])] }), ctx);
    expect(silent.alert.category).toBe("measurement");
    expect(silent.alert.severity).toBe("action");
  });

  it("blends accounts, converts currencies and reads a mixed client per account", () => {
    const c = buildClient(client({
      kpi_mode: "mixte",
      platforms: [
        meta(flat(9, week(1000, 10, 4000)), { mode: "roas" }),
        { ...meta(flat(9, week(2000, 40)), { mode: "cpa" }), key: "google", plat: "google", label: "Google", ccy: "USD" },
      ],
    }), ctx);
    expect(c.mixed).toBe(true);
    expect(c.eur_w0).toBe(1000 + 1800);
    expect(c.blended.kpi).toBeNull();
    expect(c.platforms.meta.kpi).toBe(4);
    expect(c.platforms.google.kpi).toBe(50);
  });

  it("sorts urgent first, then by score", () => {
    const rows = sortClients([
      { alert: { severity: "watch" }, score: 9, eur_w0: 1 },
      { alert: { severity: "urgent" }, score: 1, eur_w0: 1 },
      { alert: { severity: "action" }, score: 2, eur_w0: 1 },
      { alert: { severity: "action" }, score: 5, eur_w0: 1 },
    ] as never);
    expect(rows.map((r) => `${r.alert.severity}${r.score}`)).toEqual(["urgent1", "action5", "action2", "watch9"]);
  });

  it("classifies a small account no higher than « à surveiller », except on budget", () => {
    const a = classify({
      kpi_mode: "cpa", eur_w0: 100, pacing: null, eurOf: (x) => x,
      blended: seriesMetrics([...flat(8, week(100, 20)), week(200, 20)], "cpa"),
      platforms: [],
    });
    expect(a.severity).toBe("watch");
  });
});

describe("budget sheet", () => {
  const csv = [
    ",Client,Team,Country / Region,Platform,Currency,Mois,Budget,Target ROAS,Target CPL,Jow Target FO",
    'SEPTEMBRE 2026,LPEV Traffic,Prodiges,France,FB/IG,EUR,01/September/2026,"€1,000",,,',
    ',LPEV ACQ,Prodiges,France,FB/IG,EUR,01/September/2026,"€5,000",,,',
    ',LPEV ACQ,Prodiges,France,Google,EUR,01/September/2026,"€11,000",,,',
    ',TBS Education,Warriors,France,LinkedIn,EUR,01/September/2026,"€5,000.00",,,',
    ',TBS Education,Warriors,France,Google,EUR,01/September/2026,"€11,421.00",,,',
    ',Leroy Merlin,Warriors,Afrique du sud,Google,ZAR,01/September/2026,"R5,400,000.00",,,',
    ',Cotton Bird,Prodiges,France,FB/IG,EUR,01/September/2026,,,,',
    'AOÛT 2026,LPEV ACQ,Prodiges,France,FB/IG,EUR,01/August/2026,"€4,000",5.2,,',
    ',TBS Education,Warriors,France,Google,EUR,01/April/2026,"€9,000",,€27,',
  ].join("\n");

  it("parses amounts, months and platforms", () => {
    expect(parseAmount("€3,000")).toBe(3000);
    expect(parseAmount("R5,400,000.00")).toBe(5_400_000);
    expect(parseAmount("1 200,50 €")).toBe(1200.5);
    expect(parseAmount("€0")).toBe(0);
    expect(parseAmount("")).toBeNull();
    expect(parseMonth("01/September/2026")).toBe("2026-09");
    expect(parseMonth("SEPTEMBRE 2026")).toBeNull();
    expect(parsePlatform("FB/IG")).toBe("meta");
    expect(parsePlatform("Google INTER")).toBe("google");
    expect(parsePlatform("Tiktok")).toBe("other");
    expect(parseCsv('a,"b,c","d ""e"""\n1,2,3')).toEqual([["a", "b,c", 'd "e"'], ["1", "2", "3"]]);
  });

  it("groups the lines of a brand and sums Meta and Google budgets", () => {
    const clients = sheetClients(parseBudgetSheet(csv), "2026-09");
    const lpev = clients.find((c) => c.key === "lpev")!;
    expect(lpev.name).toBe("LPEV");
    expect(lpev.budget).toEqual({ meta: 6000, google: 11_000 });
    expect(lpev.targetRoas).toBe(5.2);
    const tbs = clients.find((c) => c.key === "tbs")!;
    expect(tbs.budget).toEqual({ meta: null, google: 11_421 });
    expect(tbs.otherPlatforms).toEqual(["LinkedIn"]);
    expect(tbs.targetCpl).toBe(27);
    expect(clients.find((c) => c.key === "cotton")!.budget).toEqual({ meta: null, google: null });
    expect(clients.find((c) => c.key === "leroy")!.currency).toBe("ZAR");
  });

  it("names a group by what its lines share", () => {
    expect(brandToken("La route des langues")).toBe("route");
    expect(brandToken("Masséna Formations")).toBe("massena");
    expect(commonName(["Cours Legendre - EAD", "Cours Legendre - Brand"])).toBe("Cours Legendre");
    expect(commonName(["Fountaine Pajot (LG)", "Fountaine Pajot (Noto)"])).toBe("Fountaine Pajot");
    expect(commonName(["Joista"])).toBe("Joista");
  });
});

describe("account matching", () => {
  it("matches a brand inside an account name, whole word for short brands", () => {
    expect(accountMatches("LPEV", "Laboratoire LPEV 2")).toBe(true);
    expect(accountMatches("Saveurs & Vie", "SAVEURS ET VIE 2025")).toBe(true);
    expect(accountMatches("SMSMODE", "SMS MODE")).toBe(true);
    expect(accountMatches("Joista", "JOÏSTA")).toBe(true);
    expect(accountMatches("France Emploi Domicile", "LivingPackets France")).toBe(false);
    expect(accountMatches("FED", "Fepem")).toBe(false);
    expect(accountMatches("Vins de Provence", "Collines de Provence")).toBe(false);
  });

  it("gives an account to one client, skips closed accounts, falls back on the brand", () => {
    const clients = [
      { key: "france", name: "France Emploi Domicile", sheetNames: ["France Emploi Domicile"] },
      { key: "livingpackets", name: "LivingPackets", sheetNames: ["LivingPackets B2B"] },
      { key: "icn", name: "ICN Business School", sheetNames: ["ICN Business School FI Lead Gen"] },
    ];
    const acc = (name: string, active = true) => ({ platform: "google" as const, accountId: name, name, currency: "EUR", active });
    const m = matchAccounts(clients, [acc("LivingPackets France"), acc("France Emploi Domicile"), acc("ICN - ARTEM"), acc("ICN Business School", false)]);
    expect(m.get("france")?.map((a) => a.name)).toEqual(["France Emploi Domicile"]);
    expect(m.get("livingpackets")?.map((a) => a.name)).toEqual(["LivingPackets France"]);
    expect(m.get("icn")?.map((a) => a.name)).toEqual(["ICN - ARTEM"]);
  });

  it("labels an account by what it adds to the client name", () => {
    expect(accountLabel("meta", "LPEV", "Laboratoire LPEV 2", 1)).toBe("Meta");
    expect(accountLabel("google", "Vorwerk", "Vorwerk - E-Commerce", 2)).toBe("Google · E Commerce");
  });
});

describe("calendar and currencies", () => {
  it("reads the last full week and the month of the last closed day", () => {
    const cal = cockpitCalendar(new Date("2026-09-28T08:00:00Z"));
    expect(cal.w0).toEqual({ since: "2026-09-21", until: "2026-09-27" });
    expect(cal.weekStarts[0]).toBe("2026-07-27");
    expect(cal.weekStarts).toHaveLength(9);
    expect(cal.month).toMatchObject({ key: "2026-09", elapsed: 27, days: 30 });
    expect(cal.fetch).toEqual({ since: "2026-07-27", until: "2026-09-27" });
    // Mid-week: the running week is not read.
    expect(cockpitCalendar(new Date("2026-10-01T08:00:00Z")).w0).toEqual({ since: "2026-09-21", until: "2026-09-27" });
    // On the 1st, the pace is still the month that just closed.
    expect(cockpitCalendar(new Date("2026-10-01T08:00:00Z")).month).toMatchObject({ key: "2026-09", elapsed: 30, days: 30 });
  });

  it("buckets days into weeks and month to date", () => {
    const cal = cockpitCalendar(new Date("2026-09-28T08:00:00Z"));
    const day = (date: string, spend: number) => ({ date, spend, conv: 1, value: 0, impressions: 10, clicks: 1 });
    const b = bucket([day("2026-07-27", 10), day("2026-08-02", 5), day("2026-09-01", 7), day("2026-09-27", 3), day("2026-09-28", 99)], cal);
    expect(b.weeks[0].spend).toBe(15);
    expect(b.weeks[8].spend).toBe(3);
    expect(b.mtd).toBe(10);
  });

  it("turns ECB rates into EUR per unit", () => {
    const fx = parseEcb("<Cube time='2026-09-25'><Cube currency='USD' rate='1.25'/><Cube currency='ZAR' rate='20'/></Cube>");
    expect(fx.date).toBe("2026-09-25");
    expect(fx.rates.USD).toBeCloseTo(0.8);
    expect(fx.rates.ZAR).toBeCloseTo(0.05);
  });
});
