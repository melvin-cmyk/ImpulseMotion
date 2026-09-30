/**
 * Client alerts — shared contracts.
 *
 * A consultant picks a client and tells an AI what to be warned about. The AI
 * answers with a proposal (an ```alert block); the server validates it, replays
 * it over the last 30 days with the very code the cron runs, and the consultant
 * validates. One alert covers the Meta AND Google Ads accounts of the client,
 * added up in euros, and is delivered as a private Slack message to the person
 * who created it.
 *
 * The AI translates the request, the code computes: nothing here is judged by
 * a model at check time, so every alert can be measured before it is switched on.
 *
 * Files and what they export (nothing else is shared between them):
 *   series.ts        readClientSeries, summarizeSeries
 *   evaluate.ts      evaluate, definitionHash
 *   backtest.ts      backtest
 *   run.ts           runClientAlerts
 *   store.ts         database reads and writes of ClientAlert / ClientAlertEvent
 *   slack-dm.ts      dmConfigured, lookupSlackUser, sendSlackDm, slackIdentityOf, resolveSlackIdentity
 *   message.ts       buildAlertLine, buildDmText
 *   validate.ts      validateAlertProposal
 *   compose-prompt.ts  prompt, relay body, extraction of the ```alert block
 */

export type AlertPlatform = "meta" | "google";

/** Same shape as AlertAccount of lib/auto-alerts/clients.ts (AlertClient.accountsJson). */
export interface AlertAccountRef {
  platform: AlertPlatform;
  accountId: string;
  name: string;
  currency: string | null;
}

// ── Definition ───────────────────────────────────────────────────────────────

export const ALERT_METRICS = ["spend", "conversions", "cpa", "roas", "revenue", "ctr"] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

/**
 * above / below   the value over the window crosses the threshold
 * drop_pct / rise_pct   the value moved by at least `threshold` % against `compare`
 * stopped         nothing at all (spend or conversions only) while the days before had some
 */
export const ALERT_CONDITIONS = ["above", "below", "drop_pct", "rise_pct", "stopped"] as const;
export type AlertCondition = (typeof ALERT_CONDITIONS)[number];

export const ALERT_WINDOWS = [1, 3, 7, 14, 30] as const;
export type AlertWindow = (typeof ALERT_WINDOWS)[number];

/** combined = Meta + Google added up; each = every platform judged on its own, one is enough to trigger. */
export type AlertAggregation = "combined" | "each";
/** previous_window = the N days before the window; same_weekdays = the same days one week earlier. */
export type AlertCompare = "previous_window" | "same_weekdays";
/** Checks per day, on the slots of the cron (CHECK_SLOTS_UTC). */
export type AlertChecks = "1x" | "2x" | "4x";

export const ALERT_DEFAULTS = {
  aggregation: "combined" as AlertAggregation,
  compare: "previous_window" as AlertCompare,
  checks: "2x" as AlertChecks,
  weekdaysOnly: false,
  /** Silence after a message. The owner's default: three days. */
  cooldownHours: 72,
  /** No reminder: after a message, the next one waits for the situation to go back to normal. */
  remind: false,
} as const;

export const COOLDOWN_MIN_HOURS = 12;
export const COOLDOWN_MAX_HOURS = 24 * 14;
export const LABEL_MAX = 120;
export const EXPLANATION_MAX = 600;

/** What is stored in ClientAlert.definitionJson. Money is always in euros. */
export interface AlertDefinition {
  version: 1;
  label: string;
  /** Frozen at validation: a later regrouping of the client never changes an alert silently. */
  accounts: AlertAccountRef[];
  metric: AlertMetric;
  aggregation: AlertAggregation;
  condition: AlertCondition;
  /** Euros, a count, a ratio (roas), or a percentage (ctr, drop_pct, rise_pct). null for `stopped`. */
  threshold: number | null;
  windowDays: AlertWindow;
  /** Read only by drop_pct and rise_pct. */
  compare: AlertCompare;
  /** Below these over the window, the check is skipped (too little data to judge). */
  guards: { minSpend?: number; minConversions?: number };
  checks: AlertChecks;
  weekdaysOnly: boolean;
  cooldownHours: number;
  /** true = while the condition stays true, a new message after every cooldown. */
  remind: boolean;
  /** How the AI read the request, and its limits — shown on the card. */
  explanation: string;
}

/** What the AI writes in its ```alert block: accounts by id only, optional fields left to the defaults. */
export type AlertProposalInput = Partial<Omit<AlertDefinition, "accounts">> & {
  accounts?: Array<{ platform?: string; accountId?: string }>;
};

/** Lenient read of ClientAlert.definitionJson: null for a draft ("{}") or anything that is not a definition. */
export function readDefinition(json: string | null | undefined): AlertDefinition | null {
  try {
    const d = JSON.parse(json || "{}") as Partial<AlertDefinition> | null;
    if (!d || typeof d !== "object" || d.version !== 1) return null;
    if (!Array.isArray(d.accounts) || !d.accounts.length) return null;
    if (!ALERT_METRICS.includes(d.metric as AlertMetric) || !ALERT_CONDITIONS.includes(d.condition as AlertCondition)) return null;
    if (!ALERT_WINDOWS.includes(d.windowDays as AlertWindow)) return null;
    return d as AlertDefinition;
  } catch {
    return null;
  }
}

// ── Series ───────────────────────────────────────────────────────────────────

/** Days read per account: 30 days replayed × the longest window (30) and its comparison (30), plus a margin. */
export const SERIES_DAYS = 95;
export const BACKTEST_DAYS = 30;

export interface SeriesPoint {
  /** YYYY-MM-DD in the account timezone. */
  date: string;
  /** Euros. */
  spend: number;
  conversions: number;
  /** Euros; null when the account tracks no conversion value. */
  revenue: number | null;
  clicks: number;
  impressions: number;
}

export interface AccountSeries {
  account: AlertAccountRef;
  /** Currency of the account, and the euro value of one unit used for the conversion. */
  currency: string;
  eurRate: number;
  /** Full days, oldest first, ending yesterday, without gaps. Empty when `error` is set. */
  days: SeriesPoint[];
  /** The day in progress (euros) and the hour (0–23.99) in the account timezone; null when unread. */
  today: { spend: number; conversions: number; hour: number } | null;
  /** The account could not be read: whatever depends on it is skipped, never triggered. */
  error?: string;
}

export interface ClientSeries {
  /** ISO instant of the read. */
  readAt: string;
  /**
   * Last full day (YYYY-MM-DD), Europe/Paris. An account further west may not have finished it yet:
   * the default day of a check is lastFullDay() of evaluate.ts, at most one day earlier.
   */
  until: string;
  accounts: AccountSeries[];
}

// ── Evaluation ───────────────────────────────────────────────────────────────

export type EvaluationScope = "combined" | AlertPlatform;

export interface EvaluationPart {
  scope: EvaluationScope;
  /** Value of the metric over the window; null when it cannot be computed (no conversion, no value tracked…). */
  value: number | null;
  /** Value over the comparison window (drop_pct, rise_pct, stopped); null otherwise. */
  baseline: number | null;
  changePct: number | null;
  spend: number;
  conversions: number;
  triggered: boolean;
}

export interface Evaluation {
  /** skipped = not judged (account unreadable, guard not met, not enough days): never a trigger. */
  status: "triggered" | "ok" | "skipped";
  /** Why it was skipped, in French, for the page. */
  reason?: string;
  /** Last day of the window (YYYY-MM-DD). */
  asOf: string;
  /** The part that decides: `combined`, or the platform that triggered (first one) when aggregation is `each`. */
  value: number | null;
  baseline: number | null;
  changePct: number | null;
  /** combined: [combined, meta, google] (the platforms as detail). each: one part per platform present. */
  parts: EvaluationPart[];
}

// ── Backtest ─────────────────────────────────────────────────────────────────

export interface BacktestTrigger { date: string; value: number | null; changePct: number | null }

export interface Backtest {
  days: number;
  /** Days on which the condition was true. */
  daysTrue: number;
  /** Messages the consultant would have received, silence and re-arming applied — the figure that matters. */
  messages: BacktestTrigger[];
  /** Days not judged (guards, unreadable data). */
  skippedDays: number;
  /** Value today, and its spread over the replayed days. */
  current: number | null;
  min: number | null;
  median: number | null;
  max: number | null;
  /** French sentences for the card: limits of the measure, accounts that could not be read… */
  notes: string[];
  /** Hash of the definition that was replayed (definitionHash). */
  hash: string;
  ranAt: string;
}

/** Above this many messages in 30 days, activation asks for an explicit confirmation. */
export const NOISY_MESSAGES = 8;

// ── Run ──────────────────────────────────────────────────────────────────────

/** UTC hours of the cron in vercel.json — one entry per hour, the plan refuses several hours in one entry. */
export const CHECK_SLOTS_UTC = [6, 9, 12, 15] as const;
/** Private messages per consultant and per day; what exceeds stays in the page, unsent. */
export const MAX_DM_PER_USER_PER_DAY = 5;
/** Private messages per run, all consultants together. */
export const MAX_DM_PER_RUN = 10;
/** Delivery failures in a row that put an alert in `error`. */
export const MAX_DELIVERY_FAILURES = 3;

export type ClientAlertStatus = "draft" | "active" | "paused" | "review" | "error";

export interface RunSummary {
  slot: number | null;
  checked: number;
  triggered: number;
  skipped: number;
  /** Private messages really sent. */
  sent: number;
  /** Events recorded without sending (CLIENT_ALERTS_SEND off, or explicit dry run). */
  dryRun: boolean;
  /** Events held back: daily cap, flood guard, no Slack identity. */
  held: number;
  errors: string[];
}

/** Real sending only when CLIENT_ALERTS_SEND is "1" / "true" / "on"; anything else records without sending. */
export function sendingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ["1", "true", "on"].includes((env.CLIENT_ALERTS_SEND ?? "").trim().toLowerCase());
}

// ── Slack identity ───────────────────────────────────────────────────────────

export interface SlackIdentity {
  /** Address looked up in Slack: User.slackEmail, else User.email. */
  email: string | null;
  /** Slack member id (U… / W…) once found. */
  slackUserId: string | null;
  checkedAt: string | null;
  /** found = messages can be sent; unknown = Slack has nobody with this address; unchecked = never looked up. */
  status: "found" | "unknown" | "unchecked";
}
