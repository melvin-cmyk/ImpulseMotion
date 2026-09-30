import { describe, expect, it } from "vitest";
import { advance, backtest, checkedOn, COOLDOWN_SLACK_MS, replayVerdict, type AlertState } from "@/lib/client-alerts/backtest";
import { definitionHash, evaluate } from "@/lib/client-alerts/evaluate";
import { BACKTEST_DAYS, SERIES_DAYS, type AccountSeries, type AlertAccountRef, type AlertDefinition, type ClientSeries, type SeriesPoint } from "@/lib/client-alerts/types";

// A Tuesday: the 26th and 27th are a Saturday and a Sunday.
const UNTIL = "2026-09-29";
const NOW = new Date("2026-09-30T08:00:00Z");
const META: AlertAccountRef = { platform: "meta", accountId: "act_100", name: "Meta FR", currency: "EUR" };
const GOOGLE: AlertAccountRef = { platform: "google", accountId: "555", name: "Google FR", currency: "EUR" };

const dateOf = (back: number) => new Date(Date.parse(`${UNTIL}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
/** A message is dated the morning it would have been received: the day after the last full day it was judged on. */
const received = (back: number) => dateOf(back - 1);

function account(ref: AlertAccountRef, at: (back: number) => Partial<SeriesPoint>, extra: Partial<AccountSeries> = {}): AccountSeries {
  const days: SeriesPoint[] = [];
  for (let back = 94; back >= 0; back--) days.push({ date: dateOf(back), spend: 0, conversions: 0, revenue: null, clicks: 0, impressions: 0, ...at(back) });
  return { account: ref, currency: "EUR", eurRate: 1, days, today: null, ...extra };
}
const series = (...accounts: AccountSeries[]): ClientSeries => ({ readAt: NOW.toISOString(), until: UNTIL, accounts });

const def = (over: Partial<AlertDefinition> = {}): AlertDefinition => ({
  version: 1, label: "Dépense haute", accounts: [META], metric: "spend", aggregation: "combined", condition: "above", threshold: 150,
  windowDays: 1, compare: "previous_window", guards: {}, checks: "1x", weekdaysOnly: false, cooldownHours: 72, remind: false, explanation: "",
  ...over,
});

const HOUR = 3_600_000;
const T0 = new Date("2026-09-10T06:10:00Z");
const after = (hours: number) => new Date(T0.getTime() + hours * HOUR);
const rule = { cooldownHours: 72, remind: false };

describe("advance — what decides a message", () => {
  const fresh: AlertState = { armed: true, lastMessageAt: null };

  it("sends the first time the condition is true, and disarms", () => {
    expect(advance(fresh, "triggered", T0, rule)).toEqual({ state: { armed: false, lastMessageAt: T0 }, message: "trigger" });
  });

  it("stays silent while the condition stays true, however long", () => {
    const sent: AlertState = { armed: false, lastMessageAt: T0 };
    for (const h of [3, 24, 72, 500]) {
      expect(advance(sent, "triggered", after(h), rule)).toEqual({ state: sent, message: null });
    }
  });

  it("re-arms only when a check finds the condition false", () => {
    const sent: AlertState = { armed: false, lastMessageAt: T0 };
    expect(advance(sent, "ok", after(24), rule)).toEqual({ state: { armed: true, lastMessageAt: T0 }, message: null });
    // Not judged is neither true nor false: nothing moves.
    expect(advance(sent, "skipped", after(24), rule)).toEqual({ state: sent, message: null });
    expect(advance(fresh, "skipped", T0, rule)).toEqual({ state: fresh, message: null });
  });

  it("keeps the silence after a message even once re-armed", () => {
    const rearmed: AlertState = { armed: true, lastMessageAt: T0 };
    // Back to normal then true again the next day: still inside the 72 h.
    const early = advance(rearmed, "triggered", after(48), rule);
    expect(early).toEqual({ state: rearmed, message: null });
    // It stays armed: the message goes once the silence is over.
    expect(advance(early.state, "triggered", after(72), rule)).toEqual({ state: { armed: false, lastMessageAt: after(72) }, message: "trigger" });
  });

  it("reminds after every cooldown only when asked to", () => {
    const sent: AlertState = { armed: false, lastMessageAt: T0 };
    const remind = { cooldownHours: 72, remind: true };
    expect(advance(sent, "triggered", after(48), remind)).toEqual({ state: sent, message: null });
    expect(advance(sent, "triggered", after(72), remind)).toEqual({ state: { armed: false, lastMessageAt: after(72) }, message: "reminder" });
    expect(advance(sent, "triggered", after(72), rule).message).toBeNull();
  });

  it("counts a check up to 90 minutes early as the end of the silence: the platform fires a cron anywhere within its hour", () => {
    const rearmed: AlertState = { armed: true, lastMessageAt: T0 };
    // Said at :55 one day, checked at :05 three days later: 71 h 10 is three days.
    expect(advance(rearmed, "triggered", new Date(after(72).getTime() - 50 * 60_000), rule).message).toBe("trigger");
    expect(advance(rearmed, "triggered", new Date(after(72).getTime() - 90 * 60_000), rule).message).toBe("trigger");
    expect(COOLDOWN_SLACK_MS).toBe(90 * 60_000);
    // The slot before (three hours earlier) is still inside the silence.
    expect(advance(rearmed, "triggered", new Date(after(72).getTime() - 91 * 60_000), rule).message).toBeNull();
    expect(advance(rearmed, "triggered", after(69), rule).message).toBeNull();
  });

  it("never goes under the floor of 12 h, whatever a stored definition says", () => {
    const rearmed: AlertState = { armed: true, lastMessageAt: T0 };
    expect(advance(rearmed, "triggered", after(3), { cooldownHours: 0, remind: false }).message).toBeNull();
    expect(advance(rearmed, "triggered", after(12), { cooldownHours: 0, remind: false }).message).toBe("trigger");
    // A cooldown that is not a number falls back to the default of three days.
    expect(advance(rearmed, "triggered", after(48), { cooldownHours: Number.NaN, remind: false }).message).toBeNull();
  });
});

describe("checkedOn", () => {
  it("leaves Saturday and Sunday out only for weekdaysOnly", () => {
    expect(checkedOn({ weekdaysOnly: true }, "2026-09-25")).toBe(true);
    expect(checkedOn({ weekdaysOnly: true }, "2026-09-26")).toBe(false);
    expect(checkedOn({ weekdaysOnly: true }, "2026-09-27")).toBe(false);
    expect(checkedOn({ weekdaysOnly: true }, "2026-09-28")).toBe(true);
    expect(checkedOn({ weekdaysOnly: false }, "2026-09-26")).toBe(true);
  });
});

describe("backtest", () => {
  /**
   * Spend of 200 € (above 150 €) on: four days in a row (25 to 22 days ago),
   * then 10 days ago, then 8 days ago. 100 € every other day.
   */
  const HIGH = new Set([25, 24, 23, 22, 10, 8]);
  const spikes = () => series(account(META, (back) => ({ spend: HIGH.has(back) ? 200 : 100 })));

  it("counts the days the condition was true and the messages after silence and re-arming", () => {
    const b = backtest(def(), spikes(), { now: NOW });
    expect(b.days).toBe(BACKTEST_DAYS);
    expect(b.daysTrue).toBe(6);
    expect(b.skippedDays).toBe(0);
    // 25 days ago: message. 24 to 22: still true, silence. 10 days ago: back to normal in between, message.
    // 8 days ago: re-armed the day before, but 48 h after the last message: silence.
    expect(b.messages.map((m) => m.date)).toEqual([received(25), received(10)]);
    expect(b.messages[0]).toEqual({ date: received(25), value: 200, changePct: null });
  });

  it("dates a message the morning it would have been received, not the last day of its figures", () => {
    // The last full day (yesterday) is high: the message is this morning's.
    const last = series(account(META, (back) => ({ spend: back === 0 ? 200 : 100 })));
    expect(backtest(def(), last, { now: NOW }).messages.map((m) => m.date)).toEqual(["2026-09-30"]);
    expect(received(0)).toBe("2026-09-30");
  });

  it("sends the message once the silence is over when the condition is still true", () => {
    // True again 8, 7 and 6 days ago: the check of day 7 is 72 h after the message of day 10.
    const s = series(account(META, (back) => ({ spend: HIGH.has(back) || back === 7 || back === 6 ? 200 : 100 })));
    expect(backtest(def(), s, { now: NOW }).messages.map((m) => m.date)).toEqual([received(25), received(10), received(7)]);
  });

  it("adds the reminders when asked to", () => {
    // 22 days ago is 72 h after the first message, the condition is still true: reminder.
    const b = backtest(def({ remind: true }), spikes(), { now: NOW });
    expect(b.messages.map((m) => m.date)).toEqual([received(25), received(22), received(10)]);
  });

  it("follows the cooldown of the definition", () => {
    const b = backtest(def({ cooldownHours: 24 }), spikes(), { now: NOW });
    expect(b.messages.map((m) => m.date)).toEqual([received(25), received(10), received(8)]);
  });

  it("working days only: no check on a week-end, and Saturdays and Sundays do not count in the figures", () => {
    // Friday the 25th and Saturday the 26th are high.
    const friday = series(account(META, (back) => ({ spend: back === 4 || back === 3 ? 200 : 100 })));
    expect(dateOf(4)).toBe("2026-09-25");
    const open = backtest(def(), friday, { now: NOW });
    // Week-ends in: received on the Saturday, true two days.
    expect(open.messages.map((m) => m.date)).toEqual(["2026-09-26"]);
    expect(open.daysTrue).toBe(2);
    // Working days only: Friday is judged on Monday morning — no check on Saturday or Sunday, and Saturday's figures are out.
    const weekdays = backtest(def({ weekdaysOnly: true }), friday, { now: NOW });
    expect(weekdays.messages).toEqual([{ date: "2026-09-28", value: 200, changePct: null }]);
    expect(weekdays.daysTrue).toBe(1);
    expect(weekdays.checkedDays).toBe(22);
    expect(weekdays.notes.join(" ")).toMatch(/Jours ouvrés seulement : 22 jours rejoués sur 30, les samedis et dimanches ne comptent pas/);
    // A high Sunday is nobody's working day: nothing is said.
    const sunday = series(account(META, (back) => ({ spend: back === 2 ? 200 : 100 })));
    expect(backtest(def({ weekdaysOnly: true }), sunday, { now: NOW }).messages).toEqual([]);
    expect(backtest(def(), sunday, { now: NOW }).messages.map((m) => m.date)).toEqual(["2026-09-28"]);
  });

  it("gives the value today and its spread over the judged days", () => {
    // 30 replayed days spend 101 … 130 €, the last day 101 €.
    const ramp = series(account(META, (back) => ({ spend: 101 + back })));
    const b = backtest(def({ threshold: 1000 }), ramp, { now: NOW });
    expect(b.current).toBe(101);
    expect(b.min).toBe(101);
    expect(b.max).toBe(130);
    expect(b.median).toBe(115.5);
    expect(b.daysTrue).toBe(0);
    expect(b.messages).toEqual([]);
  });

  it("counts the days that could not be judged, and leaves them out of the spread", () => {
    // CPA of 50 €, but no conversion on 5 days; under the guard of 2 conversions on 3 other days.
    const conv = (back: number) => (back >= 10 && back <= 14 ? 0 : back >= 20 && back <= 22 ? 1 : 2);
    const s = series(account(META, (back) => ({ spend: 100, conversions: conv(back) })));
    const b = backtest(def({ metric: "cpa", threshold: 60, guards: { minConversions: 2 } }), s, { now: NOW });
    expect(b.skippedDays).toBe(8);
    expect(b.daysTrue).toBe(0);
    expect([b.min, b.median, b.max]).toEqual([50, 50, 50]);
  });

  it("does not re-arm on a day that was not judged", () => {
    // True 12 days ago, not judged 11 days ago (no spend: guard), true again 10 days ago and after.
    const s = series(account(META, (back) => ({ spend: back === 11 ? 0 : back <= 12 ? 200 : 100 })));
    const b = backtest(def({ guards: { minSpend: 50 } }), s, { now: NOW });
    expect(b.skippedDays).toBe(1);
    expect(b.messages.map((m) => m.date)).toEqual([received(12)]);
    // The same day judged and false would have re-armed: a second message once the silence is over.
    const rearmed = backtest(def(), s, { now: NOW });
    expect(rearmed.messages.map((m) => m.date)).toEqual([received(12), received(9)]);
  });

  it("carries the change of a drop in its messages", () => {
    const s = series(account(META, (back) => ({ spend: back === 5 ? 40 : 100 })));
    const b = backtest(def({ condition: "drop_pct", threshold: 50 }), s, { now: NOW });
    expect(b.messages).toEqual([{ date: received(5), value: 40, changePct: -60 }]);
  });

  it("is signed with the hash of the definition it replayed and the time of the replay", () => {
    const b = backtest(def(), spikes(), { now: NOW });
    expect(b.hash).toBe(definitionHash(def()));
    expect(b.ranAt).toBe(NOW.toISOString());
  });

  describe("notes", () => {
    const both = () => series(account(META, () => ({ spend: 100, conversions: 2, revenue: 300 })), account(GOOGLE, () => ({ spend: 50, conversions: 1, revenue: 100 })));
    const double = /la même vente peut être comptée par Meta et par Google/;

    it("warns that a sale may be counted twice when conversions or revenue are added up over both platforms", () => {
      for (const metric of ["conversions", "cpa", "roas", "revenue"] as const) {
        expect(backtest(def({ accounts: [META, GOOGLE], metric }), both(), { now: NOW }).notes.join(" "), metric).toMatch(double);
      }
      // Not on spend or CTR, not when each platform is judged on its own, not with one platform.
      expect(backtest(def({ accounts: [META, GOOGLE], metric: "spend" }), both(), { now: NOW }).notes.join(" ")).not.toMatch(double);
      expect(backtest(def({ accounts: [META, GOOGLE], metric: "ctr" }), both(), { now: NOW }).notes.join(" ")).not.toMatch(double);
      expect(backtest(def({ accounts: [META, GOOGLE], metric: "cpa", aggregation: "each" }), both(), { now: NOW }).notes.join(" ")).not.toMatch(double);
      expect(backtest(def({ accounts: [META], metric: "cpa" }), both(), { now: NOW }).notes.join(" ")).not.toMatch(double);
    });

    it("names the accounts that could not be read, and skips every day", () => {
      const s = series(account(META, () => ({ spend: 500 })), { account: GOOGLE, currency: "EUR", eurRate: 1, days: [], today: null, error: "lecture Google Ads impossible pour le moment" });
      const b = backtest(def({ accounts: [META, GOOGLE] }), s, { now: NOW });
      expect(b.skippedDays).toBe(BACKTEST_DAYS);
      expect(b.messages).toEqual([]);
      expect(b.current).toBeNull();
      expect(b.notes.join(" ")).toMatch(/Google FR.*illisible \(lecture Google Ads impossible pour le moment\)/);
      expect(b.notes.join(" ")).toMatch(/Aucun jour n'a pu être jugé/);
    });

    it("says when amounts were converted at today's rate", () => {
      const usd = series(account(META, () => ({ spend: 100 }), { currency: "USD", eurRate: 0.877 }));
      expect(backtest(def(), usd, { now: NOW }).notes.join(" ")).toMatch(/USD.*convertis en euros au taux du jour/);
      expect(backtest(def(), series(account(META, () => ({ spend: 100 }))), { now: NOW }).notes.join(" ")).not.toMatch(/convertis/);
    });

    it("says nothing of the day in progress any more: the cron judges full days too", () => {
      const s = series(account(META, () => ({ spend: 100 })));
      expect(backtest(def({ condition: "stopped", threshold: null }), s, { now: NOW }).notes).toEqual([]);
    });
  });

  it("never reads the day in progress", () => {
    // Today at zero in the afternoon: the cron would trigger, the replay does not see it.
    const s = series(account(META, () => ({ spend: 100 }), { today: { spend: 0, conversions: 0, hour: 16 } }));
    const b = backtest(def({ condition: "stopped", threshold: null }), s, { now: NOW });
    expect(b.daysTrue).toBe(0);
    expect(b.messages).toEqual([]);
  });
});

describe("backtest — the same days as the cron", () => {
  it("ends on the day the cron judges this morning when an account further west has not finished yesterday", () => {
    // Meta (Los Angeles) stops at the 28th while Paris is already past the 29th; its 28th is high.
    const late = account(META, (back) => ({ spend: back === 1 ? 900 : 100 }));
    late.days.pop();
    const s = series(late, account(GOOGLE, () => ({ spend: 10 })));
    const d = def({ accounts: [META, GOOGLE], threshold: 500 });
    const cron = evaluate(d, s);
    expect(cron).toMatchObject({ status: "triggered", asOf: "2026-09-28", value: 910 });
    const b = backtest(d, s, { now: NOW });
    // Same last day: the replay's « today » is the cron's, and no day is lost to an account that is merely late.
    expect(b.current).toBe(cron.value);
    expect(b.skippedDays).toBe(0);
    expect(b.checkedDays).toBe(30);
    expect(b.messages).toEqual([{ date: "2026-09-29", value: 910, changePct: null }]);
  });

  it("has enough history for the longest working-days window and its comparison, over the 30 days replayed", () => {
    // What readClientSeries returns: SERIES_DAYS full days.
    const days: SeriesPoint[] = [];
    for (let back = SERIES_DAYS - 1; back >= 0; back--) days.push({ date: dateOf(back), spend: 100, conversions: 3, revenue: null, clicks: 0, impressions: 0 });
    const s = series({ account: META, currency: "EUR", eurRate: 1, days, today: null });
    for (const metric of ["spend", "conversions"] as const) {
      const b = backtest(def({ metric, condition: "drop_pct", threshold: 50, windowDays: 30, weekdaysOnly: true }), s, { now: NOW });
      expect(b.skippedDays, metric).toBe(0);
      expect(b.checkedDays).toBe(22);
    }
  });
});

describe("replayVerdict — what a replay is worth", () => {
  const cpa = (over: Partial<AlertDefinition> = {}) => def({ accounts: [META], metric: "cpa", threshold: 60, windowDays: 1, guards: { minConversions: 5 }, ...over });
  const verdict = (d: AlertDefinition, s: ClientSeries) => replayVerdict(d, s, backtest(d, s, { now: NOW }));

  it("is a measure while at most half of the days were not judged", () => {
    // 15 days under the guard (2 conversions for 100 €), 15 days judged.
    const half = series(account(META, (back) => ({ spend: 100, conversions: back % 2 ? 2 : 10 })));
    const b = backtest(cpa(), half, { now: NOW });
    expect(b).toMatchObject({ skippedDays: 15, checkedDays: 30, skipKind: "guard_conversions" });
    expect(replayVerdict(cpa(), half, b)).toEqual({ kind: "ok" });
    // One more day skipped: more than half.
    expect(replayVerdict(cpa(), half, { ...b, skippedDays: 16 }).kind).toBe("refused");
  });

  it("refuses a rule whose guards are never met, with the reason in plain French and the fields for the AI", () => {
    const thin = series(account(META, () => ({ spend: 100, conversions: 2 })));
    const v = verdict(cpa(), thin);
    expect(v).toEqual({
      kind: "refused",
      error: "Cette règle n'aurait pas pu être jugée sur aucun des 30 jours rejoués : le nombre minimum de conversions n'est presque jamais atteint. Telle quelle, elle ne vous préviendrait presque jamais : demandez une règle qui peut être jugée sur ce client.",
      hint: '"guards.minConversions" plus bas, ou une période "windowDays" plus longue',
    });
    const spend = verdict(def({ guards: { minSpend: 5000 } }), thin);
    expect(spend).toMatchObject({ kind: "refused", error: expect.stringContaining("la dépense minimum demandée n'est presque jamais atteinte") });
  });

  it("refuses a ROAS on an account that spends without tracking a value, and a window the history cannot fill", () => {
    const blind = series(account(META, () => ({ spend: 100, revenue: 300 })), account(GOOGLE, () => ({ spend: 50, revenue: null })));
    const roas = verdict(def({ accounts: [META, GOOGLE], metric: "roas", condition: "below", threshold: 2 }), blind);
    expect(roas).toMatchObject({ kind: "refused", error: expect.stringContaining("un compte qui dépense sans remonter de valeur de conversion") });
    // 40 days of history: a drop over 30 days against the 30 before can never be judged.
    const short = series({ ...account(META, () => ({ spend: 100 })), days: account(META, () => ({ spend: 100 })).days.slice(-40) });
    const drop = verdict(def({ condition: "drop_pct", threshold: 50, windowDays: 30 }), short);
    expect(drop).toMatchObject({ kind: "refused", error: expect.stringContaining("pas assez d'historique") });
  });

  it("waits, instead of refusing, when the days were lost to an account that could not be read", () => {
    const s = series(account(META, () => ({ spend: 500 })), { account: GOOGLE, currency: "EUR", eurRate: 1, days: [], today: null, error: "lecture Google Ads impossible pour le moment" });
    const d = def({ accounts: [META, GOOGLE] });
    expect(verdict(d, s)).toEqual({ kind: "wait", unread: [GOOGLE] });
    // The account the series does not even carry is unread too.
    expect(verdict(d, series(account(META, () => ({ spend: 500 })))).kind).toBe("wait");
    // An unreadable account the rule does not cover changes nothing.
    expect(verdict(def({ accounts: [META] }), s)).toEqual({ kind: "ok" });
  });

  it("counts working days only for a working-days alert", () => {
    const s = series(account(META, () => ({ spend: 100 })));
    const b = backtest(def({ weekdaysOnly: true }), s, { now: NOW });
    expect(b.checkedDays).toBe(22);
    // 11 of 22 skipped is half: still a measure. 12 is not.
    expect(replayVerdict(def({ weekdaysOnly: true }), s, { ...b, skippedDays: 11 })).toEqual({ kind: "ok" });
    expect(replayVerdict(def({ weekdaysOnly: true }), s, { ...b, skippedDays: 12, skipKind: "guard_spend" }).kind).toBe("refused");
  });
});
