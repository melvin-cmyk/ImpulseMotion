/**
 * Client alerts — the judgement of one definition over a series. Pure: no
 * clock, no database, no network. The cron and the replay of the last 30 days
 * (backtest.ts) both go through `evaluate`, so what the consultant saw before
 * activating is what the cron computes afterwards.
 *
 * Three answers only:
 *   triggered   the condition is true over the window;
 *   ok          it was judged and it is false — what re-arms an alert;
 *   skipped     it could not be judged (account unreadable, guard not met,
 *               value that cannot be computed, not enough days). A skipped
 *               check never triggers and never re-arms.
 *
 * Days are the days of each account, in its own timezone, added up date by
 * date. Money is in euros (series.ts). Full days only: the day in progress is
 * never judged (a stop during the day is the automatic alerts' to watch).
 *
 * Where a window ends, and which days it holds — decided here and nowhere
 * else, so that the cron and the replay move together:
 *   - spend and click rate end on the last full day;
 *   - what depends on conversions (conversions, CPA, ROAS, revenue) ends ONE
 *     DAY EARLIER (conversionLagDays): the platforms go on attributing the
 *     sales of yesterday for a day or more, and a morning check on yesterday
 *     alone would see a CPA that is not the final one;
 *   - `weekdaysOnly` takes Saturdays and Sundays out of the series before any
 *     window is built: a window of 3 days is three working days, its
 *     comparison and the 7 days of reference of `stopped` likewise.
 * `Evaluation.asOf` is the real last day of the window, `from` its first.
 */

import { createHash } from "node:crypto";
import { addDays } from "@/lib/date-ranges";
import {
  compareShiftDays, conversionLagDays, cpaSpendFloor, STOP_LOOKBACK_DAYS,
  type AccountSeries, type AlertAccountRef, type AlertDefinition, type AlertMetric, type AlertPlatform, type ClientSeries, type Evaluation,
  type EvaluationPart, type EvaluationScope, type SkipKind,
} from "@/lib/client-alerts/types";

export const PLATFORM_LABEL: Record<AlertPlatform, string> = { meta: "Meta Ads", google: "Google Ads" };
const PLATFORMS: AlertPlatform[] = ["meta", "google"];


/** Ids as the platforms and the stored lists write them: with or without `act_`, with or without dashes. */
const normId = (id: string) => id.replace(/^act_/, "").replace(/-/g, "");
export const sameAccount = (a: Pick<AlertAccountRef, "platform" | "accountId">, b: Pick<AlertAccountRef, "platform" | "accountId">) =>
  a.platform === b.platform && normId(a.accountId) === normId(b.accountId);

/** The account tracks a conversion value: at least one day carries one (series.ts writes null on every day otherwise). */
export const tracksValue = (a: AccountSeries) => a.days.some((d) => d.revenue !== null);

export interface Totals {
  spend: number;
  conversions: number;
  /** Sum over the accounts that track a value; null when none does. */
  revenue: number | null;
  clicks: number;
  impressions: number;
  /** Every account that spent over the period tracks a value: a ROAS over all of them means something. */
  tracksAll: boolean;
}

/** Sum of the accounts over [from, to], both included. */
export function totalsOver(accounts: AccountSeries[], from: string, to: string): Totals {
  const t: Totals = { spend: 0, conversions: 0, revenue: null, clicks: 0, impressions: 0, tracksAll: accounts.length > 0 };
  for (const a of accounts) {
    const tracks = tracksValue(a);
    if (tracks) t.revenue ??= 0;
    let spent = 0;
    for (const d of a.days) {
      if (d.date < from || d.date > to) continue;
      spent += d.spend;
      t.conversions += d.conversions;
      t.clicks += d.clicks;
      t.impressions += d.impressions;
      if (tracks) t.revenue = (t.revenue ?? 0) + (d.revenue ?? 0);
    }
    t.spend += spent;
    // An account that spent nothing takes nothing away from the ROAS of the others: a dormant
    // account, which by nature shows no value, must not make the ROAS of a client unknown.
    if (!tracks && spent > 0) t.tracksAll = false;
  }
  return t;
}

/** Value of a metric from the sums of a window; null when it cannot be computed. */
export function metricOf(metric: AlertMetric, t: Totals): number | null {
  switch (metric) {
    case "spend": return t.spend;
    case "conversions": return t.conversions;
    case "revenue": return t.revenue;
    case "cpa": return t.conversions > 0 ? t.spend / t.conversions : null;
    // A ROAS with the spend of an account whose value is unknown would be wrong, not low.
    case "roas": return t.tracksAll && t.revenue !== null && t.spend > 0 ? t.revenue / t.spend : null;
    case "ctr": return t.impressions > 0 ? (t.clicks / t.impressions) * 100 : null;
    default: return null;
  }
}

const fr = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: n >= 100 ? 0 : 2 });

function uncomputable(metric: AlertMetric, t: Totals, where: string): string {
  if (metric === "cpa") return `CPA incalculable : aucune conversion ${where}`;
  if (metric === "roas") {
    if (t.revenue === null) return "ROAS incalculable : aucun compte ne suit la valeur des conversions";
    return t.tracksAll ? `ROAS incalculable : aucune dépense ${where}` : "ROAS incalculable : un compte qui dépense ne suit pas la valeur des conversions";
  }
  if (metric === "revenue") return "Revenu inconnu : aucun compte ne suit la valeur des conversions";
  if (metric === "ctr") return `CTR incalculable : aucune impression ${where}`;
  return `Valeur incalculable ${where}`;
}

function guardReason(def: AlertDefinition, t: Totals, where: string): string | null {
  const { minSpend, minConversions } = def.guards ?? {};
  if (typeof minSpend === "number" && t.spend < minSpend) return `Trop peu de dépense pour juger : ${fr(t.spend)} € ${where}, il en faut ${fr(minSpend)} €`;
  if (typeof minConversions === "number" && t.conversions < minConversions) {
    const floor = cpaSpendFloor(def);
    // A CPA « above » has a second way to be judged: the spend alone (see cpaSpendFloor).
    const or = floor !== null ? ` — ou ${fr(floor)} € dépensés` : "";
    return `Trop peu de conversions pour juger : ${fr(t.conversions)} ${where}, il en faut ${fr(minConversions)}${or}`;
  }
  return null;
}

const covers = (a: AccountSeries, from: string, to: string) => a.days.length > 0 && a.days[0].date <= from && a.days[a.days.length - 1].date >= to;

export const isWeekend = (date: string): boolean => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

/** The days that count for a definition: every day, or working days only (`weekdaysOnly`). */
function calendar(def: Pick<AlertDefinition, "weekdaysOnly">) {
  const counts = (date: string) => def.weekdaysOnly !== true || !isWeekend(date);
  /** The day itself when it counts, else the last one before it that does. */
  const last = (date: string) => { let d = date; while (!counts(d)) d = addDays(d, -1); return d; };
  /** `k` counting days before a counting day. */
  const back = (date: string, k: number) => { let d = date; for (let i = 0; i < k; i++) d = last(addDays(d, -1)); return d; };
  return { last, back };
}

/**
 * The window a definition is judged on when the last full day is `day`: its
 * first and last day (both included). The one place that says where a window
 * ends — the cron, the replay, the card and the message all read it.
 */
export function windowOf(def: Pick<AlertDefinition, "metric" | "windowDays" | "weekdaysOnly">, day: string): { from: string; to: string } {
  const cal = calendar(def);
  const to = cal.back(cal.last(day), conversionLagDays(def.metric));
  return { from: cal.back(to, def.windowDays - 1), to };
}

interface Judged {
  part: EvaluationPart;
  status: Evaluation["status"];
  reason?: string;
  skip?: SkipKind;
}

/** One scope (every account, or the accounts of one platform) judged on its own sums over the window [from, to]. */
function judge(def: AlertDefinition, scope: EvaluationScope, accounts: AccountSeries[], from: string, to: string): Judged {
  const part: EvaluationPart = { scope, value: null, baseline: null, changePct: null, spend: 0, conversions: 0, triggered: false };
  const skip = (reason: string, kind: SkipKind): Judged => ({ part, status: "skipped", reason, skip: kind });
  const guarded = (reason: string) => skip(reason, reason.startsWith("Trop peu de dépense") ? "guard_spend" : "guard_conversions");
  const settle = (): Judged => ({ part, status: part.triggered ? "triggered" : "ok" });

  const unread = accounts.find((a) => a.error || !a.days.length);
  if (unread) return skip(`Compte ${PLATFORM_LABEL[unread.account.platform]} « ${unread.account.name} » illisible${unread.error ? ` (${unread.error})` : ""}`, "unreadable");

  const cal = calendar(def);
  const n = def.windowDays;
  const unit = def.weekdaysOnly === true ? "ouvré" : "";
  const daysText = (k: number) => (k === 1 ? `1 jour${unit ? ` ${unit}` : ""}` : `${k} jours${unit ? ` ${unit}s` : ""}`);
  const enough = (first: string) => accounts.every((a) => covers(a, first, to));
  const tooShort = (days: number) => skip(`Pas assez de jours de données pour juger (il en faut ${daysText(days)})`, "no_history");
  const window = totalsOver(accounts, from, to);
  part.spend = window.spend;
  part.conversions = window.conversions;
  part.value = metricOf(def.metric, window);

  if (def.condition === "stopped") {
    if (def.metric !== "spend" && def.metric !== "conversions") return skip("Un arrêt ne se juge que sur la dépense ou les conversions", "definition");
    const first = cal.back(from, STOP_LOOKBACK_DAYS);
    if (!enough(first)) return tooShort(n + STOP_LOOKBACK_DAYS);
    const prior = totalsOver(accounts, first, cal.back(from, 1));
    part.baseline = metricOf(def.metric, prior);
    const guard = guardReason(def, prior, `sur les ${daysText(STOP_LOOKBACK_DAYS)} précédents`);
    if (guard) return guarded(guard);
    // Conversions: spending without converting. No spend at all is the other alert.
    part.triggered = part.value === 0 && (part.baseline ?? 0) > 0 && (def.metric === "spend" || window.spend > 0);
    return settle();
  }

  if (typeof def.threshold !== "number" || !Number.isFinite(def.threshold)) return skip("Seuil manquant dans la définition", "definition");
  const where = `sur ${daysText(n)}`;

  if (def.condition === "above" || def.condition === "below") {
    if (!enough(from)) return tooShort(n);
    const guard = guardReason(def, window, where);
    // Too few conversions (or none, `value` is then null) but enough spent: the CPA is over whatever comes next.
    const floor = cpaSpendFloor(def);
    const { minSpend, minConversions } = def.guards ?? {};
    const fewConversions = window.conversions <= 0 || (typeof minConversions === "number" && window.conversions < minConversions);
    if (floor !== null && fewConversions && window.spend >= floor && !(typeof minSpend === "number" && window.spend < minSpend)) {
      part.triggered = true;
      return settle();
    }
    if (guard) return guarded(guard);
    if (part.value === null) {
      return skip(floor !== null
        ? `Aucune conversion ${where} pour ${fr(window.spend)} € dépensés : rien à juger avant ${fr(floor)} €`
        : uncomputable(def.metric, window, where), "no_value");
    }
    part.triggered = def.condition === "above" ? part.value > def.threshold : part.value < def.threshold;
    return settle();
  }

  // drop_pct / rise_pct: the same metric over the window it is compared with — the counting days
  // just before, or the same days whole weeks earlier.
  const weeks = def.compare === "same_weekdays";
  const shift = compareShiftDays(def);
  const refFrom = weeks ? addDays(from, -shift) : cal.back(from, n);
  const refTo = weeks ? addDays(to, -shift) : cal.back(from, 1);
  if (!enough(refFrom)) return tooShort(2 * n);
  const reference = totalsOver(accounts, refFrom, refTo);
  part.baseline = metricOf(def.metric, reference);
  // The guards are read on the REFERENCE: a spend that falls from 500 € to 10 € is the very thing to
  // say, not « too little spend to judge ». What must be big enough is what the fall is measured from.
  const guard = guardReason(def, reference, "sur la période de comparaison");
  if (guard) return guarded(guard);
  if (part.value === null) return skip(uncomputable(def.metric, window, where), "no_value");
  if (part.baseline === null) return skip(`Pas de point de comparaison — ${uncomputable(def.metric, reference, "sur la période de comparaison")}`, "no_reference");
  if (part.baseline === 0) return skip("Pas de point de comparaison : valeur nulle sur la période de comparaison", "no_reference");
  part.changePct = ((part.value - part.baseline) / part.baseline) * 100;
  part.triggered = def.condition === "drop_pct" ? part.changePct <= -def.threshold : part.changePct >= def.threshold;
  return settle();
}

/** The series of the accounts of the definition; an account the series does not carry counts as unreadable. */
function accountsOf(def: AlertDefinition, series: ClientSeries): AccountSeries[] {
  return def.accounts.map((ref) =>
    series.accounts.find((a) => sameAccount(a.account, ref))
      ?? { account: ref, currency: ref.currency ?? "EUR", eurRate: 1, days: [], today: null, error: "compte non lu" });
}

/**
 * Last day that is complete for every readable account of the definition.
 * It is `series.until` (yesterday in Paris), or the day before while an
 * account further west has not finished its own yesterday: without it, an
 * alert on an American account would be skipped at every morning check.
 */
export function lastFullDay(def: AlertDefinition, series: ClientSeries): string {
  const readable = accountsOf(def, series).filter((a) => !a.error && a.days.length);
  const late = readable.some((a) => a.days[a.days.length - 1].date < series.until);
  const dayBefore = addDays(series.until, -1);
  return late && readable.every((a) => a.days[a.days.length - 1].date >= dayBefore) ? dayBefore : series.until;
}

/**
 * Pure. `asOf` = the last full day at the time of the check (default:
 * lastFullDay, which is series.until for accounts in Europe); the window is
 * windowOf(def, asOf), and the evaluation reports its real first and last day.
 */
export function evaluate(def: AlertDefinition, series: ClientSeries, opts: { asOf?: string } = {}): Evaluation {
  const { from, to } = windowOf(def, opts.asOf ?? lastFullDay(def, series));
  // Working days only: Saturdays and Sundays leave the series before any window is built.
  const accounts = accountsOf(def, series).map((a) => (def.weekdaysOnly === true ? { ...a, days: a.days.filter((d) => !isWeekend(d.date)) } : a));
  const perPlatform = PLATFORMS
    .filter((p) => accounts.some((a) => a.account.platform === p))
    .map((p) => judge(def, p, accounts.filter((a) => a.account.platform === p), from, to));
  if (!perPlatform.length) return { status: "skipped", reason: "Aucun compte dans la définition", skip: "definition", asOf: to, from, value: null, baseline: null, changePct: null, parts: [] };

  if (def.aggregation === "each") {
    const hit = perPlatform.find((j) => j.status === "triggered");
    const judged = perPlatform.find((j) => j.status !== "skipped");
    const unjudged = perPlatform.some((j) => j.status === "skipped");
    // Without a trigger, the figures shown are those of the first platform that could be judged.
    const lead = hit ?? judged ?? perPlatform[0];
    // « ok » re-arms: it takes every platform judged and none triggered. One platform that could
    // not be judged may be the one in trouble — the alert is then neither true nor back to normal.
    const status: Evaluation["status"] = hit ? "triggered" : unjudged ? "skipped" : "ok";
    return {
      status,
      ...(status === "skipped" ? {
        reason: [...new Set(perPlatform.map((j) => j.reason).filter(Boolean))].join(" · "),
        // An account that could not be read comes first: it is what may change by itself.
        skip: perPlatform.find((j) => j.skip === "unreadable")?.skip ?? perPlatform.find((j) => j.skip)?.skip,
      } : {}),
      asOf: to, from, value: lead.part.value, baseline: lead.part.baseline, changePct: lead.part.changePct,
      parts: perPlatform.map((j) => j.part),
    };
  }

  const all = judge(def, "combined", accounts, from, to);
  return {
    status: all.status,
    ...(all.status === "skipped" ? { reason: all.reason, skip: all.skip } : {}),
    asOf: to, from, value: all.part.value, baseline: all.part.baseline, changePct: all.part.changePct,
    // The platforms are detail for the message: they never decide.
    parts: [all.part, ...perPlatform.map((j) => ({ ...j.part, triggered: false }))],
  };
}

/** JSON with sorted keys and no undefined: the same object always gives the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Stable hash of what changes the evaluation or the delivery: not the label,
 * not the explanation, and of the accounts only which they are (platform and
 * id, whatever the writing) — an account renamed at the platform, or whose
 * currency was learnt since, is the same rule: it must stay « en service » on
 * its card, resumable, and its silence must not start again.
 */
export function definitionHash(def: AlertDefinition): string {
  const { label: _label, explanation: _explanation, ...rest } = def;
  void _label; void _explanation;
  const accounts = [...new Set((def.accounts ?? []).map((a) => `${a.platform}:${normId(a.accountId)}`))].sort();
  return createHash("sha256").update(canonical({ ...rest, accounts })).digest("hex");
}
