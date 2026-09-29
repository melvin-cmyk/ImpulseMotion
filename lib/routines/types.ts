/**
 * Routines — contracts shared by every module of the feature.
 *
 * A routine is a deterministic plan of typed steps, written once with the
 * help of an AI and then run as is: read (Sheet, Meta, Google Ads), transform
 * rows with closed operators, optionally summarise with an AI that only
 * produces text, then act (Sheet, Slack, e-mail, Meta ads created paused).
 *
 * This file is the single source of the types and of the shared limits: the
 * engine, the step handlers, the API routes and the UI all import from here.
 * It has no dependency, so it is safe on the client side too.
 */

// ── Steps ────────────────────────────────────────────────────────────────

export type StepType =
  | "sheet.read" | "meta.insights" | "google.insights"
  | "rows.filter" | "rows.sort" | "rows.limit" | "rows.select"
  | "ai.summary"
  | "sheet.write" | "slack.message" | "email.send" | "meta.create_ads";

/** Every step type, in the order the UI lists them (sources, transformations, AI, actions). */
export const STEP_TYPES = [
  "sheet.read", "meta.insights", "google.insights",
  "rows.filter", "rows.sort", "rows.limit", "rows.select",
  "ai.summary",
  "sheet.write", "slack.message", "email.send", "meta.create_ads",
] as const satisfies readonly StepType[];

/** What a step writes: nothing, a Sheet, a message (Slack, e-mail) or an ad platform. */
export type WriteKind = "none" | "sheet" | "message" | "platform";

/** Expected nature of each step; a handler that declares something else fails the registry test. */
export const STEP_WRITES: Record<StepType, WriteKind> = {
  "sheet.read": "none",
  "meta.insights": "none",
  "google.insights": "none",
  "rows.filter": "none",
  "rows.sort": "none",
  "rows.limit": "none",
  "rows.select": "none",
  "ai.summary": "none",
  "sheet.write": "sheet",
  "slack.message": "message",
  "email.send": "message",
  "meta.create_ads": "platform",
};

// ── Limits ───────────────────────────────────────────────────────────────

/** Steps in one definition, at most. */
export const MAX_STEPS = 12;
/** Items written per run (Routine.maxItemsPerRun); the surplus waits for the next run. */
export const DEFAULT_MAX_ITEMS_PER_RUN = 20;
export const MAX_ITEMS_PER_RUN_CAP = 50;
/** Recipients of an email.send step, at most. */
export const MAX_EMAIL_RECIPIENTS = 5;
/** The cron fires every 15 minutes: schedule times are multiples of it. */
export const SCHEDULE_STEP_MINUTES = 15;
export const DEFAULT_TIMEZONE = "Europe/Paris";
/** A late run still starts once within this delay; beyond it is recorded as missed. */
export const CATCH_UP_MAX_HOURS = 12;
/** Consecutive functional failures that switch a routine off (infra failures do not count). */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** Budget of one run, under the 300 s of the Vercel function. */
export const RUN_BUDGET_MS = 270_000;

/**
 * Set to "1" to require a real administrator (baseRole) to activate a routine
 * that writes on a platform. Absent: the consultant activates alone.
 */
export const PLATFORM_WRITE_NEEDS_ADMIN_ENV = "ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN";
export function platformWriteNeedsAdmin(env: Record<string, string | undefined> = process.env): boolean {
  return env[PLATFORM_WRITE_NEEDS_ADMIN_ENV] === "1";
}

// ── Statuses (plain strings in the database) ─────────────────────────────

export const ROUTINE_STATUSES = ["draft", "ready", "active", "paused", "error", "archived"] as const;
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number];

export const RUN_TRIGGERS = ["schedule", "manual", "dry_run"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const RUN_STATUSES = ["running", "success", "partial", "failed", "infra_failed", "missed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** pending = reserved before the platform call; uncertain = outcome unknown, never recreated automatically. */
export const ITEM_STATUSES = ["pending", "created", "failed", "uncertain"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const EVENT_KINDS = [
  "created", "definition_applied", "dry_run", "activated", "paused", "resumed",
  "auto_disabled", "run_manual", "archived",
] as const;
export type RoutineEventKind = (typeof EVENT_KINDS)[number];

// ── Data ─────────────────────────────────────────────────────────────────

export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;
/** Rows passed from one step to the next; truncated = the source had more than what was read. */
export interface RowSet { columns: string[]; rows: Row[]; truncated: boolean }
/** One tab of a spreadsheet, header on row 1. */
export interface SheetRef { spreadsheetId: string; tab: string }
/** Text with {{row.<column>}}, {{run.date}} and {{steps.<id>.text}} only, plain substitution. */
export type Template = string;

/** Structured schedule (no free cron expression), read in the routine's timezone. */
export interface Schedule {
  kind: "daily" | "weekly" | "monthly" | "manual";
  time?: string;          // "HH:MM", par pas de 15 min
  weekdays?: number[];    // 1 = lundi … 7 = dimanche
  dayOfMonth?: number;    // 1 à 28
}

// ── Step definitions ─────────────────────────────────────────────────────

/** `input` names the step whose rows are read; absent = the previous step. */
interface StepBase { id: string; type: StepType; label?: string; input?: string }

export interface SheetReadStep extends StepBase {
  type: "sheet.read"; sheet: SheetRef; requiredColumns: string[]; maxRows?: number;
}
export interface MetaInsightsStep extends StepBase {
  type: "meta.insights"; level: "account" | "campaign" | "adset" | "ad";
  window: "yesterday" | "7d" | "14d" | "30d" | "month_to_date";
  metrics: Array<"spend"|"impressions"|"clicks"|"ctr"|"cpm"|"conversions"|"cpa"|"roas">;
  nameContains?: string;
}
export interface GoogleInsightsStep extends StepBase {
  type: "google.insights"; level: "account" | "campaign";
  window: MetaInsightsStep["window"];
  metrics: Array<"spend"|"impressions"|"clicks"|"ctr"|"conversions"|"cpa"|"roas">;
}
export interface RowsFilterStep extends StepBase {
  type: "rows.filter";
  where: Array<{ column: string; op: "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains"|"empty"|"not_empty"; value?: Cell }>;
}
export interface RowsSortStep extends StepBase { type: "rows.sort"; by: string; dir: "asc" | "desc" }
export interface RowsLimitStep extends StepBase { type: "rows.limit"; count: number }
export interface RowsSelectStep extends StepBase { type: "rows.select"; columns: Array<{ from: string; as?: string }> }

/** Text only, no tool; its output feeds message fields and nothing else. */
export interface AiSummaryStep extends StepBase {
  type: "ai.summary"; instruction: string; maxChars?: number;
  onFailure: "continue_without" | "fail";
}
/** upsert requires keyColumn. */
export interface SheetWriteStep extends StepBase {
  type: "sheet.write"; sheet: SheetRef; mode: "append" | "upsert";
  keyColumn?: string; columns: Array<{ column: string; value: Template }>;
}
export interface SlackMessageStep extends StepBase {
  type: "slack.message"; channel: string; text: Template; includeTable?: boolean;
}
export interface EmailSendStep extends StepBase {
  type: "email.send"; to: string[]; subject: Template; body: Template; includeTable?: boolean;
}
/** One ad per row, always paused. keyColumn carries the idempotence key. */
export interface MetaCreateAdsStep extends StepBase {
  type: "meta.create_ads";
  campaignId: string; adsetId: string; pageId: string; instagramActorId?: string;
  keyColumn: string;
  mapping: {
    adName: Template; primaryText: Template; headline?: Template; description?: Template;
    linkUrl: Template; callToAction?: string;
    mediaType: "image" | "video"; mediaUrl: Template;
  };
  writeBack?: { sheet: SheetRef; statusColumn: string; adIdColumn?: string; errorColumn?: string };
  // Volontairement aucun champ « status ».
}

export type RoutineStep =
  | SheetReadStep | MetaInsightsStep | GoogleInsightsStep
  | RowsFilterStep | RowsSortStep | RowsLimitStep | RowsSelectStep
  | AiSummaryStep | SheetWriteStep | SlackMessageStep | EmailSendStep | MetaCreateAdsStep;

/** Step definition of a given type: StepOf<"sheet.read"> = SheetReadStep. */
export type StepOf<T extends StepType> = Extract<RoutineStep, { type: T }>;

export interface RoutineDefinition { version: 1; steps: RoutineStep[] }   // 12 étapes au plus

/** What the AI proposes in a ```routine block; revalidated by the server before anything is applied. */
export interface RoutineProposal {
  name: string; description: string; schedule: Schedule;
  definition: RoutineDefinition; maxItemsPerRun?: number;
  explanation: string; assumptions: string[];
}

// ── Execution ────────────────────────────────────────────────────────────

export type RunMode = "dry_run" | "live";

/**
 * Capability required by every function that writes. The brand is a symbol
 * that is never exported, so no literal has this type: the only way to get one
 * is mintWriteGuard() in lib/routines/write-guard.ts, imported by the engine
 * alone and called in live mode only.
 */
declare const writeGuardBrand: unique symbol;
export interface WriteGuard { readonly [writeGuardBrand]: true; readonly runId: string }

export interface StepContext {
  mode: RunMode;
  routine: { id: string; name: string; metaAccountId: string | null; googleCustomerId: string | null; timezone: string; maxItemsPerRun: number };
  runId: string; now: Date; deadlineAt: number;
  input: RowSet | null;
  outputs: Record<string, StepOutput>;
  write: WriteGuard | null;   // null en essai à blanc
  /** Reserves the item in the database before the platform call (RoutineItem, unique per routine and key). */
  claimItem(stepId: string, itemKey: string, label: string): Promise<"claimed" | "already_done" | "uncertain">;
  settleItem(stepId: string, itemKey: string, r: { status: "created" | "failed"; externalId?: string; error?: string }): Promise<void>;
}

export interface StepOutput { rows?: RowSet; text?: string }
/** What a step would write: the whole result of a dry run. */
export interface PlannedWrite { target: "meta" | "sheet" | "slack" | "email"; summary: string; itemKey?: string; preview: Record<string, Cell> }
/** functional = the routine is wrong (counts towards the automatic stop); infra = relay, network, quota. */
export type ErrorClass = "functional" | "infra";

export interface StepResult {
  stepId: string; type: StepType;
  status: "ok" | "skipped" | "failed";
  durationMs: number; rowsIn: number; rowsOut: number;
  output: StepOutput; planned: PlannedWrite[];
  written: Array<{ itemKey?: string; externalId?: string; summary: string }>;
  warnings: string[];
  error?: { class: ErrorClass; message: string };
}

export interface PreflightIssue { stepId: string; severity: "error" | "warning"; message: string }

/** What a handler returns; the engine adds stepId, type and durationMs. */
export type StepRunOutcome = Omit<StepResult, "stepId" | "type" | "durationMs">;

export interface StepHandler<S extends RoutineStep = RoutineStep> {
  type: S["type"];
  writes: WriteKind;
  /** Shape only, no network: rebuilds the step field by field from untrusted input. */
  validate(step: unknown): { ok: true; step: S } | { ok: false; error: string };
  /** Real checks before a definition is applied (header read, campaign in the account…). */
  preflight(step: S, routine: StepContext["routine"]): Promise<PreflightIssue[]>;
  /** Never writes when ctx.write is null; reports the writes as `planned` instead. */
  run(step: S, ctx: StepContext): Promise<StepRunOutcome>;
}

export interface RunResult {
  runId: string; mode: RunMode;
  status: "success" | "partial" | "failed" | "infra_failed";
  steps: StepResult[];
  totals: { planned: number; created: number; skipped: number; failed: number };
  timedOut: boolean;
}
