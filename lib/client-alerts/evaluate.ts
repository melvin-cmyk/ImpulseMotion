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
 * date. Money is in euros (series.ts).
 */

import { createHash } from "node:crypto";
import { addDays } from "@/lib/date-ranges";
import type {
  AccountSeries, AlertAccountRef, AlertDefinition, AlertMetric, AlertPlatform, ClientSeries, Evaluation, EvaluationPart, EvaluationScope,
} from "@/lib/client-alerts/types";

export const PLATFORM_LABEL: Record<AlertPlatform, string> = { meta: "Meta Ads", google: "Google Ads" };
const PLATFORMS: AlertPlatform[] = ["meta", "google"];

/** `stopped` looks at the 7 days before its window to know the account was delivering. */
const STOP_LOOKBACK_DAYS = 7;
/** Hour of the account from which a day still at zero counts as a stop (same as the automatic alerts). */
const LIVE_STOP_HOUR = 13;

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
const daysText = (n: number) => (n === 1 ? "1 jour" : `${n} jours`);

function uncomputable(metric: AlertMetric, t: Totals, where: string): string {
  if (metric === "cpa") return `CPA incalculable : aucune conversion ${where}`;
  if (metric === "roas") {
    if (t.revenue === null) return "ROAS incalculable : aucun compte ne suit la valeur des conversions";
    return t.tracksAll ? `ROAS incalculable : aucune dépense ${where}` : "ROAS incalculable : un compte qui dépense ne suit pas la valeur des conversions";
  }
  if (metric === "revenue") return "Chiffre d'affaires inconnu : aucun compte ne suit la valeur des conversions";
  if (metric === "ctr") return `CTR incalculable : aucune impression ${where}`;
  return `Valeur incalculable ${where}`;
}

function guardReason(def: AlertDefinition, t: Totals, where: string): string | null {
  const { minSpend, minConversions } = def.guards ?? {};
  if (typeof minSpend === "number" && t.spend < minSpend) return `Trop peu de dépense pour juger : ${fr(t.spend)} € ${where}, il en faut ${fr(minSpend)} €`;
  if (typeof minConversions === "number" && t.conversions < minConversions) return `Trop peu de conversions pour juger : ${fr(t.conversions)} ${where}, il en faut ${fr(minConversions)}`;
  return null;
}

const covers = (a: AccountSeries, from: string, to: string) => a.days.length > 0 && a.days[0].date <= from && a.days[a.days.length - 1].date >= to;

interface Judged {
  part: EvaluationPart;
  status: Evaluation["status"];
  reason?: string;
  asOf: string;
}

/** One scope (every account, or the accounts of one platform) judged on its own sums. */
function judge(def: AlertDefinition, scope: EvaluationScope, accounts: AccountSeries[], asOf: string, live: boolean): Judged {
  const part: EvaluationPart = { scope, value: null, baseline: null, changePct: null, spend: 0, conversions: 0, triggered: false };
  const skip = (reason: string): Judged => ({ part, status: "skipped", reason, asOf });
  const settle = (at = asOf): Judged => ({ part, status: part.triggered ? "triggered" : "ok", asOf: at });

  const unread = accounts.find((a) => a.error || !a.days.length);
  if (unread) return skip(`Compte ${PLATFORM_LABEL[unread.account.platform]} « ${unread.account.name} » illisible${unread.error ? ` (${unread.error})` : ""}`);

  const n = def.windowDays;
  const from = addDays(asOf, -(n - 1));
  const enough = (first: string) => accounts.every((a) => covers(a, first, asOf));
  const tooShort = (days: number) => skip(`Pas assez de jours de données pour juger (il en faut ${days})`);
  const window = totalsOver(accounts, from, asOf);
  part.spend = window.spend;
  part.conversions = window.conversions;
  part.value = metricOf(def.metric, window);

  if (def.condition === "stopped") {
    if (def.metric !== "spend" && def.metric !== "conversions") return skip("Un arrêt ne se juge que sur la dépense ou les conversions");
    const before = (to: string) => totalsOver(accounts, addDays(to, -(STOP_LOOKBACK_DAYS - 1)), to);
    const beforeText = `sur les ${STOP_LOOKBACK_DAYS} jours précédents`;

    // The day in progress: nothing spent by the afternoon on accounts that spent yesterday.
    // Only the cron reads it; the replay has no past afternoons to look at.
    if (live && def.metric === "spend" && n === 1 && accounts.every((a) => a.today && a.today.hour >= LIVE_STOP_HOUR && a.today.spend === 0)
      && enough(addDays(asOf, -(STOP_LOOKBACK_DAYS - 1))) && totalsOver(accounts, asOf, asOf).spend > 0) {
      const prior = before(asOf);
      const today = addDays(asOf, 1);
      const guard = guardReason(def, prior, beforeText);
      part.spend = 0;
      part.conversions = accounts.reduce((s, a) => s + (a.today?.conversions ?? 0), 0);
      part.value = 0;
      part.baseline = prior.spend;
      if (guard) return { ...skip(guard), asOf: today };
      part.triggered = true;
      return settle(today);
    }

    if (!enough(addDays(from, -STOP_LOOKBACK_DAYS))) return tooShort(n + STOP_LOOKBACK_DAYS);
    const prior = before(addDays(from, -1));
    part.baseline = metricOf(def.metric, prior);
    const guard = guardReason(def, prior, beforeText);
    if (guard) return skip(guard);
    // Conversions: spending without converting. No spend at all is the other alert.
    part.triggered = part.value === 0 && (part.baseline ?? 0) > 0 && (def.metric === "spend" || window.spend > 0);
    return settle();
  }

  if (typeof def.threshold !== "number" || !Number.isFinite(def.threshold)) return skip("Seuil manquant dans la définition");
  const where = `sur ${daysText(n)}`;

  if (def.condition === "above" || def.condition === "below") {
    if (!enough(from)) return tooShort(n);
    const guard = guardReason(def, window, where);
    if (guard) return skip(guard);
    if (part.value === null) return skip(uncomputable(def.metric, window, where));
    part.triggered = def.condition === "above" ? part.value > def.threshold : part.value < def.threshold;
    return settle();
  }

  // drop_pct / rise_pct: the same metric over the window it is compared with.
  const shift = def.compare === "same_weekdays" ? Math.ceil(n / 7) * 7 : n;
  if (!enough(addDays(from, -shift))) return tooShort(n + shift);
  const reference = totalsOver(accounts, addDays(from, -shift), addDays(asOf, -shift));
  part.baseline = metricOf(def.metric, reference);
  const guard = guardReason(def, window, where);
  if (guard) return skip(guard);
  if (part.value === null) return skip(uncomputable(def.metric, window, where));
  if (part.baseline === null) return skip(`Pas de point de comparaison — ${uncomputable(def.metric, reference, "sur la période de comparaison")}`);
  if (part.baseline === 0) return skip("Pas de point de comparaison : valeur nulle sur la période de comparaison");
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
 * Pure. `asOf` = last full day of the window (default: lastFullDay, which is series.until for accounts in Europe).
 * `live` = the check of the cron, which may read the day in progress for `stopped`; the replay never does.
 */
export function evaluate(def: AlertDefinition, series: ClientSeries, opts: { asOf?: string; live?: boolean } = {}): Evaluation {
  const asOf = opts.asOf ?? lastFullDay(def, series);
  const live = opts.live === true;
  const accounts = accountsOf(def, series);
  const perPlatform = PLATFORMS
    .filter((p) => accounts.some((a) => a.account.platform === p))
    .map((p) => judge(def, p, accounts.filter((a) => a.account.platform === p), asOf, live));
  if (!perPlatform.length) return { status: "skipped", reason: "Aucun compte dans la définition", asOf, value: null, baseline: null, changePct: null, parts: [] };

  if (def.aggregation === "each") {
    const hit = perPlatform.find((j) => j.status === "triggered");
    const judged = perPlatform.find((j) => j.status !== "skipped");
    // Without a trigger, the figures shown are those of the first platform that could be judged.
    const lead = hit ?? judged ?? perPlatform[0];
    const status: Evaluation["status"] = hit ? "triggered" : judged ? "ok" : "skipped";
    return {
      status,
      ...(status === "skipped" ? { reason: [...new Set(perPlatform.map((j) => j.reason).filter(Boolean))].join(" · ") } : {}),
      asOf: lead.asOf, value: lead.part.value, baseline: lead.part.baseline, changePct: lead.part.changePct,
      parts: perPlatform.map((j) => j.part),
    };
  }

  const all = judge(def, "combined", accounts, asOf, live);
  return {
    status: all.status,
    ...(all.status === "skipped" ? { reason: all.reason } : {}),
    asOf: all.asOf, value: all.part.value, baseline: all.part.baseline, changePct: all.part.changePct,
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

/** Stable hash of what changes the evaluation or the delivery (not the label, not the explanation). */
export function definitionHash(def: AlertDefinition): string {
  const { label: _label, explanation: _explanation, ...rest } = def;
  void _label; void _explanation;
  const key = (a: AlertAccountRef) => `${a.platform}:${a.accountId}`;
  const accounts = [...(def.accounts ?? [])].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return createHash("sha256").update(canonical({ ...rest, accounts })).digest("hex");
}
