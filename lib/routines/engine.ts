/**
 * Routines — the engine: runs the steps of a routine, in order.
 *
 * ONLY MODULE THAT MAKES A WRITE GUARD. A live run mints one guard and hands
 * it to the steps through `ctx.write`; a dry run carries `ctx.write = null`
 * and creates no RoutineItem, so nothing can be written and what would have
 * been comes back in `planned`.
 *
 * What the engine guarantees, whatever the steps do:
 *   - the definition is validated again and its hash compared with the one
 *     stored: a row edited by hand in the database does not run;
 *   - a step whose input (or quoted text) failed is skipped, the others go on;
 *   - the ceiling of items per run and the time budget: past either, no item
 *     is reserved any more and the rest waits for the next run;
 *   - the guard is revoked and the steps are told to stop (ctx.signal) as soon
 *     as the run ends or a step is given up: a step that answers late cannot
 *     write any more;
 *   - failures are sorted: functional (the routine is wrong) or infrastructure
 *     (relay, network, quota). Three runs in a row that failed as a whole, by
 *     the routine's fault, switch it off. A run that wrote something, a run
 *     where only items failed and an infrastructure failure never count;
 *   - a step that reads several clients gets a reader made at the start of
 *     EVERY run from the scope of who answers for the routine, and of who
 *     started the run (lib/routines/clients.ts): nothing outside it is read;
 *   - a scheduled run moves nextRunAt when it takes the lock, before any step:
 *     a run that crashes or is killed is not started again by the next firing.
 *     It is closed as interrupted (closeInterruptedRuns) and never replayed.
 */

import { accountReaderFor, readsSeveralClients } from "@/lib/routines/clients";
import { hashDefinition } from "@/lib/routines/hash";
import { notifyAutoDisabled, notifyDegraded } from "@/lib/routines/notify";
import { catchUpDecision, computeNextRunAt, lastOccurrenceAt } from "@/lib/routines/schedule";
import { handlerFor, writesPlatform } from "@/lib/routines/steps";
import {
  LOCK_TTL_MS, acquireRunLock, chosenPageOf, claimItem, closeRun, confirmItem, countScheduledRunsSince, degradedAlreadyNotified, expiredLocks,
  finishRun, getRoutine, hasRunSince, internalChannelFor, lastLiveRuns, listItems, logEvent, markUnsettledUncertain,
  noteLastRun, noteOnLastEvent, ownerProblem, ownerEmail, peekItem, recordMissedRun, recordRunOutcome, releaseRunLock, routineHealth, runningRunsBefore,
  settleItem, startRun, switchOff, traceUntracedRun,
  type FailureKind, type RoutineRecord,
} from "@/lib/routines/store";
import { parseStoredDefinition, parseStoredSchedule, resolveInputId, stepDependencies } from "@/lib/routines/validate";
import { mintWriteGuard, revokeWriteGuard } from "@/lib/routines/write-guard";
import {
  DEGRADED_AFTER_RUNS, MAX_CONSECUTIVE_FAILURES, MAX_ITEMS_PER_RUN_CAP, MAX_RESUMES_PER_SLOT, MIN_START_MS, MIN_START_PLATFORM_MS, RUN_BUDGET_MS, WRITE_COUNT_KEYS, emptyCounts, writesOf,
  type AccountReader, type ErrorClass, type ItemClaim, type RoutineDefinition, type RoutineStep, type RunMode, type RunResult, type RunTrigger,
  type Schedule, type StepContext, type StepOutput, type StepResult, type StepRunOutcome, type WriteCounts, type WriteGuard, type WriteKind,
} from "@/lib/routines/types";

export interface RunOptions {
  mode: RunMode;
  trigger: RunTrigger;
  startedById?: string | null;
  /** Date of the run, as the steps see it ({{run.date}}, reporting windows). */
  now?: Date;
  /** Hard stop (ms since epoch). Default: 270 s from the start. */
  deadlineAt?: number;
  /** Clock used for the budget and the durations; the tests pass their own. */
  clock?: () => number;
}

/** RunResult, plus what the routes and the cron report. */
export interface EngineRunResult extends RunResult {
  definitionHash: string;
  /** Why the run did not go through, when it did not. */
  error: string | null;
  /** Items left for the next run (ceiling or time budget), those a step left by itself included. */
  deferred: number;
  consecutiveFailures: number;
  autoDisabled: boolean;
  /** What the person must read before going on (a dry run that showed nothing to create). */
  warnings: string[];
}

/** The run could not even be recorded: nothing was read, nothing was written. runLocked puts the schedule back. */
export class RunNotStartedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "RunNotStartedError";
    this.cause = cause;
  }
}

/** Dry run of a routine that creates ads, with nothing to create: activation stays open, the person is told. */
export const EMPTY_DRY_RUN_WARNING = "L'essai n'a rien trouvé à créer : vous activez sans avoir vu d'exemple.";
/** First words of the error of a run closed by closeInterruptedRuns. */
export const INTERRUPTED = "Exécution interrompue";

/** No step starts with less than this left before the deadline. */
export const STEP_START_MARGIN_MS = 5_000;
/** A step that has not answered this long after the deadline is given up. */
export const STEP_GRACE_MS = 15_000;

const STORED_ROWS = 20;
const STORED_TEXT_CHARS = 4000;
const STORED_LIST = 100;

// ── Errors ───────────────────────────────────────────────────────────────

const INFRA_RE = /relay|timeout|timed out|d[ée]lai d[ée]pass[ée]|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|fetch failed|network|r[ée]seau|inaccessible|indisponible|rate.?limit|quota|too many requests|\b(429|500|502|503|504)\b|abort/i;

/** A thrown error is infrastructure when it looks like the network, the relay or a quota. */
export function classifyError(e: unknown): ErrorClass {
  const name = e instanceof Error ? e.name : "";
  const message = e instanceof Error ? e.message : String(e ?? "");
  if (name === "AbortError" || name === "TimeoutError") return "infra";
  if (name.startsWith("PrismaClient")) return "infra";
  return INFRA_RE.test(message) ? "infra" : "functional";
}

function errorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e ?? "");
  return (message || "erreur inconnue").slice(0, 500);
}

// ── Pieces ───────────────────────────────────────────────────────────────

function emptyOutcome(status: StepRunOutcome["status"], rowsIn: number, extra: Partial<StepRunOutcome> = {}): StepRunOutcome {
  return { status, rowsIn, rowsOut: 0, output: {}, planned: [], written: [], warnings: [], ...extra };
}

const whole = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined);

/** Counters a handler gave, kept only where they are whole numbers. */
function givenCounts(raw: unknown): Partial<WriteCounts> {
  const out: Partial<WriteCounts> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const key of WRITE_COUNT_KEYS) {
    const n = whole((raw as Record<string, unknown>)[key]);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

type Target = "meta" | "sheet" | "slack" | "email";
const TARGET_OF: Record<WriteKind, Target | null> = { none: null, sheet: "sheet", message: "slack", platform: "meta" };

/** Counters of a step that gave none, read from what it planned (dry run) or wrote (live run). */
function countedFrom(list: ReadonlyArray<{ target?: Target; attached?: boolean }>, writes: WriteKind): WriteCounts {
  const counts = emptyCounts();
  for (const item of list) {
    const target = item.target ?? TARGET_OF[writes];
    if (target === "meta") counts[item.attached ? "adsAttached" : "adsCreated"]++;
    else if (target === "sheet") counts.sheetRows++;
    else if (target === "slack" || target === "email") counts.messages++;
  }
  return counts;
}

/** A handler is code of another lot: whatever it returns is brought back to the contract. */
function normalize(outcome: unknown, rowsIn: number): StepRunOutcome {
  if (typeof outcome !== "object" || outcome === null) {
    return emptyOutcome("failed", rowsIn, { error: { class: "functional", message: "L'étape n'a rien renvoyé." } });
  }
  const o = outcome as Partial<StepRunOutcome>;
  const status = o.status === "ok" || o.status === "skipped" || o.status === "failed" ? o.status : "failed";
  const output: StepOutput = {};
  if (o.output?.rows && Array.isArray(o.output.rows.rows) && Array.isArray(o.output.rows.columns)) output.rows = o.output.rows;
  if (typeof o.output?.text === "string") output.text = o.output.text;
  const result: StepRunOutcome = {
    status,
    rowsIn: Number.isFinite(o.rowsIn) ? Number(o.rowsIn) : rowsIn,
    rowsOut: Number.isFinite(o.rowsOut) ? Number(o.rowsOut) : output.rows?.rows.length ?? 0,
    output,
    planned: Array.isArray(o.planned) ? o.planned : [],
    written: Array.isArray(o.written) ? o.written : [],
    warnings: Array.isArray(o.warnings) ? o.warnings.filter((w): w is string => typeof w === "string") : [],
  };
  if (o.timedOut === true) result.timedOut = true;
  if (Array.isArray(o.notices)) result.notices = o.notices.filter((n): n is string => typeof n === "string" && !!n).slice(0, 20);
  const counts = givenCounts(o.counts);
  if (Object.keys(counts).length) result.counts = counts;
  if (status === "failed") {
    result.error = {
      class: o.error?.class === "infra" ? "infra" : "functional",
      message: typeof o.error?.message === "string" && o.error.message ? o.error.message.slice(0, 500) : "L'étape a échoué sans message.",
      ...(o.error?.scope === "items" ? { scope: "items" as const } : {}),
    };
  }
  return result;
}

/** What is kept of a run in the database and sent to the browser: a sample of the rows, not the data. */
export function compactSteps(steps: StepResult[], maxRows = STORED_ROWS): StepResult[] {
  return steps.map((s) => {
    const output: StepOutput = {};
    if (s.output.rows) {
      output.rows = {
        columns: s.output.rows.columns,
        rows: s.output.rows.rows.slice(0, maxRows),
        truncated: s.output.rows.truncated || s.output.rows.rows.length > maxRows,
      };
    }
    if (typeof s.output.text === "string") output.text = s.output.text.slice(0, STORED_TEXT_CHARS);
    return { ...s, output, planned: s.planned.slice(0, STORED_LIST), written: s.written.slice(0, STORED_LIST), warnings: s.warnings.slice(0, STORED_LIST) };
  });
}

export function compactResult<T extends RunResult>(result: T, maxRows = STORED_ROWS): T {
  return { ...result, steps: compactSteps(result.steps, maxRows) };
}

function after<T>(ms: number, value: T): { promise: Promise<T>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(value), Math.max(0, ms)); });
  return { promise, cancel: () => { if (timer) clearTimeout(timer); } };
}

interface Loaded { definition: RoutineDefinition; schedule: Schedule; hash: string }

/** Reads what the routine stores, as untrusted as the day it was proposed. */
function loadDefinition(routine: RoutineRecord): { ok: true; value: Loaded } | { ok: false; error: string } {
  const definition = parseStoredDefinition(routine.definitionJson);
  if (!definition.ok) return { ok: false, error: `Définition refusée : ${definition.errors.join(" ")}` };
  const schedule = parseStoredSchedule(routine.scheduleJson);
  if (!schedule.ok) return { ok: false, error: `Planning refusé : ${schedule.errors.join(" ")}` };
  const hash = hashDefinition({
    definition: definition.value, schedule: schedule.value, maxItemsPerRun: routine.maxItemsPerRun,
    metaAccountId: routine.metaAccountId, googleCustomerId: routine.googleCustomerId, timezone: routine.timezone,
  });
  if (!routine.definitionHash || hash !== routine.definitionHash) {
    return { ok: false, error: "La définition enregistrée ne correspond plus à son empreinte : appliquez-la de nouveau puis refaites un essai à blanc." };
  }
  return { ok: true, value: { definition: definition.value, schedule: schedule.value, hash } };
}

const STEP_TIMEOUT = "Délai dépassé : l'étape n'a pas répondu avant la fin du budget de temps.";

// ── Run ──────────────────────────────────────────────────────────────────

export async function runRoutine(routine: RoutineRecord, opts: RunOptions): Promise<EngineRunResult> {
  const { mode, trigger } = opts;
  if ((mode === "dry_run") !== (trigger === "dry_run")) throw new Error("Mode et déclencheur incohérents");
  const clock = opts.clock ?? Date.now;
  const startedAt = clock();
  const now = opts.now ?? new Date(startedAt);
  const deadlineAt = opts.deadlineAt ?? startedAt + RUN_BUDGET_MS;
  const cap = Math.max(1, Math.min(routine.maxItemsPerRun, MAX_ITEMS_PER_RUN_CAP));

  let runId: string;
  try {
    runId = await startRun({
      routineId: routine.id, trigger, definitionHash: routine.definitionHash,
      startedById: opts.startedById ?? null, startedAt: now,
    });
  } catch (e) {
    throw new RunNotStartedError(e);
  }
  const chosenPage = chosenPageOf(routine);

  // One guard per live run, none in a dry run. Both end with the run, whatever ends it.
  const guard = mode === "live" ? mintWriteGuard("live", runId) : null;
  const stop = new AbortController();
  const endWrites = () => { stop.abort(); revokeWriteGuard(guard); };

  try {
    return await runSteps();
  } finally {
    endWrites();
  }

  async function runSteps(): Promise<EngineRunResult> {
    const steps: StepResult[] = [];
    const outputs: Record<string, StepOutput> = {};
    const counts = emptyCounts();
    const warnings: string[] = [];
    let claims = 0;
    let timedOut = false;
    let abandoned: string | null = null;
    let fatal: { class: ErrorClass; message: string } | null = null;
    /** What the engine saw of the step that is running: used when the step gives no counters. */
    let tally = { skipped: 0, failed: 0, deferred: 0 };

    const loaded = loadDefinition(routine);
    if (!loaded.ok) fatal = { class: "functional", message: loaded.error };
    if (!fatal && trigger === "schedule") {
      try {
        const problem = await ownerProblem({ ...routine, writesPlatform: routine.writesPlatform || (loaded.ok && writesPlatform(loaded.value.definition.steps)) });
        if (problem) fatal = { class: "functional", message: problem };
      } catch (e) {
        fatal = { class: "infra", message: `Vérification du périmètre impossible : ${errorMessage(e)}` };
      }
    }

    // A step that reads several clients reads only what the scope of who answers for the run (and of who started it) holds, read now.
    let accounts: AccountReader | undefined;
    if (loaded.ok && !fatal && readsSeveralClients(loaded.value.definition)) {
      try {
        accounts = await accountReaderFor(routine, opts.startedById ?? null);
      } catch (e) {
        fatal = { class: "infra", message: `Vérification du périmètre impossible : ${errorMessage(e)}` };
      }
    }

    const context = (input: StepContext["input"]): StepContext => ({
      mode,
      routine: {
        id: routine.id, name: routine.name, metaAccountId: routine.metaAccountId, googleCustomerId: routine.googleCustomerId,
        timezone: routine.timezone, maxItemsPerRun: cap,
        clientName: routine.clientName, dashboardId: routine.dashboardId,
        pageId: chosenPage?.id ?? null,
      },
      runId, now, deadlineAt, input,
      // Each step sees the outputs of the steps before it, and cannot change them for the next ones.
      outputs: { ...outputs },
      ...(accounts ? { accounts } : {}),
      write: guard,
      signal: stop.signal,
      async claimItem(stepId, itemKey, label): Promise<ItemClaim> {
        if (stop.signal.aborted) { tally.deferred++; return { state: "deferred" }; }
        const full = claims >= cap || clock() >= deadlineAt;
        if (mode !== "live" || full) {
          // Answered from the database, nothing reserved: what is done or unknown is said so, the rest waits.
          const seen = await peekItem(routine.id, itemKey);
          if (seen.state !== "claimed") { tally.skipped++; return seen; }
          if (full) { tally.deferred++; return { state: "deferred" }; }
          claims++;
          return seen;
        }
        const got = await claimItem({ routineId: routine.id, runId, stepId, itemKey, label });
        if (got.state === "claimed") claims++; else tally.skipped++;
        return got;
      },
      peekItem: (_stepId, itemKey) => peekItem(routine.id, itemKey),
      listItems: () => listItems(routine.id),
      async settleItem(_stepId, itemKey, r) {
        if (mode !== "live") return;
        // Book-keeping, not a write on a platform: a step given up that hears from the platform afterwards may still say so.
        const settled = await settleItem({ routineId: routine.id, itemKey, status: r.status, externalId: r.externalId, error: r.error, runId });
        if (settled === "settled" && r.status === "failed") tally.failed++;
      },
      async confirmItem(_stepId, itemKey, externalId) {
        if (mode !== "live" || stop.signal.aborted) return;
        await confirmItem({ routineId: routine.id, itemKey, externalId });
      },
    });

    if (loaded.ok && !fatal) {
      const list = loaded.value.definition.steps;
      for (const [index, step] of list.entries()) {
        const began = clock();
        const push = (outcome: StepRunOutcome, stepCounts: WriteCounts = emptyCounts()) => {
          const { counts: _given, notices, ...rest } = outcome;
          void _given;
          for (const notice of notices ?? []) if (typeof notice === "string" && notice && !warnings.includes(notice)) warnings.push(notice.slice(0, 500));
          steps.push({ stepId: step.id, type: step.type, durationMs: Math.max(0, clock() - began), ...rest, counts: stepCounts });
          for (const key of WRITE_COUNT_KEYS) counts[key] += stepCounts[key];
          if (outcome.status === "ok") outputs[step.id] = outcome.output;
        };
        const inputId = resolveInputId(list, index);
        const input = inputId ? outputs[inputId]?.rows ?? null : null;
        const rowsIn = input?.rows.length ?? 0;

        if (abandoned) {
          push(emptyOutcome("skipped", rowsIn, { warnings: [`Non exécutée : l'étape « ${abandoned} » n'a pas répondu à temps, l'exécution a été arrêtée.`] }));
          continue;
        }
        const broken = stepDependencies(list, index).find((id) => steps.some((s) => s.stepId === id && s.status !== "ok"));
        if (broken) {
          push(emptyOutcome("skipped", rowsIn, { warnings: [`Non exécutée : elle dépend de l'étape « ${broken} », qui n'a pas abouti.`] }));
          continue;
        }
        if (clock() >= deadlineAt - STEP_START_MARGIN_MS) {
          timedOut = true;
          push(emptyOutcome("skipped", rowsIn, { warnings: ["Non exécutée : budget de temps de l'exécution épuisé. Reportée à la prochaine exécution."] }));
          continue;
        }

        const handler = handlerFor(step);
        tally = { skipped: 0, failed: 0, deferred: 0 };
        const outcome = await runStep(step, context(input), rowsIn, deadlineAt + STEP_GRACE_MS - clock());

        if (outcome.error?.message === STEP_TIMEOUT) {
          // Given up: the step may still be running. It is told to stop and its guard no longer opens anything.
          timedOut = true;
          abandoned = step.id;
          endWrites();
        }
        if (mode !== "live" && outcome.written.length) {
          // Cannot happen with a handler that honours ctx.write; said loudly if it does.
          outcome.status = "failed";
          outcome.error = { class: "functional", message: "L'étape a déclaré une écriture pendant un essai à blanc." };
          outcome.written = [];
          outcome.counts = {};
        }
        // `planned` is what a dry run shows; a live run says what it did in `written`.
        if (mode === "live") outcome.planned = [];

        let cut = 0;
        if (handler.writes === "platform") {
          // The ceiling bounds what is created on the platform. The status the step plans to write back in a
          // Sheet is not an item: it is neither counted against the ceiling nor cut, in a dry run as in a live one.
          const onPlatform = outcome.planned.filter((p) => p.target === "meta");
          if (onPlatform.length > cap) {
            cut = onPlatform.length - cap;
            const kept = new Set(onPlatform.slice(0, cap));
            outcome.planned = outcome.planned.filter((p) => p.target !== "meta" || kept.has(p));
            const { adsCreated: _created, adsAttached: _attached, ...others } = outcome.counts ?? {};
            void _created; void _attached;
            outcome.counts = others;
          }
          // An ad that existed and was attached is not a creation: the ceiling bounds what is created.
          const created = outcome.written.filter((w) => !w.attached).length;
          if (created > cap && outcome.status !== "failed") {
            outcome.status = "failed";
            outcome.error = { class: "functional", message: `L'étape a écrit ${created} éléments, au-delà du plafond de ${cap}.` };
          }
        }

        const given = outcome.counts ?? {};
        const read = countedFrom(mode === "live" ? outcome.written : outcome.planned, handler.writes);
        const stepCounts: WriteCounts = {
          adsCreated: given.adsCreated ?? read.adsCreated,
          adsAttached: given.adsAttached ?? read.adsAttached,
          sheetRows: given.sheetRows ?? read.sheetRows,
          messages: given.messages ?? read.messages,
          skipped: given.skipped ?? tally.skipped,
          failed: given.failed ?? tally.failed,
          // What the step left by itself (its own ceiling, its own look at the clock) and what the engine refused it.
          deferred: Math.max(given.deferred ?? 0, tally.deferred) + cut,
        };
        if (tally.deferred + cut > 0) {
          outcome.warnings.push(
            clock() >= deadlineAt
              ? `${tally.deferred + cut} élément(s) reporté(s) à la prochaine exécution : budget de temps épuisé.`
              : `${tally.deferred + cut} élément(s) reporté(s) à la prochaine exécution : plafond de ${cap} par exécution.`,
          );
        }
        if (outcome.timedOut) timedOut = true;
        push(outcome, stepCounts);
      }
      if (clock() >= deadlineAt && counts.deferred > 0) timedOut = true;
    }

    // No step runs any more: nothing may be written from here on.
    endWrites();

    if (mode === "live") {
      try {
        const unsettled = await markUnsettledUncertain(runId);
        if (unsettled) counts.skipped += unsettled;
      } catch { /* the next claim of these keys turns them uncertain anyway */ }
    }

    const totals = {
      planned: mode === "live" ? 0 : writesOf(counts),
      created: mode === "live" ? writesOf(counts) : 0,
      skipped: counts.skipped,
      failed: counts.failed,
    };

    // Outcome of the run.
    const failures = steps.filter((s) => s.status === "failed");
    const whole = failures.filter((s) => s.error?.scope !== "items");
    const functional = fatal?.class === "functional" || failures.some((s) => s.error?.class !== "infra");
    let status: RunResult["status"];
    if (!fatal && !failures.length) status = timedOut || totals.failed > 0 ? "partial" : "success";
    else if (mode === "live" && totals.created > 0) status = "partial";
    else status = functional ? "failed" : "infra_failed";

    // What counts towards the automatic stop: a run that failed as a whole, by the routine's fault, and wrote nothing.
    let failure: FailureKind;
    if (status === "success") failure = "none";
    else if (status === "partial") failure = "partial";
    else if (status === "infra_failed") failure = "infra";
    else failure = fatal?.class === "functional" || whole.some((s) => s.error?.class !== "infra") ? "functional" : "partial";
    const error = fatal?.message ?? failures[0]?.error?.message ?? null;

    if (mode === "dry_run" && status === "success" && loaded.ok && writesPlatform(loaded.value.definition.steps) && counts.adsCreated + counts.adsAttached === 0) {
      warnings.push(EMPTY_DRY_RUN_WARNING);
    }

    const finishedAt = clock();
    const closed = await finishRun(runId, {
      status, finishedAt: new Date(now.getTime() + Math.max(0, finishedAt - startedAt)), durationMs: finishedAt - startedAt,
      totals, steps: compactSteps(steps), error,
    });

    let consecutiveFailures = routine.consecutiveFailures;
    let autoDisabled = false;
    // A run closed as interrupted meanwhile has been counted as such: its outcome is not written twice.
    if (mode === "live" && closed) {
      const kept = await recordRunOutcome({ routineId: routine.id, status, failure, at: now, definitionHash: routine.definitionHash, message: error });
      consecutiveFailures = kept.consecutiveFailures;
      autoDisabled = kept.autoDisabled;
      if (autoDisabled) await announceAutoDisabled(runId, routine, `${consecutiveFailures} échecs de suite.`, error);
      else if (status !== "success") await noticeDegraded(routine, runId).catch(() => false);
    }

    return {
      runId, mode, status, steps, totals, counts, timedOut,
      definitionHash: routine.definitionHash, error, deferred: counts.deferred, consecutiveFailures, autoDisabled, warnings,
    };
  }
}

/**
 * After DEGRADED_AFTER_RUNS live runs in a row that are not a full success
 * (partial, failed, outage, interrupted), says ONCE, in the agency's channel
 * for the client, that the routine is degraded. The routine goes on. Nothing
 * more is said until a run has succeeded: the event `degraded_notified` names
 * the run it was said at, and is written BEFORE the message leaves, so that a
 * message that could not be sent is not sent again and again either.
 */
export async function noticeDegraded(routine: RoutineRecord, runId: string): Promise<boolean> {
  const health = await routineHealth(routine.id);
  if (health.degradedRuns < DEGRADED_AFTER_RUNS) return false;
  if (await degradedAlreadyNotified(routine.id)) return false;
  await logEvent(routine.id, "degraded_notified", { userId: null }, {
    definitionHash: routine.definitionHash,
    detail: `[run ${runId}] ${health.degradedRuns} exécutions de suite sans succès complet. Dernière erreur : ${health.lastError ?? "sans message"}`,
  });
  let detail: string;
  let guard: WriteGuard | null = null;
  try {
    guard = mintWriteGuard("live", runId);
    const channel = await internalChannelFor(routine);
    const owner = await ownerEmail(routine);
    ({ detail } = await notifyDegraded(guard, {
      routine: { id: routine.id, name: routine.name, clientName: routine.clientName }, runs: health.degradedRuns, lastError: health.lastError, owner, channel,
    }));
  } catch (e) {
    detail = `Message non envoyé : ${errorMessage(e)}`;
  } finally {
    revokeWriteGuard(guard);
  }
  await noteOnLastEvent(routine.id, "degraded_notified", detail).catch(() => {});
  return true;
}

/**
 * Says once, in the agency's channel for the client, that the routine has
 * switched itself off, and keeps what was done with the event. Whatever goes
 * wrong here, the run has ended and its result stands.
 */
async function announceAutoDisabled(runId: string, routine: RoutineRecord, reason: string, lastError: string | null): Promise<void> {
  let detail: string;
  // The guard of the run is revoked: this message has its own, which lives as long as the sending.
  let guard: WriteGuard | null = null;
  try {
    guard = mintWriteGuard("live", runId);
    const channel = await internalChannelFor(routine);
    const owner = await ownerEmail(routine);
    ({ detail } = await notifyAutoDisabled(guard, {
      routine: { id: routine.id, name: routine.name, clientName: routine.clientName }, reason, lastError, owner, channel,
    }));
  } catch (e) {
    detail = `Message non envoyé : ${errorMessage(e)}`;
  } finally {
    revokeWriteGuard(guard);
  }
  await noteOnLastEvent(routine.id, "auto_disabled", detail).catch(() => {});
}

async function runStep(step: RoutineStep, ctx: StepContext, rowsIn: number, budgetMs: number): Promise<StepRunOutcome> {
  const limit = after(budgetMs, "timeout" as const);
  try {
    const ran = Promise.resolve().then(() => handlerFor(step).run(step, ctx));
    // Left alone after a timeout, the step may still end; its rejection must not crash the process.
    ran.catch(() => {});
    const outcome = await Promise.race([ran, limit.promise]);
    if (outcome === "timeout") return emptyOutcome("failed", rowsIn, { error: { class: "infra", message: STEP_TIMEOUT } });
    return normalize(outcome, rowsIn);
  } catch (e) {
    return emptyOutcome("failed", rowsIn, { error: { class: classifyError(e), message: errorMessage(e) } });
  } finally {
    limit.cancel();
  }
}

// ── Runs that never ended, runs that never started ───────────────────────

/**
 * Closes the runs left `running` for longer than a lock lasts: the function
 * was killed by the platform, or the database could not be reached when the
 * run was to be closed. Called by the cron at every firing, and for one
 * routine when its lock is taken.
 *
 * Such a run is an INFRASTRUCTURE failure (`infra_failed`): a function killed
 * or a database out of reach says nothing of the routine, so it does not
 * count towards the automatic stop. It is never replayed: its schedule moved
 * on when it took the lock, and the items it had reserved turn `uncertain`.
 * Three live runs interrupted IN A ROW are no longer a mere outage (a routine
 * that never fits in its time budget): the routine is then switched off, with
 * the one message of the automatic stop.
 *
 * Called for every routine (the cron), it also traces the runs that never
 * started: see traceLostRuns.
 */
export async function closeInterruptedRuns(now: Date, opts: { routineId?: string } = {}): Promise<{ closed: number; disabled: string[]; traced: number }> {
  const stale = await runningRunsBefore(new Date(now.getTime() - LOCK_TTL_MS), opts);
  const disabled: string[] = [];
  let closed = 0;
  for (const run of stale) {
    const error = `${INTERRUPTED} : elle n'a pas rendu de résultat (fonction arrêtée par l'hébergeur ou base injoignable). Ce qui a pu être écrit avant l'arrêt n'est pas connu ; elle n'est pas rejouée.`;
    if (!(await closeRun(run.id, { status: "infra_failed", finishedAt: now, durationMs: now.getTime() - run.startedAt.getTime(), error }))) continue;
    closed++;
    await markUnsettledUncertain(run.id).catch(() => {});
    if (run.trigger === "dry_run") continue;
    await noteLastRun(run.routineId, run.startedAt, "infra_failed").catch(() => {});

    const last = await lastLiveRuns(run.routineId, MAX_CONSECUTIVE_FAILURES);
    const allInterrupted = last.length >= MAX_CONSECUTIVE_FAILURES && last.every((r) => r.status === "infra_failed" && (r.error ?? "").startsWith(INTERRUPTED));
    const routine = await getRoutine(run.routineId);
    if (!routine || routine.status !== "active") continue;
    if (!allInterrupted) {
      await noticeDegraded(routine, run.id).catch(() => false);
      continue;
    }
    const reason = `${MAX_CONSECUTIVE_FAILURES} exécutions interrompues de suite.`;
    if (await switchOff(routine.id, routine.definitionHash, `${reason} Dernier : ${error}`)) {
      disabled.push(routine.id);
      await announceAutoDisabled(run.id, routine, reason, error);
    }
  }
  const traced = opts.routineId ? 0 : await traceLostRuns(now).catch(() => 0);
  return { closed, disabled, traced };
}

/**
 * « Schedule moved on, no run traced »: a lock was taken (and with it the
 * schedule moved), then the database went away before the run could be
 * recorded AND before the schedule could be put back. What is left is a lock
 * that expired without being given back, and no run since it was taken. The
 * run that never was is traced as an outage, so that the history says what
 * happened to that occurrence.
 */
export async function traceLostRuns(now: Date): Promise<number> {
  let traced = 0;
  for (const routine of await expiredLocks(now)) {
    if (await traceLostRun(routine, now, true)) traced++;
  }
  return traced;
}

async function traceLostRun(routine: RoutineRecord, now: Date, clearLock: boolean): Promise<boolean> {
  if (!routine.lockedUntil || routine.lockedUntil.getTime() >= now.getTime()) return false;
  const takenAt = new Date(routine.lockedUntil.getTime() - LOCK_TTL_MS);
  if (await hasRunSince(routine.id, takenAt)) return false;
  const runId = await traceUntracedRun(routine, takenAt, now, clearLock);
  if (!runId) return false;
  await noticeDegraded(routine, runId).catch(() => false);
  return true;
}

// ── Run under lock (cron and "run now") ──────────────────────────────────

export type BusyReason = "not_found" | "not_active" | "locked" | "not_due";

export type LockedRun =
  | { outcome: "ran"; result: EngineRunResult; nextRunAt: Date | null }
  | { outcome: "missed"; nextRunAt: Date | null }
  /** Not started for lack of time before the deadline: nothing was touched, the routine is still due. */
  | { outcome: "postponed"; neededMs: number }
  /** Not taken: already running, not active, or (cron) not due any more. `reason` says which. */
  | { outcome: "busy"; reason: BusyReason; status?: string };

/** Time a routine needs before the deadline to be started at all. */
export function minStartMs(routine: Pick<RoutineRecord, "writesPlatform" | "definitionJson">): number {
  const definition = parseStoredDefinition(routine.definitionJson);
  const platform = routine.writesPlatform || (definition.ok && writesPlatform(definition.value.steps));
  return platform ? MIN_START_PLATFORM_MS : MIN_START_MS;
}

/** Why the lock was not given, read from the routine as it is now. */
async function whyBusy(routineId: string, now: Date, scheduled: boolean): Promise<LockedRun & { outcome: "busy" }> {
  const routine = await getRoutine(routineId).catch(() => null);
  if (!routine) return { outcome: "busy", reason: "not_found" };
  if (routine.status !== "active") return { outcome: "busy", reason: "not_active", status: routine.status };
  if (routine.lockedUntil && routine.lockedUntil.getTime() >= now.getTime()) return { outcome: "busy", reason: "locked" };
  return { outcome: "busy", reason: scheduled ? "not_due" : "locked" };
}

/**
 * Takes the lock, runs, gives the lock back. The cron and "run now" both come
 * through here, so two of them at the same instant make one run.
 *
 * A scheduled run moves nextRunAt to the next occurrence after now IN THE
 * STATEMENT THAT TAKES THE LOCK, before any step: if the run crashes or the
 * function is killed, the routine is not due any more and nothing is sent a
 * second time by the next firing. A manual run leaves the schedule as it is.
 *
 * Two cases put the schedule back:
 *   - nothing started (the run could not even be recorded): the occurrence
 *     is not lost, nextRunAt is set back to what it was and the lock given
 *     back. When that fails too, the next firing traces the run that never
 *     was (traceLostRuns);
 *   - the run stopped for lack of time with rows left: the routine is due
 *     again at once, for the next firing of the cron, MAX_RESUMES_PER_SLOT
 *     times per occurrence of the schedule.
 *
 * With less than minStartMs() left before the deadline, nothing is started
 * and nothing is touched: the routine stays due for the next firing.
 */
export async function runLocked(
  routineId: string,
  opts: { trigger: "schedule" | "manual"; startedById?: string | null; now?: Date; deadlineAt?: number; clock?: () => number },
): Promise<LockedRun> {
  const clock = opts.clock ?? Date.now;
  const now = opts.now ?? new Date(clock());
  const scheduled = opts.trigger === "schedule";

  const before = await getRoutine(routineId);
  if (!before) return { outcome: "busy", reason: "not_found" };
  if (before.status !== "active") return { outcome: "busy", reason: "not_active", status: before.status };
  if (opts.deadlineAt !== undefined) {
    const neededMs = minStartMs(before);
    if (opts.deadlineAt - clock() < neededMs) return { outcome: "postponed", neededMs };
  }
  const schedule = parseStoredSchedule(before.scheduleJson);
  const following = schedule.ok ? computeNextRunAt(schedule.value, before.timezone, now) : null;

  const lock = await acquireRunLock(routineId, now, scheduled ? { due: true, advance: { from: before.nextRunAt, to: following } } : {});
  if (!lock) return whyBusy(routineId, now, scheduled);

  /** What the lock is given back with; undefined leaves the schedule as the lock set it. */
  let next: { nextRunAt: Date | null } | undefined;
  let begun = false;
  try {
    // The lock taken over was one that expired with no run traced: the run that never was is traced first.
    await traceLostRun(before, now, false).catch(() => false);
    // A run of this routine that never ended is closed before a new one starts.
    await closeInterruptedRuns(now, { routineId }).catch(() => {});
    const routine = await getRoutine(routineId);
    if (!routine) return { outcome: "busy", reason: "not_found" };
    if (routine.status !== "active") return { outcome: "busy", reason: "not_active", status: routine.status };

    if (scheduled && catchUpDecision(before.nextRunAt, now) === "missed") {
      await recordMissedRun(routine, before.nextRunAt!, now);
      begun = true;
      return { outcome: "missed", nextRunAt: following };
    }
    begun = true;
    const result = await runRoutine(routine, { mode: "live", trigger: opts.trigger, startedById: opts.startedById ?? null, now, deadlineAt: opts.deadlineAt, clock });

    // Out of time with rows left: due again for the next firing, a few times per occurrence.
    if (scheduled && schedule.ok && result.timedOut && result.deferred > 0 && !result.autoDisabled) {
      const slot = lastOccurrenceAt(schedule.value, before.timezone, now) ?? now;
      const runs = await countScheduledRunsSince(routineId, slot).catch(() => Number.MAX_SAFE_INTEGER);
      if (runs <= MAX_RESUMES_PER_SLOT) {
        next = { nextRunAt: now };
        return { outcome: "ran", result, nextRunAt: now };
      }
    }
    // Switched off: recordRunOutcome has emptied nextRunAt, it stays empty.
    return { outcome: "ran", result, nextRunAt: result.autoDisabled ? null : scheduled ? following : routine.nextRunAt };
  } catch (e) {
    // Nothing started: the occurrence is not lost, the schedule goes back to what it was.
    if (scheduled && (!begun || e instanceof RunNotStartedError)) next = { nextRunAt: before.nextRunAt };
    throw e;
  } finally {
    // Otherwise the schedule has moved already: on a crash the run is not started again, it is closed as interrupted.
    await releaseRunLock(lock, next).catch(() => {});
  }
}
