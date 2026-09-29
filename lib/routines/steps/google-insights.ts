/**
 * Routines — google.insights: Google Ads figures of the routine's account,
 * per account or per campaign.
 *
 * The GAQL is built here from closed lists (level, window, metrics): no text
 * of the definition, of a Sheet or of an AI ever enters the query. The only
 * variable parts are two dates computed by lib/date-ranges.ts and checked
 * against YYYY-MM-DD. The account is Routine.googleCustomerId, never a field
 * of the step.
 *
 * No filter on campaign.status: a campaign paused yesterday that spent during
 * the window must appear. Campaigns are kept on `metrics.impressions > 0`.
 *
 * Output, one row per account or campaign:
 *   date_start, date_stop the window read (YYYY-MM-DD), same names as meta.insights
 *   spend, cpa            account currency (cost_micros / 1 000 000), 2 decimals
 *   ctr                   percentage (2.35 = 2,35 %)
 *   roas                  conversion value / spend
 *   cpa, roas, ctr        null when the divisor is 0
 * Windows are full days ending yesterday, in the routine's timezone
 * (month_to_date: from the 1st to yesterday).
 */

import { lastFullDays, monthToDate, YMD_RE, type DateRange } from "@/lib/date-ranges";
import { costFrom, extractRows } from "@/lib/dashboard-widgets";
import { relayDirectTool } from "@/lib/relay-tool";
import { type Checked, done, errorMessage, failed, readStepBase, refuse, unverified } from "@/lib/routines/steps/sheet-read";
import type { Cell, ErrorClass, GoogleInsightsStep, Row, StepContext, StepHandler } from "@/lib/routines/types";

export const GOOGLE_LEVELS = ["account", "campaign"] as const;
export const GOOGLE_WINDOWS = ["yesterday", "7d", "14d", "30d", "month_to_date"] as const;
export const GOOGLE_METRICS = ["spend", "impressions", "clicks", "ctr", "conversions", "cpa", "roas"] as const;
type Level = (typeof GOOGLE_LEVELS)[number];
type Window = (typeof GOOGLE_WINDOWS)[number];
type Metric = (typeof GOOGLE_METRICS)[number];

export const GAQL_TOOL = "mcp-google-ads.Custom_GAQL_Query";
export const MAX_CAMPAIGNS = 500;

const WINDOW_DAYS: Record<Exclude<Window, "month_to_date">, number> = { yesterday: 1, "7d": 7, "14d": 14, "30d": 30 };

// Fields each metric needs. cost_micros and impressions are always selected:
// they carry the sort and the "has delivered" filter.
const METRIC_FIELDS: Record<Metric, readonly string[]> = {
  spend: ["metrics.cost_micros"],
  impressions: ["metrics.impressions"],
  clicks: ["metrics.clicks"],
  ctr: ["metrics.clicks", "metrics.impressions"],
  conversions: ["metrics.conversions"],
  cpa: ["metrics.cost_micros", "metrics.conversions"],
  roas: ["metrics.conversions_value", "metrics.cost_micros"],
};
const FIELD_ORDER = ["metrics.cost_micros", "metrics.impressions", "metrics.clicks", "metrics.conversions", "metrics.conversions_value"] as const;

const IDENTITY: Record<Level, { fields: readonly string[]; columns: readonly string[]; from: string }> = {
  account: { fields: ["customer.id", "customer.descriptive_name", "customer.currency_code"], columns: ["account_id", "account_name", "currency"], from: "customer" },
  campaign: { fields: ["campaign.id", "campaign.name", "campaign.status", "customer.currency_code"], columns: ["campaign_id", "campaign_name", "campaign_status", "currency"], from: "campaign" },
};

export function windowRange(window: Window, timezone: string, now: Date): DateRange {
  const opts = { tz: timezone, now };
  return window === "month_to_date" ? monthToDate(opts) : lastFullDays(WINDOW_DAYS[window], opts);
}

/** The whole query, from closed lists and two checked dates. */
export function buildGaql(level: Level, metrics: readonly Metric[], range: DateRange): string {
  if (!GOOGLE_LEVELS.includes(level)) throw new Error("niveau inconnu");
  if (!YMD_RE.test(range.since) || !YMD_RE.test(range.until)) throw new Error("dates invalides");
  const wanted = new Set<string>(["metrics.cost_micros", "metrics.impressions"]);
  for (const m of metrics) {
    if (!GOOGLE_METRICS.includes(m)) throw new Error("métrique inconnue");
    METRIC_FIELDS[m].forEach((f) => wanted.add(f));
  }
  const id = IDENTITY[level];
  const select = [...id.fields, ...FIELD_ORDER.filter((f) => wanted.has(f))].join(", ");
  const dates = `segments.date BETWEEN '${range.since}' AND '${range.until}'`;
  return level === "campaign"
    ? `SELECT ${select} FROM campaign WHERE ${dates} AND metrics.impressions > 0 ORDER BY metrics.cost_micros DESC LIMIT ${MAX_CAMPAIGNS}`
    : `SELECT ${select} FROM customer WHERE ${dates}`;
}

/** "123-456-7890" or "1234567890" → digits; null when it is not a customer id. */
export function cleanCustomerId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.trim().replace(/-/g, "");
  return /^\d{8,12}$/.test(digits) ? digits : null;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const text = (v: unknown): Cell => (v === undefined || v === null || v === "" ? null : String(v));

/** Columns that carry the window, named as meta.insights names them. */
export const DATE_COLUMNS = ["date_start", "date_stop"] as const;

/** One GAQL row (camelCase or snake_case) → one row of the step, micros converted. */
export function toInsightRow(raw: Record<string, unknown>, level: Level, metrics: readonly Metric[], range?: DateRange): Row {
  const m = obj(raw.metrics);
  const customer = obj(raw.customer);
  const campaign = obj(raw.campaign);
  const spend = costFrom(m);
  const impressions = num(m.impressions);
  const clicks = num(m.clicks);
  const conversions = num(m.conversions);
  const value = num(m.conversionsValue ?? m.conversions_value);
  const computed: Record<Metric, Cell> = {
    spend: round(spend),
    impressions,
    clicks,
    ctr: impressions > 0 ? round((clicks / impressions) * 100) : null,
    conversions: round(conversions),
    cpa: conversions > 0 ? round(spend / conversions) : null,
    roas: spend > 0 ? round(value / spend) : null,
  };
  const currency = text(customer.currencyCode ?? customer.currency_code);
  const row: Row = level === "campaign"
    ? { campaign_id: text(campaign.id), campaign_name: text(campaign.name), campaign_status: text(campaign.status), currency }
    : { account_id: text(customer.id), account_name: text(customer.descriptiveName ?? customer.descriptive_name), currency };
  if (range) { row.date_start = range.since; row.date_stop = range.until; }
  for (const metric of metrics) row[metric] = computed[metric];
  return row;
}

// What Google answers when the account itself is the problem: a new attempt changes nothing.
const ACCOUNT_ERRORS = /PERMISSION_DENIED|CUSTOMER_NOT_FOUND|CUSTOMER_NOT_ENABLED|INVALID_CUSTOMER_ID|NOT_ADS_USER|caller does not have permission/i;
export const googleErrorClass = (message: string): ErrorClass => (ACCOUNT_ERRORS.test(message) ? "functional" : "infra");

async function query(customerId: string, gaql: string): Promise<Array<Record<string, unknown>>> {
  return extractRows(await relayDirectTool(GAQL_TOOL, { input: JSON.stringify({ customer_id: customerId, gaql_query: gaql }) }, 25_000));
}

function validate(raw: unknown): Checked<GoogleInsightsStep> {
  // No account field: a customer id written in a step is refused as an unknown key.
  const head = readStepBase(raw, "google.insights", ["level", "window", "metrics"]);
  if (!head.ok) return head;
  const { level, window, metrics } = head.raw;
  if (!GOOGLE_LEVELS.includes(level as Level)) return refuse(`level attendu : ${GOOGLE_LEVELS.join(" ou ")}`);
  if (!GOOGLE_WINDOWS.includes(window as Window)) return refuse(`window attendu : ${GOOGLE_WINDOWS.join(", ")}`);
  if (!Array.isArray(metrics) || metrics.length === 0) return refuse("metrics : au moins une métrique");
  const kept: Metric[] = [];
  for (const m of metrics) {
    if (!GOOGLE_METRICS.includes(m as Metric)) return refuse(`métrique inconnue : ${String(m).slice(0, 40)} (acceptées : ${GOOGLE_METRICS.join(", ")})`);
    if (!kept.includes(m as Metric)) kept.push(m as Metric);
  }
  return { ok: true, step: { ...head.base, type: "google.insights", level: level as Level, window: window as Window, metrics: kept } };
}

const NO_ACCOUNT = "aucun compte Google Ads n'est rattaché à la routine";

export const googleInsightsHandler: StepHandler<GoogleInsightsStep> = {
  type: "google.insights",
  writes: "none",
  validate,

  async preflight(step, routine) {
    const customerId = cleanCustomerId(routine.googleCustomerId);
    if (!customerId) return [{ stepId: step.id, severity: "error", message: NO_ACCOUNT }];
    try {
      await query(customerId, "SELECT customer.id FROM customer LIMIT 1");
      return [];
    } catch (e) {
      const message = errorMessage(e);
      if (googleErrorClass(message) === "functional") return [{ stepId: step.id, severity: "error", message: `compte Google Ads ${customerId} inaccessible : ${message}` }];
      return [unverified(step.id, `compte Google Ads ${customerId}`, e)];
    }
  },

  async run(step, ctx: StepContext) {
    const rowsIn = ctx.input?.rows.length ?? 0;
    const customerId = cleanCustomerId(ctx.routine.googleCustomerId);
    if (!customerId) return failed(rowsIn, "functional", NO_ACCOUNT);
    try {
      const range = windowRange(step.window, ctx.routine.timezone, ctx.now);
      const raw = await query(customerId, buildGaql(step.level, step.metrics, range));
      const rows = raw.map((r) => toInsightRow(r, step.level, step.metrics, range));
      const truncated = step.level === "campaign" && raw.length >= MAX_CAMPAIGNS;
      const columns = [...IDENTITY[step.level].columns, ...DATE_COLUMNS, ...step.metrics];
      return done(rowsIn, rows.length, {
        output: { rows: { columns, rows, truncated } },
        warnings: [
          ...(truncated ? [`Plus de ${MAX_CAMPAIGNS} campagnes : seules les ${MAX_CAMPAIGNS} plus dépensières sont lues.`] : []),
          ...(rows.length === 0 ? [`Aucune diffusion Google Ads du ${range.since} au ${range.until}.`] : []),
        ],
      });
    } catch (e) {
      const message = errorMessage(e);
      return failed(rowsIn, googleErrorClass(message), `Google Ads : ${message}`);
    }
  },
};
