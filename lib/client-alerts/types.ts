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
 *   evaluate.ts      evaluate, windowOf (where a window ends, which days it holds), definitionHash
 *   backtest.ts      advance (what decides a message), backtest, replayVerdict (what a replay is worth)
 *   run.ts           runClientAlerts
 *   store.ts         database reads and writes of ClientAlert / ClientAlertEvent
 *   slack-dm.ts      dmConfigured, lookupSlackUser, sendSlackDm, slackIdentityOf, resolveSlackIdentity, SlackDmError
 *   message.ts       buildAlertLine, buildDmText, slackToPlain (a stored message as the page shows it)
 *   validate.ts      validateAlertProposal
 *   accounts.ts      usableAccounts (the accounts a proposal may use today), goneClients, unreadText
 *   compose-prompt.ts  prompt, relay body, extraction of the ```alert block
 *
 * Units, once for every file: money in euros; `ctr`, `changePct` and the thresholds of drop_pct /
 * rise_pct are percentages (1.2 = 1,2 %, 50 = half), never ratios; `roas` is a ratio (2.5).
 * Days are YYYY-MM-DD: `ClientSeries.until` is the last full day in Paris, `Evaluation.asOf` the last
 * day of the window judged (never the day in progress), `BacktestTrigger.date` the morning the
 * message would have been received.
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
  /**
   * Below these over the window, the check is skipped (too little data to judge).
   * One exception, cpaSpendFloor below: a CPA « above » with too few conversions (or none)
   * triggers all the same once the spend reaches threshold × max(minConversions, 1).
   */
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

/**
 * CPA « above » only: the spend from which the alert triggers whatever the
 * conversions — threshold × the conversions the guard asks for (one at least).
 * With fewer conversions than the guard (or none at all) and that much spent,
 * the CPA would be over the threshold even with the conversions the guard
 * waits for: 900 € spent without a sale is the very case « CPA > 60 € » is
 * created for, and it must not be skipped for lack of conversions.
 * null for anything else (« below » keeps its guard).
 */
export function cpaSpendFloor(def: Pick<AlertDefinition, "metric" | "condition" | "threshold" | "guards">): number | null {
  if (def.metric !== "cpa" || def.condition !== "above") return null;
  if (typeof def.threshold !== "number" || !Number.isFinite(def.threshold) || def.threshold <= 0) return null;
  const min = def.guards?.minConversions;
  return def.threshold * Math.max(typeof min === "number" && Number.isFinite(min) ? min : 0, 1);
}

/**
 * How far back « the same weekdays » are, in calendar days: whole weeks, as
 * many as it takes to clear the window — one for a window of 1, 3 or 7 days
 * (two for 7 working days), two for 14, five for 30. Only `same_weekdays`
 * reads it; `previous_window` is the N counting days just before the window,
 * and the function answers N for it. One place for the figure, so that the
 * words on the card and in the message say what the engine compares.
 * New definitions may only ask for `same_weekdays` up to 7 days (validate.ts);
 * longer ones already stored keep working through here.
 */
export function compareShiftDays(def: Pick<AlertDefinition, "windowDays" | "compare"> & { weekdaysOnly?: boolean }): number {
  if (def.compare !== "same_weekdays") return def.windowDays;
  return Math.ceil(def.windowDays / (def.weekdaysOnly === true ? 5 : 7)) * 7;
}

/** `stopped` looks at the 7 counting days before its window to know the account was delivering. */
export const STOP_LOOKBACK_DAYS = 7;

/** The measures that depend on conversions: reported late by the platforms, and counted by both. */
export const CONVERSION_METRICS: readonly AlertMetric[] = ["conversions", "cpa", "roas", "revenue"];

/**
 * Days of hindsight before a measure is judged. Meta and Google go on
 * attributing the conversions of a day for a day or more: at six in the
 * morning, yesterday's are not all there, and a CPA or a « no conversion » on
 * yesterday alone would trigger falsely — without the replay, which reads
 * matured figures, ever showing it. Whatever depends on conversions is
 * therefore judged on a window that ends one day earlier.
 */
export function conversionLagDays(metric: AlertMetric): number {
  return CONVERSION_METRICS.includes(metric) ? 1 : 0;
}

// ── Series ───────────────────────────────────────────────────────────────────

/**
 * Days read per account: the 30 days replayed, the longest window and its comparison — 30 working
 * days each, 42 calendar days —, the day of hindsight of the conversions, and a margin.
 */
export const SERIES_DAYS = 125;
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
  /** The day in progress (euros) and the hour (0–23.99) in the account timezone; null when unread. Read by the AI, never judged. */
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

/**
 * Why a check could not judge, as a kind: what tells a passing trouble (an account that could not
 * be read) from a rule that cannot be judged on this client (its guards, its measure, its history).
 */
export type SkipKind = "unreadable" | "guard_spend" | "guard_conversions" | "no_value" | "no_history" | "no_reference" | "definition";

export interface Evaluation {
  /** skipped = not judged (account unreadable, guard not met, not enough days): never a trigger. */
  status: "triggered" | "ok" | "skipped";
  /** Why it was skipped, in French, for the page. */
  reason?: string;
  /** The same, as a kind. Absent from evaluations stored before it existed. */
  skip?: SkipKind;
  /**
   * The real last day of the window judged (YYYY-MM-DD): one day before the last full day for what
   * depends on conversions, a Friday on a Monday morning for working days only.
   */
  asOf: string;
  /** First day of the window. Absent from evaluations stored before it existed. */
  from?: string;
  /**
   * The part that decides: `combined`, or the platform that triggered (first one) when aggregation is `each`.
   * null even when `triggered` for a CPA « above » that spent without any conversion: there is no CPA to give.
   */
  value: number | null;
  baseline: number | null;
  changePct: number | null;
  /** combined: [combined, meta, google] (the platforms as detail). each: one part per platform present. */
  parts: EvaluationPart[];
}

// ── Backtest ─────────────────────────────────────────────────────────────────

/**
 * `date` = the day the message would have been received (YYYY-MM-DD): the morning after the last
 * day of the window, as the cron does. `value` may be null (CPA « above » without any conversion).
 */
export interface BacktestTrigger { date: string; value: number | null; changePct: number | null }

export interface Backtest {
  days: number;
  /** Days on which the condition was true. */
  daysTrue: number;
  /** Messages the consultant would have received, silence and re-arming applied — the figure that matters. */
  messages: BacktestTrigger[];
  /** Days not judged (guards, unreadable data). */
  skippedDays: number;
  /** Days on which a check would have run (30, less the Saturdays and Sundays of a working-days alert). Absent from older replays. */
  checkedDays?: number;
  /** Why most of the skipped days were skipped; null when none was. */
  skipKind?: SkipKind | null;
  /** Value today, and its spread over the replayed days that have one (a day without a value is left out, never counted as 0). */
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

/**
 * What an undelivered event says once its alert went back to normal before the message could leave.
 * It closes the event: kept on the page, never sent late, and no longer what makes its alert due.
 */
export const BACK_TO_NORMAL = "situation revenue à la normale avant l'envoi : non envoyé";
/**
 * What an event says when nobody knows whether its private message arrived (the delivery service
 * answered too late, or the pass died between the send and its record). It closes the event, and its
 * alert starts its silence as if the message had been delivered: it may have been, so it is never sent again.
 */
export const DELIVERY_UNKNOWN = "envoi à l'issue incertaine : le message est peut-être arrivé dans Slack, il n'est pas renvoyé";

export type ClientAlertStatus = "draft" | "active" | "paused" | "review" | "error";

export interface RunSummary {
  slot: number | null;
  /** Alerts evaluated at this pass (those sent to `review` or paused are not). */
  checked: number;
  /**
   * EVENTS this pass has to say — a trigger or a reminder worth a message, new or still pending from
   * an earlier pass — not the alerts whose condition is true: an alert that stays true in its silence
   * is checked, not triggered.
   */
  triggered: number;
  /** Alerts evaluated that could not be judged. */
  skipped: number;
  /**
   * Private messages really sent: one per consultant, whatever the number of events it carries —
   * so `triggered` is not `sent` + `held`.
   */
  sent: number;
  /** Events recorded without sending (CLIENT_ALERTS_SEND off, or explicit dry run). */
  dryRun: boolean;
  /** Events held back on purpose: daily cap, per-run cap, flood guard, no Slack identity, webhook not configured. Tried again at the next pass. */
  held: number;
  /** Events whose private message could not be delivered. Tried again at the next pass. */
  failed: number;
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
  /** The member's name as Slack just answered it — only right after a lookup, never stored. */
  name?: string | null;
}
