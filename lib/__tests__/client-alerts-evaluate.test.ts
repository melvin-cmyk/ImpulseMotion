import { describe, expect, it } from "vitest";
import { definitionHash, evaluate, lastFullDay, windowOf } from "@/lib/client-alerts/evaluate";
import { backtest } from "@/lib/client-alerts/backtest";
import type { AccountSeries, AlertAccountRef, AlertDefinition, ClientSeries, SeriesPoint } from "@/lib/client-alerts/types";

const UNTIL = "2026-09-29";
const META: AlertAccountRef = { platform: "meta", accountId: "act_100", name: "Meta FR", currency: "EUR" };
const META_2: AlertAccountRef = { platform: "meta", accountId: "act_200", name: "Meta BE", currency: "EUR" };
const GOOGLE: AlertAccountRef = { platform: "google", accountId: "555", name: "Google FR", currency: "EUR" };

const dateOf = (back: number, until = UNTIL) => new Date(Date.parse(`${until}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);

/** `count` full days ending at `until`; `at(back)` gives the day that is `back` days before the last one. */
function account(ref: AlertAccountRef, at: (back: number) => Partial<SeriesPoint>, opts: { count?: number; until?: string; today?: AccountSeries["today"] } = {}): AccountSeries {
  const count = opts.count ?? 95;
  const days: SeriesPoint[] = [];
  for (let back = count - 1; back >= 0; back--) {
    days.push({ date: dateOf(back, opts.until), spend: 0, conversions: 0, revenue: null, clicks: 0, impressions: 0, ...at(back) });
  }
  return { account: ref, currency: "EUR", eurRate: 1, days, today: opts.today ?? null };
}
const broken = (ref: AlertAccountRef, error = "accès au compte refusé par Meta"): AccountSeries => ({ account: ref, currency: "EUR", eurRate: 1, days: [], today: null, error });
const series = (...accounts: AccountSeries[]): ClientSeries => ({ readAt: "2026-09-30T06:10:00.000Z", until: UNTIL, accounts });

const def = (over: Partial<AlertDefinition> = {}): AlertDefinition => ({
  version: 1, label: "Alerte", accounts: [META, GOOGLE], metric: "spend", aggregation: "combined", condition: "above", threshold: 100,
  windowDays: 1, compare: "previous_window", guards: {}, checks: "2x", weekdaysOnly: false, cooldownHours: 72, remind: false, explanation: "",
  ...over,
});

/** Every day the same: Meta 100 € / 2 conv. / 300 € / 10 clicks / 1 000 imp., Google 50 € / 1 conv. / 200 € / 5 clicks / 1 000 imp. */
const steady = () => series(
  account(META, () => ({ spend: 100, conversions: 2, revenue: 300, clicks: 10, impressions: 1000 })),
  account(GOOGLE, () => ({ spend: 50, conversions: 1, revenue: 200, clicks: 5, impressions: 1000 })),
);

describe("evaluate — value of each metric over the window", () => {
  // 3 days, both platforms added up: 450 €, 9 conversions, 1 500 € of value, 45 clicks on 6 000 impressions.
  const cases: Array<[AlertDefinition["metric"], number]> = [
    ["spend", 450], ["conversions", 9], ["revenue", 1500], ["cpa", 50], ["roas", 1500 / 450], ["ctr", 0.75],
  ];
  for (const [metric, expected] of cases) {
    it(`${metric} is computed from the sums of the window`, () => {
      const ev = evaluate(def({ metric, windowDays: 3, threshold: expected - 0.01 }), steady());
      expect(ev.value).toBeCloseTo(expected, 10);
      expect(ev.status).toBe("triggered");
      // What depends on conversions is judged with one day of hindsight; the evaluation reports the real window.
      const late = metric !== "spend" && metric !== "ctr";
      expect(ev.asOf).toBe(late ? dateOf(1) : UNTIL);
      expect(ev.from).toBe(late ? dateOf(3) : dateOf(2));
      expect(evaluate(def({ metric, windowDays: 3, condition: "below", threshold: expected + 0.01 }), steady()).status).toBe("triggered");
    });
  }

  it("compares strictly: a value equal to the threshold is neither above nor below", () => {
    expect(evaluate(def({ windowDays: 3, threshold: 450, condition: "above" }), steady()).status).toBe("ok");
    expect(evaluate(def({ windowDays: 3, threshold: 450, condition: "below" }), steady()).status).toBe("ok");
    expect(evaluate(def({ windowDays: 3, threshold: 449.99, condition: "below" }), steady()).status).toBe("ok");
    expect(evaluate(def({ windowDays: 3, threshold: 450.01, condition: "above" }), steady()).status).toBe("ok");
  });

  it("only reads the days of the window, ending at asOf", () => {
    // 1 000 € four days before the last day: outside a window of 3 days, inside a window of 7.
    const s = series(account(META, (back) => ({ spend: back === 4 ? 1000 : 10 })));
    const d = def({ accounts: [META], threshold: 500 });
    expect(evaluate({ ...d, windowDays: 3 }, s).value).toBe(30);
    expect(evaluate({ ...d, windowDays: 7 }, s).value).toBe(1060);
    // Replayed four days earlier, the window of 1 day is that day.
    const past = evaluate({ ...d, windowDays: 1 }, s, { asOf: dateOf(4) });
    expect(past.value).toBe(1000);
    expect(past.asOf).toBe(dateOf(4));
    expect(past.status).toBe("triggered");
  });
});

describe("evaluate — values that cannot be computed are skipped, never triggered", () => {
  it("CPA « below » without any conversion, and CPA « above » while too little was spent to conclude", () => {
    const s = series(account(META, () => ({ spend: 500, conversions: 0 })));
    const below = evaluate(def({ accounts: [META], metric: "cpa", condition: "below", threshold: 60, windowDays: 3 }), s);
    expect(below).toMatchObject({ status: "skipped", value: null });
    expect(below.reason).toMatch(/CPA incalculable/);
    // 19 € a day without a conversion: 57 € in 3 days, not yet the price of one conversion at 60 €.
    const little = series(account(META, () => ({ spend: 19, conversions: 0 })));
    const above = evaluate(def({ accounts: [META], metric: "cpa", condition: "above", threshold: 60, windowDays: 3 }), little);
    expect(above).toMatchObject({ status: "skipped", value: null });
    expect(above.reason).toBe("Aucune conversion sur 3 jours pour 57 € dépensés : rien à juger avant 60 €");
  });

  it("ROAS without spend", () => {
    const s = series(account(META, () => ({ spend: 0, revenue: 0 })));
    const ev = evaluate(def({ accounts: [META], metric: "roas", condition: "below", threshold: 2 }), s);
    expect(ev.status).toBe("skipped");
    expect(ev.reason).toMatch(/ROAS incalculable : aucune dépense/);
  });

  it("ROAS when one account of the scope tracks no value, even if the other does", () => {
    const s = series(account(META, () => ({ spend: 100, revenue: 50 })), account(GOOGLE, () => ({ spend: 100, revenue: null })));
    const ev = evaluate(def({ metric: "roas", condition: "below", threshold: 2 }), s);
    expect(ev.status).toBe("skipped");
    expect(ev.value).toBeNull();
    expect(ev.reason).toMatch(/ne suit pas la valeur/);
    // Judged per platform, Meta alone has a ROAS of 0,5: it triggers.
    const each = evaluate(def({ metric: "roas", condition: "below", threshold: 2, aggregation: "each" }), s);
    expect(each.status).toBe("triggered");
    expect(each.value).toBeCloseTo(0.5, 10);
  });

  it("ROAS is not lost to an account that tracks no value when that account spent nothing", () => {
    // A dormant Google account next to a Meta account at a ROAS of 0,5.
    const dormant = series(account(META, () => ({ spend: 100, revenue: 50 })), account(GOOGLE, () => ({ spend: 0, revenue: null })));
    const ev = evaluate(def({ metric: "roas", condition: "below", threshold: 2, windowDays: 3 }), dormant);
    expect(ev.value).toBeCloseTo(0.5, 10);
    expect(ev.status).toBe("triggered");
    // It spent outside of the window only: the window is still exact.
    const before = series(account(META, () => ({ spend: 100, revenue: 50 })), account(GOOGLE, (back) => ({ spend: back >= 4 ? 40 : 0, revenue: null })));
    expect(evaluate(def({ metric: "roas", condition: "below", threshold: 2, windowDays: 3 }), before).value).toBeCloseTo(0.5, 10);
    expect(evaluate(def({ metric: "roas", condition: "below", threshold: 2, windowDays: 7 }), before).status).toBe("skipped");
    // No account tracks a value at all: nothing to compute.
    const none = series(account(META, () => ({ spend: 100 })), account(GOOGLE, () => ({ spend: 0 })));
    const blind = evaluate(def({ metric: "roas", condition: "below", threshold: 2 }), none);
    expect(blind.status).toBe("skipped");
    expect(blind.reason).toMatch(/aucun compte ne suit la valeur/);
  });

  it("revenue: null when no account tracks a value, the sum of those that do otherwise", () => {
    const none = series(account(META, () => ({ spend: 100 })), account(GOOGLE, () => ({ spend: 100 })));
    const ev = evaluate(def({ metric: "revenue", condition: "below", threshold: 1000 }), none);
    expect(ev.status).toBe("skipped");
    expect(ev.value).toBeNull();
    const one = series(account(META, () => ({ spend: 100, revenue: 400 })), account(GOOGLE, () => ({ spend: 100 })));
    const partial = evaluate(def({ metric: "revenue", condition: "below", threshold: 1000 }), one);
    expect(partial.value).toBe(400);
    expect(partial.status).toBe("triggered");
  });

  it("CTR without any impression", () => {
    const s = series(account(META, () => ({ spend: 0, clicks: 0, impressions: 0 })));
    const ev = evaluate(def({ accounts: [META], metric: "ctr", condition: "below", threshold: 1 }), s);
    expect(ev.status).toBe("skipped");
    expect(ev.reason).toMatch(/CTR incalculable/);
  });

  it("a definition without threshold", () => {
    expect(evaluate(def({ threshold: null }), steady()).status).toBe("skipped");
  });
});

describe("evaluate — drop_pct and rise_pct", () => {
  // Last 3 days at 60 €, the 3 before at 100 €, the rest at 100 €.
  const dropped = () => series(account(META, (back) => ({ spend: back < 3 ? 60 : 100 })));
  const d = (over: Partial<AlertDefinition>) => def({ accounts: [META], windowDays: 3, condition: "drop_pct", threshold: 40, ...over });

  it("measures the change against the days just before the window", () => {
    const ev = evaluate(d({}), dropped());
    expect(ev.value).toBe(180);
    expect(ev.baseline).toBe(300);
    expect(ev.changePct).toBeCloseTo(-40, 10);
  });

  it("triggers a drop at the threshold, not before", () => {
    expect(evaluate(d({ threshold: 40 }), dropped()).status).toBe("triggered");
    expect(evaluate(d({ threshold: 40.5 }), dropped()).status).toBe("ok");
    // A drop is not a rise.
    expect(evaluate(d({ condition: "rise_pct", threshold: 40 }), dropped()).status).toBe("ok");
  });

  it("triggers a rise at the threshold, not before", () => {
    const rose = series(account(META, (back) => ({ spend: back < 3 ? 150 : 100 })));
    const ev = evaluate(d({ condition: "rise_pct", threshold: 50 }), rose);
    expect(ev.changePct).toBeCloseTo(50, 10);
    expect(ev.status).toBe("triggered");
    expect(evaluate(d({ condition: "rise_pct", threshold: 51 }), rose).status).toBe("ok");
    expect(evaluate(d({ condition: "drop_pct", threshold: 50 }), rose).status).toBe("ok");
  });

  it("skips when there is nothing to compare with", () => {
    const fromZero = series(account(META, (back) => ({ spend: back < 3 ? 100 : 0 })));
    const zero = evaluate(d({ condition: "rise_pct", threshold: 10 }), fromZero);
    expect(zero.status).toBe("skipped");
    expect(zero.reason).toMatch(/comparaison/);
    // CPA of the comparison window unknown: no conversion then.
    const noConv = series(account(META, (back) => ({ spend: 100, conversions: back < 3 ? 2 : 0 })));
    const cpa = evaluate(d({ metric: "cpa", condition: "rise_pct", threshold: 10 }), noConv);
    expect(cpa.status).toBe("skipped");
    expect(cpa.baseline).toBeNull();
    expect(cpa.reason).toMatch(/comparaison/);
  });

  describe("same_weekdays shifts the window back by whole weeks", () => {
    // Day `back` spends 100 + back: every window has its own sum.
    const ramp = () => series(account(META, (back) => ({ spend: 100 + back })));
    const sum = (from: number, to: number) => { let s = 0; for (let b = from; b <= to; b++) s += 100 + b; return s; };
    // window → shift: the smallest multiple of 7 that is ≥ the window.
    const shifts: Array<[AlertDefinition["windowDays"], number]> = [[1, 7], [3, 7], [7, 7], [14, 14], [30, 35]];
    for (const [windowDays, shift] of shifts) {
      it(`window of ${windowDays} day(s): compared with the same days ${shift} days earlier`, () => {
        const ev = evaluate(d({ windowDays, compare: "same_weekdays", condition: "rise_pct", threshold: 1 }), ramp());
        expect(ev.value).toBe(sum(0, windowDays - 1));
        expect(ev.baseline).toBe(sum(shift, shift + windowDays - 1));
        expect(ev.changePct).toBeCloseTo(((sum(0, windowDays - 1) - sum(shift, shift + windowDays - 1)) / sum(shift, shift + windowDays - 1)) * 100, 10);
      });
    }

    it("previous_window of 1 and 3 days reads the days just before, not the week before", () => {
      expect(evaluate(d({ windowDays: 1, compare: "previous_window" }), ramp()).baseline).toBe(sum(1, 1));
      expect(evaluate(d({ windowDays: 3, compare: "previous_window" }), ramp()).baseline).toBe(sum(3, 5));
    });
  });
});

describe("evaluate — stopped", () => {
  const stop = (over: Partial<AlertDefinition> = {}) => def({ accounts: [META], condition: "stopped", threshold: null, ...over });

  it("triggers when the window is at zero while the 7 days before had some", () => {
    const s = series(account(META, (back) => ({ spend: back === 0 ? 0 : 80 })));
    const ev = evaluate(stop(), s);
    expect(ev.status).toBe("triggered");
    expect(ev.value).toBe(0);
    expect(ev.baseline).toBe(560);
  });

  it("stays quiet on an account that was not spending before either", () => {
    // Nothing for 8 days: the week before the window is empty.
    const s = series(account(META, (back) => ({ spend: back <= 7 ? 0 : 80 })));
    expect(evaluate(stop(), s).status).toBe("ok");
  });

  it("needs every day of the window at zero", () => {
    const partly = series(account(META, (back) => ({ spend: back === 1 ? 5 : back < 3 ? 0 : 80 })));
    expect(evaluate(stop({ windowDays: 3 }), partly).status).toBe("ok");
    const fully = series(account(META, (back) => ({ spend: back < 3 ? 0 : 80 })));
    expect(evaluate(stop({ windowDays: 3 }), fully).status).toBe("triggered");
  });

  it("conversions: spending without converting, not an account that stopped spending", () => {
    // The day judged is the day before yesterday: yesterday's conversions are not all reported yet.
    const spending = series(account(META, (back) => ({ spend: 80, conversions: back === 1 ? 0 : 3 })));
    expect(evaluate(stop({ metric: "conversions" }), spending)).toMatchObject({ status: "triggered", asOf: dateOf(1), baseline: 21 });
    const off = series(account(META, (back) => ({ spend: back === 1 ? 0 : 80, conversions: back === 1 ? 0 : 3 })));
    expect(evaluate(stop({ metric: "conversions" }), off).status).toBe("ok");
  });

  it("is only defined on spend and conversions", () => {
    const ev = evaluate(stop({ metric: "cpa" }), steady());
    expect(ev.status).toBe("skipped");
  });

  it("never judges the day in progress: a stop is a full day at zero", () => {
    // Nothing spent by the afternoon, yesterday had some: not this alert's to say (the automatic alerts watch the day).
    const today = series(account(META, () => ({ spend: 80 }), { today: { spend: 0, conversions: 0, hour: 16 } }));
    expect(evaluate(stop(), today)).toMatchObject({ status: "ok", asOf: UNTIL });
    // Yesterday at zero: that is a stop, whatever the day in progress says.
    const yesterday = series(account(META, (back) => ({ spend: back === 0 ? 0 : 80 }), { today: { spend: 40, conversions: 0, hour: 16 } }));
    expect(evaluate(stop(), yesterday)).toMatchObject({ status: "triggered", asOf: UNTIL });
  });
});

describe("evaluate — guards", () => {
  it("skips under the minimum spend of the window, judges at it", () => {
    // CPA of 100 € on 3 days: 300 € spent, 3 conversions.
    const s = series(account(META, () => ({ spend: 100, conversions: 1 })));
    const d = (minSpend: number) => def({ accounts: [META], metric: "cpa", threshold: 60, windowDays: 3, guards: { minSpend } });
    const under = evaluate(d(300.01), s);
    expect(under.status).toBe("skipped");
    expect(under.reason).toMatch(/Trop peu de dépense/);
    expect(evaluate(d(300), s).status).toBe("triggered");
  });

  it("skips under the minimum of conversions, judges at it", () => {
    // « Below » keeps its guard whatever was spent: 3 conversions for 300 € in 3 days, 4 asked for.
    const s = series(account(META, () => ({ spend: 100, conversions: 1 })));
    const d = (minConversions: number) => def({ accounts: [META], metric: "cpa", condition: "below", threshold: 150, windowDays: 3, guards: { minConversions } });
    const under = evaluate(d(4), s);
    expect(under.status).toBe("skipped");
    expect(under.reason).toBe("Trop peu de conversions pour juger : 3 sur 3 jours, il en faut 4");
    expect(evaluate(d(3), s).status).toBe("triggered");
  });

  it("reads the guards of `stopped` on the 7 days before, since the window is empty by definition", () => {
    const s = series(account(META, (back) => ({ spend: back === 0 ? 0 : 10 })));
    const d = (minSpend: number) => def({ accounts: [META], condition: "stopped", threshold: null, guards: { minSpend } });
    expect(evaluate(d(70), s).status).toBe("triggered");
    const small = evaluate(d(71), s);
    expect(small.status).toBe("skipped");
    expect(small.reason).toMatch(/7 jours précédents/);
  });

  it("applies the guards per platform when each is judged on its own", () => {
    // Google spends 20 € a day with a CPA of 20 €; Meta 200 € with a CPA of 100 €. Guard: 100 € of spend.
    const s = series(account(META, () => ({ spend: 200, conversions: 2 })), account(GOOGLE, () => ({ spend: 20, conversions: 1 })));
    const ev = evaluate(def({ metric: "cpa", condition: "below", threshold: 50, aggregation: "each", guards: { minSpend: 100 } }), s);
    // Google alone would trigger (20 € < 50 €) but is under the guard; Meta is judged and is fine.
    // One platform not judged: the alert is neither true nor back to normal.
    expect(ev).toMatchObject({ status: "skipped", skip: "guard_spend" });
    expect(ev.reason).toMatch(/Trop peu de dépense/);
    expect(ev.parts.map((p) => p.triggered)).toEqual([false, false]);
  });
});

describe("evaluate — accounts that cannot be judged", () => {
  it("skips when an account of the scope is unreadable, whatever the others say", () => {
    const s = series(account(META, () => ({ spend: 5000 })), broken(GOOGLE, "lecture impossible — relay 502"));
    const ev = evaluate(def({ threshold: 100 }), s);
    expect(ev.status).toBe("skipped");
    expect(ev.reason).toMatch(/Google FR/);
    expect(ev.reason).toMatch(/relay 502/);
    expect(ev.parts.every((p) => !p.triggered)).toBe(true);
  });

  it("skips when the series does not carry an account of the definition", () => {
    const ev = evaluate(def({ threshold: 100 }), series(account(META, () => ({ spend: 5000 }))));
    expect(ev.status).toBe("skipped");
    expect(ev.reason).toMatch(/Google FR/);
  });

  it("skips without enough days for the window", () => {
    const s = series(account(META, () => ({ spend: 500 }), { count: 5 }));
    const ev = evaluate(def({ accounts: [META], windowDays: 7, threshold: 100 }), s);
    expect(ev.status).toBe("skipped");
    expect(ev.reason).toMatch(/Pas assez de jours/);
    expect(evaluate(def({ accounts: [META], windowDays: 3, threshold: 100 }), s).status).toBe("triggered");
  });

  it("skips without enough days for the comparison", () => {
    const s = series(account(META, (back) => ({ spend: back < 7 ? 10 : 100 }), { count: 13 }));
    const d = def({ accounts: [META], windowDays: 7, condition: "drop_pct", threshold: 50 });
    expect(evaluate(d, s).status).toBe("skipped");
    expect(evaluate(d, series(account(META, (back) => ({ spend: back < 7 ? 10 : 100 }), { count: 14 }))).status).toBe("triggered");
  });

  it("skips `stopped` without the 7 days before", () => {
    const s = series(account(META, (back) => ({ spend: back === 0 ? 0 : 80 }), { count: 7 }));
    expect(evaluate(def({ accounts: [META], condition: "stopped", threshold: null }), s).status).toBe("skipped");
  });

  it("judges on the day before while an account further west has not finished its yesterday", () => {
    // Paris yesterday is the 29th; the American account is still on the 28th.
    const late = account(META, (back) => ({ spend: back === 0 ? 900 : 10 }), { until: "2026-09-28" });
    const s = series(late, account(GOOGLE, () => ({ spend: 10 })));
    expect(lastFullDay(def(), s)).toBe("2026-09-28");
    const ev = evaluate(def({ threshold: 500 }), s);
    expect(ev.asOf).toBe("2026-09-28");
    expect(ev.value).toBe(910);
    expect(ev.status).toBe("triggered");
    // Asked for the 29th explicitly, the account has no such day: not judged.
    expect(evaluate(def({ threshold: 500 }), s, { asOf: UNTIL }).status).toBe("skipped");
    // An account several days late is not a timezone: nothing is judged on it.
    const stale = series(account(META, () => ({ spend: 900 }), { until: "2026-09-25" }));
    expect(evaluate(def({ accounts: [META], threshold: 500 }), stale).status).toBe("skipped");
  });
});

describe("evaluate — combined and each", () => {
  // Meta 40 € a day (two accounts of 20 €), Google 45 €.
  const s = () => series(account(META, () => ({ spend: 20, conversions: 1 })), account(META_2, () => ({ spend: 20, conversions: 1 })), account(GOOGLE, () => ({ spend: 45, conversions: 1 })));
  const d = (over: Partial<AlertDefinition>) => def({ accounts: [META, META_2, GOOGLE], threshold: 42, ...over });

  it("combined adds every account up and gives the platforms as detail", () => {
    const ev = evaluate(d({ aggregation: "combined", threshold: 80 }), s());
    expect(ev.status).toBe("triggered");
    expect(ev.value).toBe(85);
    expect(ev.parts.map((p) => p.scope)).toEqual(["combined", "meta", "google"]);
    expect(ev.parts.map((p) => p.value)).toEqual([85, 40, 45]);
    expect(ev.parts.map((p) => p.spend)).toEqual([85, 40, 45]);
    expect(ev.parts.map((p) => p.conversions)).toEqual([3, 2, 1]);
    // Google alone is above 42 too, but the detail never decides.
    expect(ev.parts.map((p) => p.triggered)).toEqual([true, false, false]);
    expect(evaluate(d({ aggregation: "combined", threshold: 86 }), s()).status).toBe("ok");
  });

  it("each judges every platform on its own sums; one is enough", () => {
    const ev = evaluate(d({ aggregation: "each", threshold: 42 }), s());
    expect(ev.status).toBe("triggered");
    expect(ev.parts.map((p) => p.scope)).toEqual(["meta", "google"]);
    // All the Meta accounts together are one platform: 40 €, under the threshold.
    expect(ev.parts.map((p) => p.value)).toEqual([40, 45]);
    expect(ev.parts.map((p) => p.triggered)).toEqual([false, true]);
    // The figures of the evaluation are those of the platform that triggered.
    expect(ev.value).toBe(45);
    // Added up they would be above 80; each on its own is not.
    expect(evaluate(d({ aggregation: "each", threshold: 80 }), s()).status).toBe("ok");
  });

  it("each takes the first platform that triggered", () => {
    const ev = evaluate(d({ aggregation: "each", threshold: 30 }), s());
    expect(ev.parts.map((p) => p.triggered)).toEqual([true, true]);
    expect(ev.value).toBe(40);
  });

  it("each is « ok » only when every platform was judged and none triggered", () => {
    const half = series(broken(META), account(GOOGLE, () => ({ spend: 45 })));
    // Meta could not be read: it may be the one in trouble. Not judged — so never re-armed on half a look.
    const blind = evaluate(def({ aggregation: "each", threshold: 100 }), half);
    expect(blind).toMatchObject({ status: "skipped", skip: "unreadable" });
    expect(blind.reason).toMatch(/Meta FR/);
    // One platform that triggers is enough, whatever the other.
    expect(evaluate(def({ aggregation: "each", threshold: 42 }), half).status).toBe("triggered");
    // Both judged, none over: ok.
    const both = series(account(META, () => ({ spend: 45 })), account(GOOGLE, () => ({ spend: 45 })));
    expect(evaluate(def({ aggregation: "each", threshold: 100 }), both).status).toBe("ok");
    const none = evaluate(def({ aggregation: "each", threshold: 42 }), series(broken(META), broken(GOOGLE, "lecture impossible — relay 502")));
    expect(none.status).toBe("skipped");
    expect(none.reason).toMatch(/Meta FR/);
    expect(none.reason).toMatch(/Google FR/);
    // Combined, one unreadable account is enough to skip.
    expect(evaluate(def({ aggregation: "combined", threshold: 42 }), half).status).toBe("skipped");
  });

  it("only lists the platforms the definition has", () => {
    const ev = evaluate(def({ accounts: [GOOGLE], threshold: 10 }), s());
    expect(ev.parts.map((p) => p.scope)).toEqual(["combined", "google"]);
    expect(ev.value).toBe(45);
  });

  it("ignores accounts of the series that are not in the definition", () => {
    expect(evaluate(def({ accounts: [META], threshold: 10 }), s()).value).toBe(20);
  });
});

describe("evaluate — a CPA « above » that spends without converting enough", () => {
  const cpa = (over: Partial<AlertDefinition> = {}) => def({ accounts: [META], metric: "cpa", condition: "above", threshold: 60, windowDays: 3, guards: { minConversions: 5 }, ...over });

  it("triggers without any conversion once the spend reaches threshold × the conversions the guard asks for — the value is null", () => {
    // 900 € in 3 days, 0 conversion: the very case « CPA > 60 € » is created for.
    const ev = evaluate(cpa(), series(account(META, () => ({ spend: 300, conversions: 0 }))));
    expect(ev).toMatchObject({ status: "triggered", value: null });
    expect(ev.parts[0]).toMatchObject({ scope: "combined", triggered: true, value: null, spend: 900, conversions: 0 });
  });

  it("triggers under the guard with the CPA as value: even with the conversions it waits for, the threshold is passed", () => {
    // 2 conversions for 900 €: 450 € each; 5 conversions would still be 180 €.
    const ev = evaluate(cpa(), series(account(META, (back) => ({ spend: 300, conversions: back === 1 ? 2 : 0 }))));
    expect(ev).toMatchObject({ status: "triggered", value: 450 });
  });

  it("starts exactly at threshold × max(minConversions, 1)", () => {
    const spent = (perDay: number) => series(account(META, () => ({ spend: perDay, conversions: 0 })));
    // Guard of 5: 300 € (60 × 5) over the 3 days.
    expect(evaluate(cpa(), spent(100)).status).toBe("triggered");
    const under = evaluate(cpa(), spent(99.99));
    expect(under.status).toBe("skipped");
    expect(under.reason).toMatch(/^Trop peu de conversions pour juger : 0 sur 3 jours, il en faut 5 — ou 300 € dépensés$/);
    // No guard, or a guard of 0: one conversion at the threshold, 60 €.
    for (const guards of [{}, { minConversions: 0 }]) {
      expect(evaluate(cpa({ guards }), spent(20)).status, JSON.stringify(guards)).toBe("triggered");
      expect(evaluate(cpa({ guards }), spent(19.99)).status, JSON.stringify(guards)).toBe("skipped");
    }
  });

  it("still waits for the spend guard, and leaves « below » and the variations to their guards", () => {
    const s = series(account(META, () => ({ spend: 300, conversions: 0 })));
    expect(evaluate(cpa({ guards: { minConversions: 5, minSpend: 1000 } }), s)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/Trop peu de dépense/) });
    expect(evaluate(cpa({ condition: "below" }), s).status).toBe("skipped");
    expect(evaluate(cpa({ condition: "rise_pct", threshold: 50 }), s).status).toBe("skipped");
  });

  it("judges each platform on its own spend when each is asked for", () => {
    const s = series(account(META, () => ({ spend: 200, conversions: 0 })), account(GOOGLE, () => ({ spend: 30, conversions: 1 })));
    const ev = evaluate(cpa({ accounts: [META, GOOGLE], aggregation: "each", guards: { minConversions: 3 } }), s);
    // Meta: 600 € without a conversion, 180 € are enough. Google: 3 conversions at 30 €.
    expect(ev).toMatchObject({ status: "triggered", value: null });
    expect(ev.parts).toMatchObject([{ scope: "meta", triggered: true, value: null, spend: 600 }, { scope: "google", triggered: false, value: 30 }]);
  });

  it("is what the replay counts too: same code, and the days without a value stay out of the spread", () => {
    // Converting at 50 € until 4 days ago, then nothing converts any more while the spend goes on.
    const s = series(account(META, (back) => ({ spend: 300, conversions: back < 4 ? 0 : 6 })));
    const replay = backtest(cpa(), s, { now: new Date("2026-09-30T06:10:00Z") });
    // Checked the 28th on the window ending the 26th (one day of hindsight): 900 € for 12 conversions = 75 € → the message of that morning.
    // Then 150 € (6 conversions), then no conversion at all for 900 €: true three days in a row, said once.
    expect(replay.messages).toEqual([{ date: "2026-09-28", value: 75, changePct: null }]);
    expect(replay.current).toBeNull();
    expect(replay.daysTrue).toBe(3);
    expect(replay.skippedDays).toBe(0);
    expect([replay.min, replay.median, replay.max]).toEqual([50, 50, 150]);
  });
});

describe("evaluate — one day of hindsight for what depends on conversions", () => {
  // Yesterday (back 0) is still filling up: 1 conversion reported of the 10 it will have. Every other day: 10 for 500 €.
  const filling = () => series(account(META, (back) => ({ spend: 500, conversions: back === 0 ? 1 : 10, revenue: back === 0 ? 50 : 1500 })));

  it("does not judge yesterday: a morning check would see a CPA, a ROAS or a « no conversion » that is not the final one", () => {
    const one = (over: Partial<AlertDefinition>) => evaluate(def({ accounts: [META], windowDays: 1, ...over }), filling());
    // On yesterday alone the CPA would read 500 €, the conversions 1, the ROAS 0,1: all false alarms.
    expect(one({ metric: "cpa", condition: "above", threshold: 60, guards: {} })).toMatchObject({ status: "ok", value: 50, asOf: dateOf(1), from: dateOf(1) });
    expect(one({ metric: "conversions", condition: "below", threshold: 5 })).toMatchObject({ status: "ok", value: 10, asOf: dateOf(1) });
    expect(one({ metric: "roas", condition: "below", threshold: 1 })).toMatchObject({ status: "ok", value: 3, asOf: dateOf(1) });
    expect(one({ metric: "revenue", condition: "below", threshold: 1000 })).toMatchObject({ status: "ok", value: 1500, asOf: dateOf(1) });
    expect(one({ metric: "conversions", condition: "drop_pct", threshold: 50 })).toMatchObject({ status: "ok", value: 10, baseline: 10 });
    const none = series(account(META, (back) => ({ spend: 500, conversions: back === 0 ? 0 : 10 })));
    expect(evaluate(def({ accounts: [META], metric: "conversions", condition: "stopped", threshold: null }), none)).toMatchObject({ status: "ok", asOf: dateOf(1) });
  });

  it("still judges the spend and the click rate on yesterday", () => {
    const s = series(account(META, (back) => ({ spend: back === 0 ? 900 : 100, clicks: back === 0 ? 1 : 30, impressions: 1000 })));
    expect(evaluate(def({ accounts: [META], metric: "spend", threshold: 500 }), s)).toMatchObject({ status: "triggered", value: 900, asOf: UNTIL, from: UNTIL });
    expect(evaluate(def({ accounts: [META], metric: "ctr", condition: "below", threshold: 1 }), s)).toMatchObject({ status: "triggered", asOf: UNTIL });
  });

  it("moves the replay with the cron: same window for the same morning", () => {
    // The replay judges each morning on the window the cron had that morning — yesterday's figures never enter it.
    const b = backtest(def({ accounts: [META], metric: "cpa", condition: "above", threshold: 60, windowDays: 1, guards: {} }), filling(), { now: new Date("2026-09-30T06:10:00Z") });
    expect(b).toMatchObject({ daysTrue: 0, skippedDays: 0, current: 50, max: 50 });
    expect(windowOf({ metric: "cpa", windowDays: 3, weekdaysOnly: false }, UNTIL)).toEqual({ from: dateOf(3), to: dateOf(1) });
    expect(windowOf({ metric: "spend", windowDays: 3, weekdaysOnly: false }, UNTIL)).toEqual({ from: dateOf(2), to: UNTIL });
  });
});

describe("evaluate — working days only", () => {
  // UNTIL is Tuesday 29 Sept. 2026; the 26th and 27th are a Saturday and a Sunday.
  const weekend = (date: string) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
  /** 100 € on working days, 5 € on Saturdays and Sundays. */
  const office = (over: (back: number) => Partial<SeriesPoint> = () => ({})) =>
    series(account(META, (back) => ({ spend: weekend(dateOf(back)) ? 5 : 100, conversions: weekend(dateOf(back)) ? 0 : 4, ...over(back) })));
  const worked = (over: Partial<AlertDefinition> = {}) => def({ accounts: [META], weekdaysOnly: true, ...over });

  it("takes Saturdays and Sundays out before any window is built: 3 days are three working days", () => {
    // Checked on Monday 28 (last full day: Sunday 27): the window is Wednesday 23, Thursday 24, Friday 25.
    const monday = evaluate(worked({ windowDays: 3, threshold: 299 }), office(), { asOf: "2026-09-27" });
    expect(monday).toMatchObject({ status: "triggered", value: 300, from: "2026-09-23", asOf: "2026-09-25" });
    // With week-ends in, the same morning reads Friday, Saturday, Sunday: 110 €.
    expect(evaluate(def({ accounts: [META], windowDays: 3, threshold: 299 }), office(), { asOf: "2026-09-27" })).toMatchObject({ status: "ok", value: 110, from: "2026-09-25", asOf: "2026-09-27" });
  });

  it("judges Friday on Monday for one day — Thursday for what depends on conversions", () => {
    const s = office((back) => (dateOf(back) === "2026-09-25" ? { spend: 900, conversions: 0 } : dateOf(back) === "2026-09-24" ? { conversions: 1 } : {}));
    expect(evaluate(worked({ threshold: 500 }), s, { asOf: "2026-09-27" })).toMatchObject({ status: "triggered", value: 900, asOf: "2026-09-25", from: "2026-09-25" });
    expect(evaluate(worked({ metric: "conversions", condition: "below", threshold: 2 }), s, { asOf: "2026-09-27" })).toMatchObject({ status: "triggered", value: 1, asOf: "2026-09-24" });
    expect(windowOf({ metric: "conversions", windowDays: 1, weekdaysOnly: true }, "2026-09-27")).toEqual({ from: "2026-09-24", to: "2026-09-24" });
    expect(windowOf({ metric: "spend", windowDays: 1, weekdaysOnly: true }, "2026-09-28")).toEqual({ from: "2026-09-28", to: "2026-09-28" });
  });

  it("compares working days with working days: a Monday is not a drop from the week-end before it", () => {
    // Monday 28 judged on Tuesday: 100 € against Friday's 100 € — not against Sunday's 5 €.
    const drop = evaluate(worked({ condition: "rise_pct", threshold: 50 }), office());
    expect(drop).toMatchObject({ status: "ok", value: 100, baseline: 100 });
    expect(evaluate(def({ accounts: [META], condition: "rise_pct", threshold: 50 }), office(), { asOf: "2026-09-28" })).toMatchObject({ status: "triggered", value: 100, baseline: 5 });
    // Three working days against the three before them: 24, 25, 28 against 21, 22, 23.
    const three = evaluate(worked({ windowDays: 3, condition: "drop_pct", threshold: 10 }), office((back) => (["2026-09-21", "2026-09-22", "2026-09-23"].includes(dateOf(back)) ? { spend: 200 } : {})), { asOf: "2026-09-28" });
    expect(three).toMatchObject({ status: "triggered", value: 300, baseline: 600, from: "2026-09-24", asOf: "2026-09-28" });
    // The same weekdays a week earlier stay working days.
    const weeks = evaluate(worked({ windowDays: 3, condition: "drop_pct", threshold: 10, compare: "same_weekdays" }), office((back) => (["2026-09-17", "2026-09-18", "2026-09-21"].includes(dateOf(back)) ? { spend: 200 } : {})), { asOf: "2026-09-28" });
    expect(weeks).toMatchObject({ status: "triggered", value: 300, baseline: 600 });
  });

  it("reads the 7 days of reference of a stop as working days", () => {
    // Nothing on Monday 28; the 7 working days before run from Thursday 17 to Friday 25.
    const s = office((back) => (dateOf(back) === "2026-09-28" ? { spend: 0 } : {}));
    expect(evaluate(worked({ condition: "stopped", threshold: null }), s, { asOf: "2026-09-28" })).toMatchObject({ status: "triggered", value: 0, baseline: 700, asOf: "2026-09-28" });
    // A week-end at zero is not a stop: on Monday morning the day judged is Friday.
    const off = office((back) => (weekend(dateOf(back)) ? { spend: 0 } : {}));
    expect(evaluate(worked({ condition: "stopped", threshold: null }), off, { asOf: "2026-09-27" })).toMatchObject({ status: "ok", asOf: "2026-09-25" });
  });

  it("is replayed the same way: no check on a week-end, and windows of working days", () => {
    // One high Friday (the 25th): said on Monday morning, once.
    const s = office((back) => (dateOf(back) === "2026-09-25" ? { spend: 900 } : {}));
    const b = backtest(worked({ threshold: 500 }), s, { now: new Date("2026-09-30T06:10:00Z") });
    expect(b.messages).toEqual([{ date: "2026-09-28", value: 900, changePct: null }]);
    expect(b.checkedDays).toBe(22);
    expect(b.daysTrue).toBe(1);
    expect(b.notes.join(" ")).toContain("Jours ouvrés seulement : 22 jours rejoués sur 30, les samedis et dimanches ne comptent pas.");
  });
});

describe("evaluate — the guards of a variation are read on the reference", () => {
  const collapse = () => series(account(META, (back) => ({ spend: back === 0 ? 10 : 500, conversions: back <= 1 ? 0 : 8 })));

  it("triggers on a spend that falls from 500 € to 10 €, instead of skipping it for too little spend", () => {
    const ev = evaluate(def({ accounts: [META], condition: "drop_pct", threshold: 50, guards: { minSpend: 100 } }), collapse());
    expect(ev).toMatchObject({ status: "triggered", value: 10, baseline: 500 });
    expect(ev.changePct).toBeCloseTo(-98, 10);
  });

  it("triggers on conversions that fall to nothing under a minimum of conversions", () => {
    const ev = evaluate(def({ accounts: [META], metric: "conversions", condition: "drop_pct", threshold: 50, guards: { minConversions: 5 } }), collapse());
    expect(ev).toMatchObject({ status: "triggered", value: 0, baseline: 8, changePct: -100 });
  });

  it("skips when the reference itself is too small to fall from", () => {
    const small = series(account(META, (back) => ({ spend: back === 0 ? 1 : 20 })));
    const ev = evaluate(def({ accounts: [META], condition: "drop_pct", threshold: 50, guards: { minSpend: 100 } }), small);
    expect(ev).toMatchObject({ status: "skipped", skip: "guard_spend" });
    expect(ev.reason).toBe("Trop peu de dépense pour juger : 20 € sur la période de comparaison, il en faut 100 €");
    // A rise from a small reference is skipped too: what is measured from must be big enough.
    const rise = series(account(META, (back) => ({ spend: back === 0 ? 900 : 20 })));
    expect(evaluate(def({ accounts: [META], condition: "rise_pct", threshold: 50, guards: { minSpend: 100 } }), rise).status).toBe("skipped");
  });
});

describe("definitionHash", () => {
  it("does not change when an account is renamed at the platform, learns its currency, or is written another way", () => {
    const h = definitionHash(def());
    expect(definitionHash(def({ accounts: [{ ...META, name: "Meta France (nouveau nom)" }, { ...GOOGLE, currency: null }] }))).toBe(h);
    expect(definitionHash(def({ accounts: [{ ...META, accountId: "100" }, { ...GOOGLE, accountId: "5-5-5" }] }))).toBe(h);
    // Another account is another rule.
    expect(definitionHash(def({ accounts: [META_2, GOOGLE] }))).not.toBe(h);
    expect(definitionHash(def({ accounts: [{ ...META, platform: "google" }, GOOGLE] }))).not.toBe(h);
  });

  it("is a sha256 that ignores the label and the explanation", () => {
    const h = definitionHash(def());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(definitionHash(def({ label: "Autre nom", explanation: "Autre lecture" }))).toBe(h);
  });

  it("does not depend on the order of the keys nor of the accounts", () => {
    const d = def({ guards: { minSpend: 50, minConversions: 2 } });
    const shuffled = Object.fromEntries(Object.entries(d).reverse()) as unknown as AlertDefinition;
    shuffled.guards = { minConversions: 2, minSpend: 50 };
    shuffled.accounts = [{ currency: "EUR", name: "Google FR", accountId: "555", platform: "google" }, META];
    expect(definitionHash(shuffled)).toBe(definitionHash(d));
    expect(definitionHash(def({ guards: { minSpend: undefined } }))).toBe(definitionHash(def({ guards: {} })));
  });

  it("changes with anything that changes the evaluation or the delivery", () => {
    const h = definitionHash(def());
    const changes: Array<Partial<AlertDefinition>> = [
      { threshold: 101 }, { metric: "cpa" }, { condition: "below" }, { windowDays: 3 }, { aggregation: "each" }, { compare: "same_weekdays" },
      { guards: { minSpend: 10 } }, { checks: "4x" }, { weekdaysOnly: true }, { cooldownHours: 24 }, { remind: true }, { accounts: [META] },
    ];
    for (const c of changes) expect(definitionHash(def(c)), JSON.stringify(c)).not.toBe(h);
  });
});
