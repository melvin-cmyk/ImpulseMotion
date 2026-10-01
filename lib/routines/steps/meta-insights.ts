/**
 * Routines — step meta.insights: one row per account, campaign, ad set or ad,
 * over a closed window, read through lib/meta-api.ts. Read only.
 *
 * Numbers follow the rest of the application:
 *   - windows are full days ending yesterday, in the account timezone
 *     (lib/date-ranges.ts); month_to_date stops yesterday too;
 *   - conversions = the conversion event configured for the account
 *     (AccountSetting.conversionEvent, purchase by default) — purchasesFor;
 *   - cpa = computeCpa; roas = computeRevenue / spend, empty when the revenue
 *     is unknown (no tracked value and no AOV configured), never an invented 0.
 * Meta has no ad-set fetcher in lib/meta-api.ts: the ad-set level is the sum of
 * the ad-level rows, ratios recomputed on the sums.
 *
 * Every list is read to its end (cursor paging in lib/meta-api.ts); a list cut
 * by the hard cap comes out with `truncated: true` and a warning.
 *
 * With `clients` the step reads the Meta accounts of several clients instead
 * of the routine's (lib/routines/clients.ts decides which, at every run, from
 * the scope of who answers for it). Every row then starts with client_name,
 * platform, account_id and account_name; an account that cannot be read is
 * said and the others are kept.
 */

import {
  computeCpa, computeRevenue, getAccountInsights, getAccountProfile, getAdInsightsPaged, getCampaignInsightsPaged,
  getMetaSystemToken, purchasesFor,
} from "@/lib/meta-api";
import { isMetaApiError } from "@/lib/meta-errors";
import { lastFullDays, monthToDate, yesterdayIn, type DateRange } from "@/lib/date-ranges";
import { prisma } from "@/lib/prisma";
import { cleanMetaMessage } from "@/lib/meta-write";
import { readClientSelection } from "@/lib/routines/client-selection";
import { clientCells, readEachAccount, resolveClientAccounts, withClientColumns, type ClientAccount } from "@/lib/routines/clients";
import { type Cell, type ErrorClass, type MetaInsightsStep, type PreflightIssue, type Row, type StepContext, type StepHandler, type StepRunOutcome } from "@/lib/routines/types";

const LEVELS = ["account", "campaign", "adset", "ad"] as const;
const WINDOWS = ["yesterday", "7d", "14d", "30d", "month_to_date"] as const;
const METRICS = ["spend", "impressions", "clicks", "ctr", "cpm", "conversions", "cpa", "roas"] as const;
const STEP_KEYS = ["id", "type", "label", "input", "level", "window", "metrics", "nameContains", "clients"];
const STEP_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const MAX_NAME_FILTER_CHARS = 120;

type Level = MetaInsightsStep["level"];
type Metric = MetaInsightsStep["metrics"][number];
type Actions = Array<{ action_type: string; value: string }>;

/** What the computations need from an insight row, whatever its level. */
interface RawRow {
  spend?: string; impressions?: string; clicks?: string;
  actions?: Actions; action_values?: Actions; purchase_roas?: Actions; cost_per_action_type?: Actions;
  campaign_id?: string; campaign_name?: string;
  adset_id?: string; adset_name?: string;
  ad_id?: string; ad_name?: string;
}

interface Totals {
  ids: Record<string, Cell>;
  spend: number; impressions: number; clicks: number; conversions: number;
  /** null = unknown for at least one row that spent. */
  revenue: number | null;
  /** Meta's own cost per conversion, kept for a row that is not a sum. */
  cpa: number | null;
}

interface Settings { aov: number | null; conversionEvent: string; timezone: string | null; currency: string | null }

const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? ""))) || 0;
const round2 = (n: number) => Math.round(n * 100) / 100;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function windowRange(window: MetaInsightsStep["window"], tz: string | null, now: Date): DateRange {
  const opts = { tz, now };
  switch (window) {
    case "yesterday": { const day = yesterdayIn(opts); return { since: day, until: day }; }
    case "7d": return lastFullDays(7, opts);
    case "14d": return lastFullDays(14, opts);
    case "30d": return lastFullDays(30, opts);
    case "month_to_date": return monthToDate(opts);
  }
}

/** Read only: the shared helper of lib/account-settings.ts refreshes the row, a routine must not. */
async function readSettings(accountId: string): Promise<{ settings: Settings; warning?: string }> {
  const id = accountId.replace(/^act_/, "");
  try {
    const row = await prisma.accountSetting.findFirst({
      where: { platform: "meta", OR: [{ accountId: id }, { accountId: `act_${id}` }] },
      select: { aov: true, currency: true, timezone: true, conversionEvent: true },
    });
    return {
      settings: {
        aov: row?.aov && row.aov > 0 ? row.aov : null,
        conversionEvent: (row?.conversionEvent ?? "").trim() || "purchase",
        timezone: row?.timezone ?? null,
        currency: row?.currency ?? null,
      },
    };
  } catch {
    return {
      settings: { aov: null, conversionEvent: "purchase", timezone: null, currency: null },
      warning: "Réglages du compte illisibles : conversions comptées en achats, fuseau de la routine.",
    };
  }
}

function totalsOf(row: RawRow, ids: Record<string, Cell>, settings: Settings): Totals {
  const spend = num(row.spend);
  const insight = { ...row, spend: String(spend) };
  const revenue = computeRevenue(insight, settings.aov, settings.conversionEvent);
  const cpa = computeCpa(insight, settings.conversionEvent);
  return {
    ids,
    spend,
    impressions: num(row.impressions),
    clicks: num(row.clicks),
    conversions: purchasesFor(insight, settings.conversionEvent),
    revenue: revenue.unavailable ? null : revenue.revenue,
    cpa: cpa > 0 ? cpa : null,
  };
}

/** Ad rows → one line per ad set. A revenue unknown on an ad that spent makes the sum unknown. */
export function sumByAdset(rows: Totals[]): Totals[] {
  const byId = new Map<string, Totals>();
  for (const r of rows) {
    const key = String(r.ids.adset_id ?? "");
    const sum = byId.get(key);
    if (!sum) {
      const { ad_id: _adId, ad_name: _adName, ...ids } = r.ids;
      void _adId; void _adName;
      byId.set(key, { ...r, ids, cpa: null, revenue: r.revenue === null && r.spend > 0 ? null : r.revenue ?? 0 });
      continue;
    }
    sum.spend += r.spend;
    sum.impressions += r.impressions;
    sum.clicks += r.clicks;
    sum.conversions += r.conversions;
    if (r.revenue === null) { if (r.spend > 0) sum.revenue = null; }
    else if (sum.revenue !== null) sum.revenue += r.revenue;
  }
  return [...byId.values()];
}

function metricValue(t: Totals, metric: Metric): Cell {
  switch (metric) {
    case "spend": return round2(t.spend);
    case "impressions": return Math.round(t.impressions);
    case "clicks": return Math.round(t.clicks);
    case "ctr": return t.impressions > 0 ? round2((t.clicks / t.impressions) * 100) : 0;
    case "cpm": return t.impressions > 0 ? round2((t.spend / t.impressions) * 1000) : 0;
    case "conversions": return round2(t.conversions);
    case "cpa": return t.cpa ?? (t.conversions > 0 && t.spend > 0 ? round2(t.spend / t.conversions) : 0);
    case "roas": return t.revenue === null ? null : t.spend > 0 ? round2(t.revenue / t.spend) : 0;
  }
}

const NAME_COLUMN: Record<Exclude<Level, "account">, string> = { campaign: "campaign_name", adset: "adset_name", ad: "ad_name" };
const ID_COLUMNS: Record<Level, string[]> = {
  account: ["account_id"],
  campaign: ["campaign_id", "campaign_name"],
  adset: ["campaign_id", "campaign_name", "adset_id", "adset_name"],
  ad: ["campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name"],
};

function failure(message: string, errorClass: ErrorClass, warnings: string[] = []): StepRunOutcome {
  return {
    status: "failed", rowsIn: 0, rowsOut: 0, output: {}, planned: [], written: [], warnings,
    error: { class: errorClass, message: cleanMetaMessage(message) },
  };
}

/** A wrong id or a missing right is the routine's fault; quota, token and network are not. */
function classOf(err: unknown): ErrorClass {
  return isMetaApiError(err) && (err.kind === "invalid" || err.kind === "permission") ? "functional" : "infra";
}

export const metaInsightsHandler: StepHandler<MetaInsightsStep> = {
  type: "meta.insights",
  writes: "none",

  validate(step) {
    if (!isRecord(step)) return { ok: false, error: "meta.insights : étape invalide" };
    const unknown = Object.keys(step).filter((k) => !STEP_KEYS.includes(k));
    if (unknown.length) return { ok: false, error: `meta.insights : champ inconnu « ${unknown[0]} »` };
    if (step.type !== "meta.insights") return { ok: false, error: "meta.insights : type inattendu" };
    if (typeof step.id !== "string" || !STEP_ID_RE.test(step.id)) return { ok: false, error: "meta.insights : identifiant d'étape invalide" };
    const level = LEVELS.find((l) => l === step.level);
    if (!level) return { ok: false, error: `meta.insights : niveau inconnu (${LEVELS.join(", ")})` };
    const window = WINDOWS.find((w) => w === step.window);
    if (!window) return { ok: false, error: `meta.insights : période inconnue (${WINDOWS.join(", ")})` };
    if (!Array.isArray(step.metrics) || step.metrics.length === 0) return { ok: false, error: "meta.insights : au moins une métrique est requise" };
    const metrics: Metric[] = [];
    for (const m of step.metrics) {
      const metric = METRICS.find((k) => k === m);
      if (!metric) return { ok: false, error: `meta.insights : métrique inconnue « ${String(m).slice(0, 40)} » (${METRICS.join(", ")})` };
      if (metrics.includes(metric)) return { ok: false, error: `meta.insights : métrique « ${metric} » citée deux fois` };
      metrics.push(metric);
    }
    const out: MetaInsightsStep = { id: step.id, type: "meta.insights", level, window, metrics };
    for (const key of ["label", "input"] as const) {
      const v = step[key];
      if (v === undefined) continue;
      if (typeof v !== "string" || v.length > 120) return { ok: false, error: `meta.insights : « ${key} » invalide` };
      out[key] = v;
    }
    if (step.nameContains !== undefined) {
      const v = step.nameContains;
      if (typeof v !== "string" || !v.trim() || v.length > MAX_NAME_FILTER_CHARS) return { ok: false, error: "meta.insights : « nameContains » invalide" };
      if (level === "account") return { ok: false, error: "meta.insights : « nameContains » n'a pas de sens au niveau du compte" };
      out.nameContains = v.trim();
    }
    if (step.clients !== undefined) {
      const clients = readClientSelection(step.clients);
      if (!clients.ok) return { ok: false, error: `meta.insights : ${clients.error}` };
      out.clients = clients.value;
    }
    return { ok: true, step: out };
  },

  async preflight(step, routine) {
    const issues: PreflightIssue[] = [];
    // The accounts of several clients are known at run time only, in the scope of that moment.
    if (step.clients) return issues;
    if (!routine.metaAccountId) {
      issues.push({ stepId: step.id, severity: "error", message: "Aucun compte Meta n'est rattaché à la routine." });
      return issues;
    }
    try {
      await getAccountProfile(getMetaSystemToken(), routine.metaAccountId);
    } catch (err) {
      const severity = classOf(err) === "functional" ? "error" : "warning";
      issues.push({ stepId: step.id, severity, message: cleanMetaMessage(`Compte Meta illisible : ${err instanceof Error ? err.message : String(err)}`) });
    }
    return issues;
  },

  async run(step, ctx) {
    if (step.clients) return runClients(step, ctx);
    const accountId = ctx.routine.metaAccountId;
    if (!accountId) return failure("Aucun compte Meta n'est rattaché à la routine.", "functional");
    const read = await readAccount(step, accountId, ctx);
    if (!read.ok) return failure(read.message, read.errorClass, read.warnings);
    return {
      status: "ok", rowsIn: 0, rowsOut: read.rows.length,
      output: { rows: { columns: read.columns, rows: read.rows, truncated: read.truncated } },
      planned: [], written: [], warnings: read.warnings,
    };
  },
};

type AccountRead =
  | { ok: true; columns: string[]; rows: Row[]; truncated: boolean; warnings: string[] }
  | { ok: false; message: string; errorClass: ErrorClass; warnings: string[] };

/** The rows of one account, as the step asks for them. Never throws. */
async function readAccount(step: MetaInsightsStep, accountId: string, ctx: Pick<StepContext, "routine" | "now">): Promise<AccountRead> {
  const warnings: string[] = [];
  const { settings, warning } = await readSettings(accountId);
  if (warning) warnings.push(warning);
  const range = windowRange(step.window, settings.timezone ?? ctx.routine.timezone, ctx.now);

  let totals: Totals[];
  let truncated = false;
  try {
    const token = getMetaSystemToken();
    if (step.level === "account") {
      const row = await getAccountInsights(token, accountId, range);
      totals = [totalsOf(row, { account_id: row.account_id }, settings)];
      if (row.currency) settings.currency = row.currency;
    } else if (step.level === "campaign") {
      const res = await getCampaignInsightsPaged(token, accountId, range);
      truncated = res.truncated;
      totals = res.data.map((r) => totalsOf(r, { campaign_id: r.campaign_id ?? "", campaign_name: r.campaign_name ?? "" }, settings));
      settings.currency = res.data.find((r) => r.currency)?.currency ?? settings.currency;
    } else {
      const res = await getAdInsightsPaged(token, accountId, range);
      truncated = res.truncated;
      const ads = res.data.map((r) => totalsOf(r, {
        campaign_id: r.campaign_id ?? "", campaign_name: r.campaign_name ?? "",
        adset_id: r.adset_id ?? "", adset_name: r.adset_name ?? "",
        ad_id: r.ad_id ?? "", ad_name: r.ad_name ?? "",
      }, settings));
      totals = step.level === "ad" ? ads : sumByAdset(ads);
      settings.currency = res.data.find((r) => r.account_currency)?.account_currency ?? settings.currency;
    }
  } catch (err) {
    return { ok: false, message: `Lecture Meta impossible : ${err instanceof Error ? err.message : String(err)}`, errorClass: classOf(err), warnings };
  }
  if (truncated) warnings.push("Liste tronquée par Meta ou par le plafond de lecture : la série est incomplète.");

  if (step.level !== "account" && step.nameContains) {
    const needle = step.nameContains.toLowerCase();
    const column = NAME_COLUMN[step.level];
    totals = totals.filter((t) => String(t.ids[column] ?? "").toLowerCase().includes(needle));
  }
  if (step.metrics.includes("roas") && totals.some((t) => t.revenue === null)) {
    warnings.push("ROAS vide sur certaines lignes : aucune valeur d'achat suivie et aucun panier moyen configuré pour le compte.");
  }

  const columns = baseColumns(step);
  const rows: Row[] = totals.map((t) => {
    const row: Row = {};
    for (const c of ID_COLUMNS[step.level]) row[c] = t.ids[c] ?? "";
    row.date_start = range.since;
    row.date_stop = range.until;
    row.currency = settings.currency ?? null;
    for (const m of step.metrics) row[m] = metricValue(t, m);
    return row;
  });
  return { ok: true, columns, rows, truncated, warnings };
}

/** The accounts of several clients, one after the other: one that fails is said, the others are kept. */
async function runClients(step: MetaInsightsStep, ctx: StepContext): Promise<StepRunOutcome> {
  if (!ctx.accounts) return failure("Périmètre de lecture inconnu : aucun compte client n'est lu.", "functional");
  const { accounts, warnings } = await resolveClientAccounts(step.clients!, "meta", ctx.accounts);
  if (!accounts.length) {
    if (ctx.accounts.problem) return failure(ctx.accounts.problem, "functional", warnings);
    return { status: "ok", rowsIn: 0, rowsOut: 0, output: { rows: { columns: withClientColumns(baseColumns(step)), rows: [], truncated: false } }, planned: [], written: [], warnings };
  }
  const { results, unread } = await readEachAccount(accounts, (a) => readAccount(step, a.accountId, ctx), { deadlineAt: ctx.deadlineAt, signal: ctx.signal });
  const rows: Row[] = [];
  let truncated = unread > 0;
  const failures: Array<{ account: ClientAccount; message: string; errorClass: ErrorClass }> = [];
  for (const { account, result } of results) {
    if (!result.ok) { failures.push({ account, message: result.message, errorClass: result.errorClass }); continue; }
    truncated ||= result.truncated;
    for (const w of result.warnings) warnings.push(`${account.clientName} : ${w}`);
    for (const row of result.rows) rows.push({ ...row, ...clientCells(account) });
  }
  for (const f of failures.slice(0, 10)) warnings.push(cleanMetaMessage(`${f.account.clientName} (Meta ${f.account.accountId}) non lu : ${f.message}`));
  if (failures.length > 10) warnings.push(`${failures.length - 10} autres comptes Meta non lus.`);
  if (unread) warnings.push(`Temps écoulé : ${unread} compte${unread > 1 ? "s" : ""} Meta non lu${unread > 1 ? "s" : ""}.`);
  if (failures.length && failures.length === results.length) {
    // Nothing could be read: the step fails, functional only when every account said so.
    const errorClass = failures.every((f) => f.errorClass === "functional") ? "functional" : "infra";
    return failure(`Aucun compte Meta lu : ${failures[0].message}`, errorClass, warnings);
  }
  return {
    status: "ok", rowsIn: 0, rowsOut: rows.length,
    output: { rows: { columns: withClientColumns(baseColumns(step)), rows, truncated } },
    planned: [], written: [], warnings,
  };
}

const baseColumns = (step: MetaInsightsStep) => [...ID_COLUMNS[step.level], "date_start", "date_stop", "currency", ...step.metrics];
