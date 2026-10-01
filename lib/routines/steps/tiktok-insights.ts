/**
 * Routines — tiktok.insights: TikTok Ads figures of the client of the
 * routine, per account, per campaign or per day. Read only: no routine step
 * writes to TikTok.
 *
 * The advertisers are those attached to the routine's dashboard
 * (DashboardSource of kind "tiktok", lib/tiktok-accounts.ts), read at every
 * run: never an id written in the step, in a Sheet or by an AI. A routine
 * without a dashboard, or whose client has no TikTok account, cannot run it.
 * Who may read them is checked by lib/routines/store.ts (routineTikTokIds),
 * with the Meta and Google accounts of the routine.
 *
 * With `clients` the step reads the TikTok accounts of several clients
 * instead (lib/routines/clients.ts, at every run, in the scope of who answers
 * for the routine): every row then starts with client_name, platform,
 * account_id and account_name, before advertiser_id and advertiser_name.
 *
 * The figures come from lib/tiktok-data.ts (relay's direct call, ranges of
 * more than 30 days cut and summed there). Windows are the ones of
 * google.insights: full days ending yesterday, in the routine's timezone.
 *
 * Output, one row per advertiser, per campaign or per advertiser and day:
 *   advertiser_id, advertiser_name, currency   always (name and currency as
 *                                              stored when the account was attached)
 *   campaign_id, campaign_name, objective      level campaign
 *   date_start, date_stop                      the window read; level day: the day itself
 *   spend, cpa, cpm, purchase_value            account currency, 2 decimals
 *   ctr                                        percentage (2.35 = 2,35 %)
 *   roas                                       purchase value / spend
 *   cpa, cpm, ctr, roas                        null when the divisor is 0
 */

import { prisma } from "@/lib/prisma";
import { checkAdvertiser, normalizeAdvertiserId } from "@/lib/tiktok-accounts";
import { fetchTikTokCampaigns, fetchTikTokDaily, fetchTikTokTotals, type TikTokStats } from "@/lib/tiktok-data";
import { windowRange } from "@/lib/routines/steps/google-insights";
import { type Checked, done, errorMessage, failed, readStepBase, refuse } from "@/lib/routines/steps/sheet-read";
import { readClientSelection } from "@/lib/routines/client-selection";
import { clientCells, readEachAccount, resolveClientAccounts, withClientColumns, type ClientAccount } from "@/lib/routines/clients";
import type { Cell, ErrorClass, PreflightIssue, Row, StepContext, StepHandler, StepRunOutcome, TikTokInsightsStep } from "@/lib/routines/types";

export const TIKTOK_LEVELS = ["account", "campaign", "day"] as const;
export const TIKTOK_WINDOWS = ["yesterday", "7d", "14d", "30d", "month_to_date"] as const;
export const TIKTOK_METRICS = [
  "spend", "impressions", "clicks", "ctr", "cpm", "conversions", "cpa", "purchases", "purchase_value", "roas", "video_views",
] as const;
type Level = (typeof TIKTOK_LEVELS)[number];
type Window = (typeof TIKTOK_WINDOWS)[number];
type Metric = (typeof TIKTOK_METRICS)[number];

/** Advertisers read per run, at most: each one is a report of its own. */
export const MAX_ADVERTISERS = 10;
export const MAX_CAMPAIGNS = 500;

const IDENTITY: Record<Level, readonly string[]> = {
  account: ["advertiser_id", "advertiser_name", "currency"],
  campaign: ["advertiser_id", "advertiser_name", "campaign_id", "campaign_name", "objective", "currency"],
  day: ["advertiser_id", "advertiser_name", "currency"],
};
const DATE_COLUMNS = ["date_start", "date_stop"] as const;

/** A TikTok advertiser of the routine, as attached to its dashboard. */
export interface RoutineTikTokAccount { id: string; name: string; currency: string | null }

/** Advertisers attached to the dashboard and still in service, oldest first. Empty without a dashboard. */
export async function routineTikTokAccounts(dashboardId: string | null | undefined): Promise<RoutineTikTokAccount[]> {
  if (!dashboardId) return [];
  const rows = await prisma.dashboardSource.findMany({
    where: { dashboardId, kind: "tiktok", status: { not: "disabled" } },
    orderBy: { createdAt: "asc" },
    select: { externalId: true, label: true, config: true },
  });
  const out: RoutineTikTokAccount[] = [];
  for (const r of rows) {
    const id = normalizeAdvertiserId(r.externalId);
    if (!id || out.some((a) => a.id === id)) continue;
    let currency: string | null = null;
    try {
      const config = JSON.parse(r.config || "{}") as { currency?: unknown };
      currency = typeof config.currency === "string" && config.currency ? config.currency : null;
    } catch { /* no currency */ }
    out.push({ id, name: r.label?.trim() || id, currency });
  }
  return out;
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Figures of TikTok → the metrics asked for, ratios computed here. */
export function metricCells(s: TikTokStats, metrics: readonly Metric[]): Row {
  const computed: Record<Metric, Cell> = {
    spend: round(s.spend),
    impressions: s.impressions,
    clicks: s.clicks,
    ctr: s.impressions > 0 ? round((s.clicks / s.impressions) * 100) : null,
    cpm: s.impressions > 0 ? round((s.spend / s.impressions) * 1000) : null,
    conversions: round(s.conversions),
    cpa: s.conversions > 0 ? round(s.spend / s.conversions) : null,
    purchases: round(s.purchases),
    purchase_value: round(s.purchaseValue),
    roas: s.spend > 0 ? round(s.purchaseValue / s.spend) : null,
    video_views: s.videoViews,
  };
  const row: Row = {};
  for (const m of metrics) row[m] = computed[m];
  return row;
}

/**
 * TikTok's own errors (lib/tiktok-data.ts throws "TikTok <code> : …") are the
 * account's problem, except the rate limit (40100) and TikTok's server errors
 * (5xxxx): a new attempt may pass. Anything else (relay, network) is infra.
 */
export function tiktokErrorClass(message: string): ErrorClass {
  const m = /^TikTok (\d+)/.exec(message);
  if (!m) return "infra";
  return m[1] === "40100" || m[1].startsWith("5") ? "infra" : "functional";
}

function validate(raw: unknown): Checked<TikTokInsightsStep> {
  // No account field: an advertiser id written in a step is refused as an unknown key.
  const head = readStepBase(raw, "tiktok.insights", ["level", "window", "metrics", "clients"]);
  if (!head.ok) return head;
  const { level, window, metrics } = head.raw;
  const clients = head.raw.clients === undefined ? null : readClientSelection(head.raw.clients);
  if (clients && !clients.ok) return refuse(clients.error);
  if (clients?.ok && clients.value === "all" && level === "day") return refuse(`"clients": "all" se lit au niveau "account" ou "campaign" seulement`);
  if (!TIKTOK_LEVELS.includes(level as Level)) return refuse(`level attendu : ${TIKTOK_LEVELS.join(", ")}`);
  if (!TIKTOK_WINDOWS.includes(window as Window)) return refuse(`window attendu : ${TIKTOK_WINDOWS.join(", ")}`);
  if (!Array.isArray(metrics) || metrics.length === 0) return refuse("metrics : au moins une métrique");
  const kept: Metric[] = [];
  for (const m of metrics) {
    if (!TIKTOK_METRICS.includes(m as Metric)) return refuse(`métrique inconnue : ${String(m).slice(0, 40)} (acceptées : ${TIKTOK_METRICS.join(", ")})`);
    if (!kept.includes(m as Metric)) kept.push(m as Metric);
  }
  return {
    ok: true,
    step: { ...head.base, type: "tiktok.insights", level: level as Level, window: window as Window, metrics: kept, ...(clients?.ok ? { clients: clients.value } : {}) },
  };
}

const columnsOf = (step: TikTokInsightsStep) => [...IDENTITY[step.level], ...DATE_COLUMNS, ...step.metrics];

/** The rows of one advertiser, as the step asks for them. Throws what TikTok or the relay said. */
async function readAdvertiser(step: TikTokInsightsStep, a: RoutineTikTokAccount, range: { since: string; until: string }): Promise<Row[]> {
  const rows: Row[] = [];
  const who: Row = { advertiser_id: a.id, advertiser_name: a.name };
  if (step.level === "account") {
    const s = await fetchTikTokTotals(a.id, range.since, range.until);
    // An account that did not deliver gives no row, as Google gives none.
    if (s.impressions > 0 || s.spend > 0) rows.push({ ...who, currency: a.currency, date_start: range.since, date_stop: range.until, ...metricCells(s, step.metrics) });
  } else if (step.level === "day") {
    for (const d of await fetchTikTokDaily(a.id, range.since, range.until)) {
      rows.push({ ...who, currency: a.currency, date_start: d.date, date_stop: d.date, ...metricCells(d, step.metrics) });
    }
  } else {
    for (const c of await fetchTikTokCampaigns(a.id, range.since, range.until)) {
      if (c.impressions <= 0 && c.spend <= 0) continue;
      rows.push({
        ...who, campaign_id: c.id, campaign_name: c.name, objective: c.objective, currency: a.currency,
        date_start: range.since, date_stop: range.until, ...metricCells(c, step.metrics),
      });
    }
  }
  return rows;
}

/** The advertisers of several clients: one that fails is said, the others are kept. */
async function runClients(step: TikTokInsightsStep, ctx: StepContext, rowsIn: number): Promise<StepRunOutcome> {
  if (!ctx.accounts) return failed(rowsIn, "functional", "Périmètre de lecture inconnu : aucun compte client n'est lu.");
  const { accounts, warnings, notices } = await resolveClientAccounts(step.clients!, "tiktok", ctx.accounts);
  const columns = withClientColumns(columnsOf(step));
  if (!accounts.length) {
    if (ctx.accounts.problem) return failed(rowsIn, "functional", ctx.accounts.problem, { warnings, notices });
    return done(rowsIn, 0, { output: { rows: { columns, rows: [], truncated: false } }, warnings, notices });
  }
  const range = windowRange(step.window, ctx.routine.timezone, ctx.now);
  const { results, unread } = await readEachAccount(accounts, async (a) => {
    try {
      return { ok: true as const, rows: await readAdvertiser(step, { id: a.accountId, name: a.accountName, currency: a.currency }, range) };
    } catch (e) {
      const message = errorMessage(e);
      return { ok: false as const, message, errorClass: tiktokErrorClass(message) };
    }
  }, { deadlineAt: ctx.deadlineAt, signal: ctx.signal });
  const rows: Row[] = [];
  const failures: Array<{ account: ClientAccount; message: string; errorClass: ErrorClass }> = [];
  for (const { account, result } of results) {
    if (!result.ok) { failures.push({ account, message: result.message, errorClass: result.errorClass }); continue; }
    for (const row of result.rows) rows.push({ ...row, ...clientCells(account) });
  }
  for (const f of failures.slice(0, 10)) warnings.push(`${f.account.clientName} (TikTok ${f.account.accountId}) non lu : ${f.message}`);
  if (failures.length > 10) warnings.push(`${failures.length - 10} autres comptes TikTok non lus.`);
  if (unread) {
    const late = `Temps réservé à la suite de la routine : ${unread} compte${unread > 1 ? "s" : ""} TikTok NON LU${unread > 1 ? "S" : ""} sur ${accounts.length}.`;
    warnings.push(late);
    notices.push(late);
  }
  if (failures.length && failures.length === results.length) {
    return failed(rowsIn, failures.every((f) => f.errorClass === "functional") ? "functional" : "infra", `Aucun compte TikTok lu : ${failures[0].message}`, { warnings, notices });
  }
  if (step.level === "campaign") rows.sort((x, y) => Number(y.spend ?? 0) - Number(x.spend ?? 0));
  const truncated = unread > 0 || (step.level === "campaign" && rows.length > MAX_CAMPAIGNS);
  const kept = step.level === "campaign" ? rows.slice(0, MAX_CAMPAIGNS) : rows;
  if (kept.length < rows.length) warnings.push(`Plus de ${MAX_CAMPAIGNS} campagnes : seules les ${MAX_CAMPAIGNS} plus dépensières sont gardées.`);
  return done(rowsIn, kept.length, { output: { rows: { columns, rows: kept, truncated } }, warnings, notices });
}

const NO_ACCOUNT = "aucun compte TikTok Ads n'est rattaché au client de la routine";

export const tiktokInsightsHandler: StepHandler<TikTokInsightsStep> = {
  type: "tiktok.insights",
  writes: "none",
  validate,

  async preflight(step, routine) {
    // The accounts of several clients are known at run time only, in the scope of that moment.
    if (step.clients) return [];
    const accounts = await routineTikTokAccounts(routine.dashboardId);
    if (accounts.length === 0) return [{ stepId: step.id, severity: "error", message: NO_ACCOUNT }];
    const issues: PreflightIssue[] = [];
    for (const account of accounts.slice(0, MAX_ADVERTISERS)) {
      const check = await checkAdvertiser(account.id);
      if (!check.ok) issues.push({ stepId: step.id, severity: "error", message: `compte TikTok ${account.id} : ${check.error}` });
    }
    if (accounts.length > MAX_ADVERTISERS) {
      issues.push({ stepId: step.id, severity: "warning", message: `${accounts.length} comptes TikTok rattachés : seuls les ${MAX_ADVERTISERS} premiers sont lus.` });
    }
    return issues;
  },

  async run(step, ctx: StepContext) {
    const rowsIn = ctx.input?.rows.length ?? 0;
    if (step.clients) return runClients(step, ctx, rowsIn);
    let accounts: RoutineTikTokAccount[];
    try {
      accounts = await routineTikTokAccounts(ctx.routine.dashboardId);
    } catch (e) {
      return failed(rowsIn, "infra", `Comptes TikTok du client illisibles : ${errorMessage(e)}`);
    }
    if (accounts.length === 0) return failed(rowsIn, "functional", NO_ACCOUNT);
    const read = accounts.slice(0, MAX_ADVERTISERS);
    const range = windowRange(step.window, ctx.routine.timezone, ctx.now);
    const rows: Row[] = [];
    try {
      for (const a of read) rows.push(...await readAdvertiser(step, a, range));
    } catch (e) {
      const message = errorMessage(e);
      return failed(rowsIn, tiktokErrorClass(message), `TikTok Ads : ${message}`);
    }
    // Campaigns come highest spend first per advertiser; across advertisers too.
    if (step.level === "campaign") rows.sort((x, y) => Number(y.spend ?? 0) - Number(x.spend ?? 0));
    const truncated = step.level === "campaign" && rows.length > MAX_CAMPAIGNS;
    const kept = truncated ? rows.slice(0, MAX_CAMPAIGNS) : rows;
    return done(rowsIn, kept.length, {
      output: { rows: { columns: columnsOf(step), rows: kept, truncated } },
      warnings: [
        ...(accounts.length > MAX_ADVERTISERS ? [`${accounts.length} comptes TikTok rattachés : seuls les ${MAX_ADVERTISERS} premiers sont lus.`] : []),
        ...(truncated ? [`Plus de ${MAX_CAMPAIGNS} campagnes : seules les ${MAX_CAMPAIGNS} plus dépensières sont gardées.`] : []),
        ...(kept.length === 0 ? [`Aucune diffusion TikTok Ads du ${range.since} au ${range.until}.`] : []),
      ],
    });
  },
};
