/**
 * Routines — contracts shared by every module of the feature.
 *
 * A routine is a deterministic plan of typed steps, written once with the
 * help of an AI and then run as is: read (Sheet, Meta, Google Ads, TikTok Ads), transform
 * rows with closed operators, optionally summarise with an AI that only
 * produces text, then act (Sheet, Slack, e-mail, Meta ads created paused).
 *
 * This file is the single source of the types and of the shared limits: the
 * engine, the step handlers, the API routes and the UI all import from here.
 * It has no dependency, so it is safe on the client side too.
 */

// ── Steps ────────────────────────────────────────────────────────────────

export type StepType =
  | "sheet.read" | "meta.insights" | "google.insights" | "tiktok.insights"
  | "rows.filter" | "rows.sort" | "rows.limit" | "rows.select"
  | "ai.summary"
  | "sheet.write" | "slack.message" | "email.send" | "meta.create_ads";

/** Every step type, in the order the UI lists them (sources, transformations, AI, actions). */
export const STEP_TYPES = [
  "sheet.read", "meta.insights", "google.insights", "tiktok.insights",
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
  "tiktok.insights": "none",
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
/**
 * Ad accounts a run reads at most through the steps that read several clients
 * (`clients` of meta.insights, google.insights, tiktok.insights), all steps
 * together: one report per account. Beyond, the first ones in the order of
 * the clients' names are read and the run says what was left out.
 */
export const MAX_ACCOUNTS_PER_RUN = 40;
/** Clients one step may name in its `clients` list. */
export const MAX_LISTED_CLIENTS = 50;
/**
 * Time a step that reads several clients leaves to the rest of the run: no
 * account read is started once less than this is left before the deadline
 * (an AI summary and a message come after the reads).
 */
export const MULTI_CLIENT_RESERVE_MS = 90_000;
/** Items written per run (Routine.maxItemsPerRun); the surplus waits for the next run. */
export const DEFAULT_MAX_ITEMS_PER_RUN = 20;
export const MAX_ITEMS_PER_RUN_CAP = 50;
/** Recipients of an email.send step, at most. */
export const MAX_EMAIL_RECIPIENTS = 5;
/** Schedule times are multiples of it. The cron itself fires every hour (see vercel.json). */
export const SCHEDULE_STEP_MINUTES = 15;
export const DEFAULT_TIMEZONE = "Europe/Paris";
/** A late run still starts once within this delay; beyond it is recorded as missed. */
export const CATCH_UP_MAX_HOURS = 12;
/** Consecutive functional failures that switch a routine off (infra failures do not count). */
export const MAX_CONSECUTIVE_FAILURES = 3;
/**
 * Live runs in a row that are not a full success (partial, failed, outage)
 * after which the agency is told ONCE, in the internal channel of the client.
 * The routine goes on; nothing more is said until a run succeeds.
 */
export const DEGRADED_AFTER_RUNS = 3;
/**
 * A scheduled run that stopped for lack of time with rows left stays due for
 * the next firing of the cron, this many times per occurrence of the schedule.
 */
export const MAX_RESUMES_PER_SLOT = 3;
/** Budget of one run, under the 300 s of the Vercel function. */
export const RUN_BUDGET_MS = 270_000;
/** A failed item is tried again on later runs, up to this many attempts in all; then it is given up. */
export const MAX_ITEM_ATTEMPTS = 3;
/**
 * The cron starts no routine with less than this left of its budget: a routine
 * that writes on a platform needs the time of its reads and of one ad at
 * least, the others that of their reads. Below, the routine stays due.
 */
export const MIN_START_PLATFORM_MS = 90_000;
export const MIN_START_MS = 30_000;

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

/**
 * pending = reserved before the platform call; uncertain = outcome unknown, or
 * object known by its externalId: never recreated automatically.
 */
export const ITEM_STATUSES = ["pending", "created", "failed", "uncertain"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const EVENT_KINDS = [
  "created", "definition_applied", "dry_run", "activated", "paused", "resumed",
  "auto_disabled", "run_manual", "archived",
  // Told once that the routine is degraded; a person settled an item that was to be checked.
  "degraded_notified", "item_resolved",
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

/**
 * Clients a read step covers, instead of the routine's own accounts:
 *   "all"      every client in the scope of who answers for the run, read
 *              again at EVERY run (never frozen: a client that leaves the
 *              scope is no longer read, one that comes in is);
 *   string[]   clients by their id (AlertClient.id, lib/auto-alerts/clients.ts),
 *              each account checked against that same scope at every run.
 * Absent: the routine's own accounts, as before.
 */
export type ClientSelection = "all" | string[];
/** Columns put first on every row of a step that reads several clients. */
export const CLIENT_COLUMNS = ["client_name", "platform", "account_id", "account_name"] as const;

export type AdPlatform = "meta" | "google" | "tiktok";

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
  /** Several clients instead of the routine's account (ClientSelection). */
  clients?: ClientSelection;
}
export interface GoogleInsightsStep extends StepBase {
  type: "google.insights"; level: "account" | "campaign";
  window: MetaInsightsStep["window"];
  metrics: Array<"spend"|"impressions"|"clicks"|"ctr"|"conversions"|"cpa"|"roas">;
  /** Several clients instead of the routine's account (ClientSelection). */
  clients?: ClientSelection;
}
/**
 * TikTok Ads figures of the advertisers attached to the routine's dashboard
 * (DashboardSource of kind "tiktok"), never of an id written in the step.
 * Read only: no step writes to TikTok.
 */
export interface TikTokInsightsStep extends StepBase {
  type: "tiktok.insights"; level: "account" | "campaign" | "day";
  window: MetaInsightsStep["window"];
  metrics: Array<"spend"|"impressions"|"clicks"|"ctr"|"cpm"|"conversions"|"cpa"|"purchases"|"purchase_value"|"roas"|"video_views">;
  /** Several clients instead of the advertisers of the routine's dashboard (ClientSelection). */
  clients?: ClientSelection;
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
  | SheetReadStep | MetaInsightsStep | GoogleInsightsStep | TikTokInsightsStep
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

/**
 * Answer to a reservation. Only `claimed` allows a creation.
 *   already_done  created by an earlier run
 *   uncertain     outcome unknown, never created again by the routine; with
 *                 `externalId` when the object is known: it is read again by
 *                 this id, nothing else is created
 *   abandoned     failed MAX_ITEM_ATTEMPTS times: given up, `error` is the last one
 *   deferred      put off to the next run (ceiling of items or time budget)
 * `attempts` counts this attempt in (1 on a first reservation).
 */
export type ClaimState = "claimed" | "already_done" | "uncertain" | "abandoned" | "deferred";
export interface ItemClaim { state: ClaimState; externalId?: string; error?: string; attempts?: number }

/**
 * What a step wrote (live run) or would write (dry run), by nature of write:
 * the same counters in both modes. `skipped`, `failed` and `deferred` count
 * items (rows), whatever they would have written.
 */
export interface WriteCounts {
  adsCreated: number; adsAttached: number; sheetRows: number; messages: number;
  skipped: number; failed: number; deferred: number;
}
export const WRITE_COUNT_KEYS = ["adsCreated", "adsAttached", "sheetRows", "messages", "skipped", "failed", "deferred"] as const satisfies ReadonlyArray<keyof WriteCounts>;
export const emptyCounts = (): WriteCounts => ({ adsCreated: 0, adsAttached: 0, sheetRows: 0, messages: 0, skipped: 0, failed: 0, deferred: 0 });
/** Writes of every nature, added up: what the columns itemsPlanned and itemsCreated hold. */
export const writesOf = (c: WriteCounts): number => c.adsCreated + c.adsAttached + c.sheetRows + c.messages;

/**
 * Key of an item in RoutineItem, unique per routine: WHERE the routine writes
 * (the ad set, for meta.create_ads), then the value of the key column.
 *   - the same row sent to another ad set is another item, never « already
 *     done » (and the dry run says that the rows will be created again);
 *   - the id of the step is NOT part of it: a routine has one meta.create_ads
 *     step at most, and an AI that rewrites the routine may name that step
 *     otherwise. The rows already created must stay so.
 */
export function itemKeyOf(scope: string, rowKey: string | number): string {
  return `${scope}:${String(rowKey).trim()}`;
}

/**
 * What meta.create_ads writes in the status column of a Sheet: a closed list.
 * « à vérifier » may be followed by « : » and what is to be checked. « créée »
 * alone is a row created by an earlier run whose status had not reached the
 * Sheet. The AI that writes the routines is told this list.
 */
export const META_SHEET_STATUSES = [
  "créée (en pause)", "déjà présente (en pause)", "créée", "échec", `abandonnée après ${MAX_ITEM_ATTEMPTS} tentatives`, "refusée", "à vérifier",
] as const;

/** "<adsetId>:<row key>" → its two parts; a key of another form is given whole, without ad set. */
export function splitItemKey(itemKey: string): { adsetId: string | null; rowKey: string } {
  const at = itemKey.indexOf(":");
  const scope = at > 0 ? itemKey.slice(0, at) : "";
  return /^\d{5,25}$/.test(scope) ? { adsetId: scope, rowKey: itemKey.slice(at + 1) } : { adsetId: null, rowKey: itemKey };
}

/** What a step may know of the items of its routine (StepContext.listItems). */
export interface KnownItem { itemKey: string; status: ItemStatus; externalId: string | null }

/**
 * What a run may read of the ad accounts of several clients. Made by the
 * engine for a routine that has a step with `clients`, from the scope of who
 * answers for the run (lib/routines/clients.ts, accountReaderFor).
 */
export interface AccountReader {
  /** The account is in the scope of who answers for the run, and of who started it. */
  canRead(platform: AdPlatform, accountId: string): boolean;
  /** Takes up to `wanted` reads out of what is left for the run (MAX_ACCOUNTS_PER_RUN); returns how many were granted. */
  take(wanted: number): number;
  /** Why nothing may be read (owner gone, scope unreadable); null when all is well. */
  problem: string | null;
}

export interface StepContext {
  mode: RunMode;
  routine: {
    id: string; name: string; metaAccountId: string | null; googleCustomerId: string | null; timezone: string; maxItemsPerRun: number;
    /** Client the routine works for, and its dashboard: what the AI usage is recorded under. Set by the engine. */
    clientName?: string; dashboardId?: string | null;
    /** Facebook Page chosen in the form that created the routine: when set, the ads are published by THAT Page. */
    pageId?: string | null;
  };
  runId: string; now: Date; deadlineAt: number;
  input: RowSet | null;
  outputs: Record<string, StepOutput>;
  /** Set by the engine when a step reads several clients; absent otherwise, and such a step then reads nothing. */
  accounts?: AccountReader;
  write: WriteGuard | null;   // null en essai à blanc
  /**
   * Aborted by the engine when the run ends or gives the step up: a step looks
   * at it before every write. The guard is revoked at the same time, so a
   * write that does not look is refused anyway.
   */
  signal?: AbortSignal;
  /**
   * Reserves the item in the database before the platform call (RoutineItem,
   * unique per routine and key). In a dry run the same answer is given from
   * the database and nothing is reserved.
   */
  claimItem(stepId: string, itemKey: string, label: string): Promise<ItemClaim>;
  /** Items of the routine, every ad set included: to say what a change of ad set will create again. Read only. */
  listItems?(): Promise<KnownItem[]>;
  /**
   * A failure that carries an externalId is kept `uncertain`: the object exists, it is never created again.
   * A step the engine gave up may still settle what it had reserved: the id of
   * the object is kept, and the item stays `uncertain` until the object is read again.
   */
  settleItem(stepId: string, itemKey: string, r: { status: "created" | "failed"; externalId?: string; error?: string }): Promise<void>;
  /** Same answer as claimItem without reserving anything, whatever the mode: to count the rows a step leaves for the next run. */
  peekItem?(stepId: string, itemKey: string): Promise<ItemClaim>;
  /** An `uncertain` item whose object was read again (by its id, or found by its name when no id was kept) and found as wanted becomes `created`. No-op in a dry run. */
  confirmItem?(stepId: string, itemKey: string, externalId: string): Promise<void>;
}

export interface StepOutput { rows?: RowSet; text?: string }
/** What a step would write: the whole result of a dry run. */
export interface PlannedWrite { target: "meta" | "sheet" | "slack" | "email"; summary: string; itemKey?: string; preview: Record<string, Cell> }
/** functional = the routine is wrong (counts towards the automatic stop); infra = relay, network, quota. */
export type ErrorClass = "functional" | "infra";

/** One write done. `target` and `attached` say its nature, for the counters of a step that gives none. */
export interface WrittenItem { itemKey?: string; externalId?: string; summary: string; target?: PlannedWrite["target"]; attached?: boolean }

export interface StepResult {
  stepId: string; type: StepType;
  status: "ok" | "skipped" | "failed";
  durationMs: number; rowsIn: number; rowsOut: number;
  /** `planned` is filled by a dry run only; a live run says what it did in `written`. */
  output: StepOutput; planned: PlannedWrite[];
  written: WrittenItem[];
  warnings: string[];
  /** Set by the engine for every step, from what the handler counted or, failing that, from `planned` and `written`. */
  counts: WriteCounts;
  /** The step stopped for lack of time: what is left waits for the next run. */
  timedOut?: boolean;
  /**
   * scope "items": the step did its work and some items failed (a row refused
   * by Meta). Such a failure is bounded by the attempts of the item and never
   * counts towards the automatic stop. Absent or "step": the step itself failed.
   */
  error?: { class: ErrorClass; message: string; scope?: "step" | "items" };
}

export interface PreflightIssue { stepId: string; severity: "error" | "warning"; message: string }

/** What a handler returns; the engine adds stepId, type and durationMs, and completes the counters. */
export type StepRunOutcome = Omit<StepResult, "stepId" | "type" | "durationMs" | "counts"> & {
  counts?: Partial<WriteCounts>;
  /** What the person must read before going on, said with the run and not only under the step. */
  notices?: string[];
};

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
  /** Totals kept in the columns of RoutineRun: writes of every nature added up. The detail is in `counts`. */
  totals: { planned: number; created: number; skipped: number; failed: number };
  /** By nature of write, added over the steps: planned in a dry run, done in a live run. */
  counts: WriteCounts;
  timedOut: boolean;
}
