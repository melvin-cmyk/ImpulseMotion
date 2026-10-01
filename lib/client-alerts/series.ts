/**
 * Client alerts — the daily series the alerts are judged on, and the text of
 * them the AI reads when it writes a proposal.
 *
 * One read per account: SERIES_DAYS full days ending yesterday plus the day in
 * progress, in the timezone of the account (the automatic alerts read Google
 * in Paris days; here a day at zero can trigger by itself, and an account in
 * Denver or Tokyo must not be judged on a day it has not finished).
 * Conversions and revenue follow the settings of the account exactly as
 * lib/auto-alerts does. Everything that is money is converted to euros here,
 * once, at today's rate: one alert adds up accounts of several currencies,
 * and its thresholds are amounts in euros.
 *
 * An account that cannot be read comes back with `error` and no day, and
 * whatever depends on it is skipped (evaluate.ts). A failed read is never
 * cached: `cached` stores nothing when its fetcher throws, so the reader
 * throws and the failure is turned into `error` outside of it. `error` is a
 * fixed French phrase per kind of failure (readError): the raw text of a
 * platform goes to the logs only, never to the page nor to the AI.
 */

import { getMetaSystemToken, getAccountDailyInsights, purchasesFor, computeRevenue } from "@/lib/meta-api";
import { MetaApiError } from "@/lib/meta-errors";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { relayDirectTool } from "@/lib/relay-tool";
import { extractRows } from "@/lib/dashboard-widgets";
import { addDays, todayIn } from "@/lib/date-ranges";
import { cached } from "@/lib/kpi-cache";
import { FX_FALLBACK, loadFx } from "@/lib/cockpit/fx";
import { hourIn } from "@/lib/auto-alerts/meta";
import { toDayPoint } from "@/lib/auto-alerts/google";
import { fetchTikTokDaily } from "@/lib/tiktok-data";
import { prisma } from "@/lib/prisma";
import { metricOf, PLATFORM_LABEL, totalsOver, tracksValue, type Totals } from "@/lib/client-alerts/evaluate";
import { SERIES_DAYS, type AccountSeries, type AlertAccountRef, type AlertPlatform, type ClientSeries, type SeriesPoint } from "@/lib/client-alerts/types";

const PARIS = "Europe/Paris";
const CONCURRENCY = 4;
/** The assistant validates its proposals again at every load of the page: the platforms are not read each time. */
const CACHE_TTL_MS = 10 * 60_000;
/** One slow account must not hold the others back. */
const READ_TIMEOUT_MS = 45_000;

const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? ""))) || 0;
const cents = (n: number) => Math.round(n * 100) / 100;

function within<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ReadTimeoutError()), READ_TIMEOUT_MS); });
  return Promise.race([p, clock]).finally(() => { if (timer) clearTimeout(timer); });
}

/** A currency the rates do not cover: said as such, it is ours to fix, not the platform's. */
class NoRateError extends Error {
  constructor(readonly currency: string) {
    super(`devise ${currency} sans taux de change`);
    this.name = "NoRateError";
  }
}
/** The read did not answer in READ_TIMEOUT_MS. */
class ReadTimeoutError extends Error {
  constructor() {
    super(`pas de réponse en ${READ_TIMEOUT_MS / 1000} s`);
    this.name = "ReadTimeoutError";
  }
}

/**
 * Why an account could not be read, as one fixed French phrase per kind of
 * failure: it is shown on the card and on the page, and kept in the series.
 * The raw text of a platform (an API message, a stack) never goes further
 * than the logs — neither to a consultant nor to the AI.
 */
export function readError(e: unknown, platform: AlertPlatform): string {
  const where = PLATFORM_LABEL[platform];
  if (e instanceof MetaApiError) {
    if (e.kind === "permission") return `accès au compte refusé par ${where}`;
    if (e.kind === "auth") return `connexion à ${where} refusée`;
    if (e.kind === "rate_limit") return `limite d'appels ${where} atteinte`;
  }
  if (e instanceof NoRateError) return `devise ${e.currency.slice(0, 8)} sans taux de change`;
  if (e instanceof ReadTimeoutError) return `${where} n'a pas répondu à temps`;
  return `lecture ${where} impossible pour le moment`;
}

/** Euro value of one unit. No rate = no series: an amount in an unknown currency must not be read as euros. */
function eurRateOf(currency: string, rates: Record<string, number>): number {
  const rate = rates[currency];
  if (!(rate > 0)) throw new NoRateError(currency);
  return rate;
}

/** Rows of a platform (account currency, days with delivery only) → the series: no gap, euros, today apart. */
function build(account: AlertAccountRef, currency: string, eurRate: number, rows: SeriesPoint[], since: string, today: string, hour: number): AccountSeries {
  const by = new Map(rows.map((r) => [r.date, r]));
  // A day without value is a day at 0, not an account without conversion value.
  const tracks = rows.some((r) => r.revenue !== null);
  const points: SeriesPoint[] = [];
  for (let date = since; date <= today; date = addDays(date, 1)) {
    const r = by.get(date);
    points.push({
      date,
      spend: cents((r?.spend ?? 0) * eurRate),
      conversions: r?.conversions ?? 0,
      revenue: tracks ? cents((r?.revenue ?? 0) * eurRate) : null,
      clicks: r?.clicks ?? 0,
      impressions: r?.impressions ?? 0,
    });
  }
  const last = points.pop()!;
  return { account, currency, eurRate, days: points, today: { spend: last.spend, conversions: last.conversions, hour } };
}

async function readMeta(account: AlertAccountRef, now: Date, rates: Record<string, number>): Promise<AccountSeries> {
  const token = getMetaSystemToken();
  const settings = await getAccountProfileSettings("meta", account.accountId);
  const tz = settings.timezone;
  const today = todayIn(tz, now);
  const since = addDays(today, -SERIES_DAYS);
  const rows = await getAccountDailyInsights(token, account.accountId, { since, until: today });
  const currency = settings.currency ?? rows.find((r) => r.currency)?.currency ?? account.currency ?? "EUR";
  const points = rows.map((r): SeriesPoint => {
    const rev = computeRevenue(r, settings.aov, settings.conversionEvent);
    return {
      date: r.date_start ?? "", spend: num(r.spend), conversions: purchasesFor(r, settings.conversionEvent),
      revenue: rev.unavailable ? null : rev.revenue, clicks: num(r.clicks), impressions: num(r.impressions),
    };
  });
  return build(account, currency, eurRateOf(currency, rates), points, since, today, hourIn(tz, now));
}

/**
 * One GAQL query. The days of a Google account are those of its own timezone,
 * which is only known once it answered: the query is one day wider on each
 * side, and the series is cut to the days of the account afterwards. An
 * account without any row (no delivery over the period) says nothing of
 * itself: Paris, and the currency stored with the client.
 */
async function readGoogle(account: AlertAccountRef, now: Date, rates: Record<string, number>): Promise<AccountSeries> {
  const paris = todayIn(PARIS, now);
  const query = "SELECT customer.currency_code, customer.time_zone, segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.clicks, metrics.impressions"
    + ` FROM customer WHERE segments.date BETWEEN '${addDays(paris, -SERIES_DAYS - 1)}' AND '${addDays(paris, 1)}'`;
  const answer = extractRows(await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", { input: JSON.stringify({ customer_id: account.accountId, gaql_query: query }) }, 25_000));
  // An empty result comes back as one row of metadata (fieldMask, requestId): not a day.
  const rows = answer.filter((r) => typeof (r.segments as Record<string, unknown> | undefined)?.date === "string");
  const customer = rows.map((r) => r.customer as Record<string, unknown> | undefined).find((c) => !!c) ?? {};
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  const currency = text(customer.currencyCode ?? customer.currency_code) ?? account.currency ?? "EUR";
  const tz = text(customer.timeZone ?? customer.time_zone) ?? PARIS;
  const today = todayIn(tz, now);
  const points = rows.map((row): SeriesPoint => {
    const m = (row.metrics as Record<string, unknown>) ?? {};
    return { ...toDayPoint(row), clicks: num(m.clicks), impressions: num(m.impressions) };
  });
  return build(account, currency, eurRateOf(currency, rates), points, addDays(today, -SERIES_DAYS), today, hourIn(tz, now));
}

/** Timezone TikTok gave when the account was attached to a dashboard (lib/tiktok-accounts.ts); null when unknown. */
async function tiktokTimezone(advertiserId: string): Promise<string | null> {
  try {
    const source = await prisma.dashboardSource.findFirst({ where: { kind: "tiktok", externalId: advertiserId }, select: { config: true } });
    const tz = (JSON.parse(source?.config || "{}") as { timezone?: unknown }).timezone;
    return typeof tz === "string" && tz ? tz : null;
  } catch {
    return null;
  }
}

/**
 * One daily report (lib/tiktok-data.ts, ranges of 30 days summed there). The
 * days are those of the account timezone, known from its dashboard, else
 * Paris; the currency is the one stored with the client. TikTok's
 * « conversion » (the optimisation event) is the conversion, the value of its
 * purchases the revenue.
 */
async function readTikTok(account: AlertAccountRef, now: Date, rates: Record<string, number>): Promise<AccountSeries> {
  const tz = (await tiktokTimezone(account.accountId)) ?? PARIS;
  const today = todayIn(tz, now);
  const since = addDays(today, -SERIES_DAYS);
  const currency = account.currency ?? "EUR";
  const eurRate = eurRateOf(currency, rates);
  const rows = await fetchTikTokDaily(account.accountId, since, today);
  const points = rows.map((r): SeriesPoint => ({
    date: r.date, spend: r.spend, conversions: r.conversions,
    revenue: r.purchaseValue > 0 ? r.purchaseValue : null, clicks: r.clicks, impressions: r.impressions,
  }));
  return build(account, currency, eurRate, points, since, today, hourIn(tz, now));
}

const READERS: Record<AlertPlatform, typeof readMeta> = { meta: readMeta, google: readGoogle, tiktok: readTikTok };

async function readAccount(account: AlertAccountRef, now: Date, rates: Record<string, number>, fresh: boolean): Promise<AccountSeries> {
  try {
    // The day is part of the key: a series read before midnight is not served after it.
    const key = `client-alerts:series:${account.platform}:${account.accountId}:${todayIn(PARIS, now)}`;
    const read = await cached(
      key,
      () => within(READERS[account.platform](account, now, rates)),
      { ttlMs: CACHE_TTL_MS, refresh: fresh },
    );
    // The name and the currency shown are those the caller knows today, not those of the cached read.
    return { ...read, account };
  } catch (e) {
    // The cause is for the logs; the series only carries a fixed phrase (readError).
    console.error(`[client-alerts] ${account.platform} ${account.accountId} unreadable`, e);
    const currency = account.currency ?? "EUR";
    return { account, currency, eurRate: rates[currency] ?? 1, days: [], today: null, error: readError(e, account.platform) };
  }
}

/**
 * SERIES_DAYS full days and the day in progress for every account, in euros.
 * It never throws: an account that cannot be read comes back with `error` and
 * no day, and rates that cannot be loaded fall back to the fixed table, as
 * lib/cockpit/fx.ts does itself when the ECB is unreachable.
 */
export async function readClientSeries(accounts: AlertAccountRef[], opts: { now?: Date; fresh?: boolean } = {}): Promise<ClientSeries> {
  const now = opts.now ?? new Date();
  const rates = await loadFx().then((fx) => fx.rates, (e): Record<string, number> => {
    console.error("[client-alerts] exchange rates unreadable, fixed table used", e);
    return { ...FX_FALLBACK };
  });
  const out = new Array<AccountSeries>(accounts.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, accounts.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= accounts.length) return;
      out[i] = await readAccount(accounts[i], now, rates, opts.fresh === true);
    }
  });
  await Promise.all(workers);
  return { readAt: now.toISOString(), until: addDays(todayIn(PARIS, now), -1), accounts: out };
}

// ── What the AI reads ────────────────────────────────────────────────────────

/** Short numbers: no decimals from 100 up, two at most below. */
function short(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 100) return String(Math.round(n));
  return String(Math.round(n * 100) / 100);
}

const dayCells = (t: Totals) => `${short(t.spend)} ${short(t.conversions)} ${short(t.revenue)}`;

function windowLine(t: Totals): string {
  const ctr = metricOf("ctr", t);
  return `dépense ${short(t.spend)}, conv. ${short(t.conversions)}, revenu ${short(t.revenue)}, CPA ${short(metricOf("cpa", t))}, ROAS ${short(metricOf("roas", t))}, CTR ${ctr === null ? "—" : `${short(ctr)} %`}`;
}

/** What the AI reads of an account that could not be read, whatever the reason. */
const UNREADABLE = "compte illisible";

/** Compact text of the last `days` days (per platform and combined, euros) — what the AI reads. */
export function summarizeSeries(series: ClientSeries, days = 60): string {
  const lines: string[] = ["Comptes :"];
  for (const a of series.accounts) {
    // Whatever `error` holds stays here: the model reads one fixed phrase, never the text of a failure.
    const state = a.error
      ? UNREADABLE
      : `${a.currency}${a.currency !== "EUR" ? " converti en euros" : ""} · ${tracksValue(a) ? "valeur suivie" : "valeur non suivie"}`;
    lines.push(`- ${PLATFORM_LABEL[a.account.platform]} · ${a.account.name} · ${state}`);
  }
  const readable = series.accounts.filter((a) => !a.error && a.days.length);
  if (!readable.length) return [...lines, "Aucune donnée lisible."].join("\n");

  const SHORT: Record<AlertPlatform, string> = { meta: "Meta", google: "Google", tiktok: "TikTok" };
  const groups: Array<{ label: string; accounts: AccountSeries[] }> = (["meta", "google", "tiktok"] as AlertPlatform[])
    .map((p) => ({ label: SHORT[p], accounts: readable.filter((a) => a.account.platform === p) }))
    .filter((g) => g.accounts.length > 0);
  // One platform only: its figures are the total.
  if (groups.length > 1) groups.push({ label: "Total", accounts: readable });

  const until = series.until;
  const oldest = readable.reduce((min, a) => (a.days[0].date < min ? a.days[0].date : min), until);
  const since = [addDays(until, -(Math.max(1, days) - 1)), oldest].sort()[1];
  lines.push(`Jours complets du ${since} au ${until}, montants en euros, « — » = non suivi.`);
  lines.push(`jour | ${groups.map((g) => `${g.label} dépense conv. revenu`).join(" | ")}`);
  for (let date = since; date <= until; date = addDays(date, 1)) {
    lines.push(`${date.slice(5)} | ${groups.map((g) => dayCells(totalsOver(g.accounts, date, date))).join(" | ")}`);
  }
  for (const n of [7, 30]) {
    const from = addDays(until, -(n - 1));
    lines.push(`${n} derniers jours — ${groups.map((g) => `${g.label} : ${windowLine(totalsOver(g.accounts, from, until))}`).join(" · ")}`);
  }
  return lines.join("\n");
}
