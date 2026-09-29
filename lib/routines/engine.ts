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
 *   - failures are sorted: functional (the routine is wrong) or infrastructure
 *     (relay, network, quota). Three functional failures in a row switch the
 *     routine off; an infrastructure failure never does.
 */

import { hashDefinition } from "@/lib/routines/hash";
import { notifyAutoDisabled } from "@/lib/routines/notify";
import { catchUpDecision, computeNextRunAt } from "@/lib/routines/schedule";
import { handlerFor } from "@/lib/routines/steps";
import {
  acquireRunLock, claimItem, finishRun, forgetDeferred, getRoutine, internalChannelFor, markUnsettledUncertain, noteDeferred, noteOnLastEvent, ownerProblem,
  ownerEmail, peekItem, recordMissedRun, recordRunOutcome, releaseRunLock, settleItem, startRun,
  type FailureKind, type RoutineRecord,
} from "@/lib/routines/store";
import { parseStoredDefinition, parseStoredSchedule, resolveInputId, stepDependencies } from "@/lib/routines/validate";
import { mintWriteGuard } from "@/lib/routines/write-guard";
import {
  MAX_ITEMS_PER_RUN_CAP, RUN_BUDGET_MS,
  type ErrorClass, type RoutineDefinition, type RoutineStep, type RunMode, type RunResult, type RunTrigger,
  type Schedule, type StepContext, type StepOutput, type StepResult, type StepRunOutcome, type WriteGuard,
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
  /** Items left for the next run (ceiling or time budget). */
  deferred: number;
  consecutiveFailures: number;
  autoDisabled: boolean;
}

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
  if (status === "failed") {
    result.error = {
      class: o.error?.class === "infra" ? "infra" : "functional",
      message: typeof o.error?.message === "string" && o.error.message ? o.error.message.slice(0, 500) : "L'étape a échoué sans message.",
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
  const hash = hashDefinition({ definition: definition.value, schedule: schedule.value, maxItemsPerRun: routine.maxItemsPerRun });
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

  const runId = await startRun({
    routineId: routine.id, trigger, definitionHash: routine.definitionHash,
    startedById: opts.startedById ?? null, startedAt: now,
  });

  const steps: StepResult[] = [];
  const outputs: Record<string, StepOutput> = {};
  const totals = { planned: 0, created: 0, skipped: 0, failed: 0 };
  let claims = 0;
  let deferred = 0;
  let timedOut = false;
  let fatal: { class: ErrorClass; message: string } | null = null;

  const loaded = loadDefinition(routine);
  if (!loaded.ok) fatal = { class: "functional", message: loaded.error };
  if (!fatal && trigger === "schedule") {
    try {
      const problem = await ownerProblem(routine);
      if (problem) fatal = { class: "functional", message: problem };
    } catch (e) {
      fatal = { class: "infra", message: `Vérification du périmètre impossible : ${errorMessage(e)}` };
    }
  }

  // One guard per live run, none in a dry run.
  const guard = mode === "live" ? mintWriteGuard("live", runId) : null;

  const context = (input: StepContext["input"]): StepContext => ({
    mode,
    routine: {
      id: routine.id, name: routine.name, metaAccountId: routine.metaAccountId, googleCustomerId: routine.googleCustomerId,
      timezone: routine.timezone, maxItemsPerRun: cap,
      clientName: routine.clientName, dashboardId: routine.dashboardId,
    },
    runId, now, deadlineAt, input,
    // Each step sees the outputs of the steps before it, and cannot change them for the next ones.
    outputs: { ...outputs },
    write: guard,
    async claimItem(stepId, itemKey, label) {
      const full = claims >= cap || clock() >= deadlineAt;
      if (mode !== "live") {
        const seen = await peekItem(routine.id, itemKey);
        if (seen !== "claimed") { totals.skipped++; return seen; }
        if (full) { deferred++; noteDeferred(runId, itemKey); return "already_done"; }
        claims++;
        return "claimed";
      }
      if (full) { deferred++; noteDeferred(runId, itemKey); return "already_done"; }
      const got = await claimItem({ routineId: routine.id, runId, stepId, itemKey, label });
      if (got === "claimed") claims++; else totals.skipped++;
      return got;
    },
    async settleItem(_stepId, itemKey, r) {
      if (mode !== "live") return;
      const settled = await settleItem({ routineId: routine.id, itemKey, status: r.status, externalId: r.externalId, error: r.error });
      if (settled && r.status === "failed") totals.failed++;
    },
  });

  if (loaded.ok && !fatal) {
    const list = loaded.value.definition.steps;
    for (const [index, step] of list.entries()) {
      const began = clock();
      const push = (outcome: StepRunOutcome) => {
        steps.push({ stepId: step.id, type: step.type, durationMs: Math.max(0, clock() - began), ...outcome });
        if (outcome.status === "ok") outputs[step.id] = outcome.output;
      };
      const inputId = resolveInputId(list, index);
      const input = inputId ? outputs[inputId]?.rows ?? null : null;
      const rowsIn = input?.rows.length ?? 0;

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
      const deferredBefore = deferred;
      const outcome = await runStep(step, context(input), rowsIn, deadlineAt + STEP_GRACE_MS - clock());

      if (mode !== "live" && outcome.written.length) {
        // Cannot happen with a handler that honours ctx.write; said loudly if it does.
        outcome.status = "failed";
        outcome.error = { class: "functional", message: "L'étape a déclaré une écriture pendant un essai à blanc." };
      }
      if (handler.writes === "platform") {
        if (outcome.planned.length > cap) {
          deferred += outcome.planned.length - cap;
          outcome.planned = outcome.planned.slice(0, cap);
        }
        if (outcome.written.length > cap && outcome.status !== "failed") {
          outcome.status = "failed";
          outcome.error = { class: "functional", message: `L'étape a écrit ${outcome.written.length} éléments, au-delà du plafond de ${cap}.` };
        }
      }
      if (deferred > deferredBefore) {
        outcome.warnings.push(
          clock() >= deadlineAt
            ? `${deferred - deferredBefore} élément(s) reporté(s) à la prochaine exécution : budget de temps épuisé.`
            : `${deferred - deferredBefore} élément(s) reporté(s) à la prochaine exécution : plafond de ${cap} par exécution.`,
        );
      }
      if (outcome.error?.message === STEP_TIMEOUT) timedOut = true;
      totals.planned += outcome.planned.length;
      totals.created += outcome.written.length;
      push(outcome);
    }
    if (clock() >= deadlineAt && deferred > 0) timedOut = true;
  }

  if (mode === "live") {
    try {
      const unsettled = await markUnsettledUncertain(runId);
      if (unsettled) totals.skipped += unsettled;
    } catch { /* the next claim of these keys turns them uncertain anyway */ }
  }
  forgetDeferred(runId);

  // Outcome of the run.
  const failures = steps.filter((s) => s.status === "failed");
  const functional = fatal?.class === "functional" || failures.some((s) => s.error?.class !== "infra");
  const failure: FailureKind = fatal || failures.length ? (functional ? "functional" : "infra") : "none";
  let status: RunResult["status"];
  if (failure === "none") status = timedOut || totals.failed > 0 ? "partial" : "success";
  else if (mode === "live" && totals.created > 0) status = "partial";
  else status = failure === "infra" ? "infra_failed" : "failed";
  const error = fatal?.message ?? failures[0]?.error?.message ?? null;

  const finishedAt = clock();
  await finishRun(runId, {
    status, finishedAt: new Date(now.getTime() + Math.max(0, finishedAt - startedAt)), durationMs: finishedAt - startedAt,
    totals, steps: compactSteps(steps), error,
  });

  let consecutiveFailures = routine.consecutiveFailures;
  let autoDisabled = false;
  if (mode === "live") {
    const kept = await recordRunOutcome({ routineId: routine.id, status, failure, at: now, definitionHash: routine.definitionHash, message: error });
    consecutiveFailures = kept.consecutiveFailures;
    autoDisabled = kept.autoDisabled;
    if (autoDisabled && guard) await announceAutoDisabled(guard, routine, consecutiveFailures, error);
  }

  return {
    runId, mode, status, steps, totals, timedOut,
    definitionHash: routine.definitionHash, error, deferred, consecutiveFailures, autoDisabled,
  };
}

/**
 * Says once, in the agency's channel for the client, that the routine has
 * switched itself off, and keeps what was done with the event. Whatever goes
 * wrong here, the run has ended and its result stands.
 */
async function announceAutoDisabled(guard: WriteGuard, routine: RoutineRecord, failures: number, lastError: string | null): Promise<void> {
  let detail: string;
  try {
    const channel = await internalChannelFor(routine);
    const owner = await ownerEmail(routine);
    ({ detail } = await notifyAutoDisabled(guard, {
      routine: { id: routine.id, name: routine.name, clientName: routine.clientName }, failures, lastError, owner, channel,
    }));
  } catch (e) {
    detail = `Message non envoyé : ${errorMessage(e)}`;
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

// ── Run under lock (cron and "run now") ──────────────────────────────────

export type LockedRun =
  | { outcome: "ran"; result: EngineRunResult; nextRunAt: Date | null }
  | { outcome: "missed"; nextRunAt: Date | null }
  /** Not taken: already running, not active, or (cron) not due any more. */
  | { outcome: "busy" };

/**
 * Takes the lock, runs, gives the lock back. The cron and "run now" both come
 * through here, so two of them at the same instant make one run.
 * A scheduled run moves nextRunAt to the next occurrence after now; a manual
 * run leaves the schedule as it is.
 */
export async function runLocked(
  routineId: string,
  opts: { trigger: "schedule" | "manual"; startedById?: string | null; now?: Date; deadlineAt?: number; clock?: () => number },
): Promise<LockedRun> {
  const clock = opts.clock ?? Date.now;
  const now = opts.now ?? new Date(clock());
  const scheduled = opts.trigger === "schedule";
  const lock = await acquireRunLock(routineId, now, { due: scheduled });
  if (!lock) return { outcome: "busy" };

  let next: { nextRunAt: Date | null } | undefined;
  try {
    const routine = await getRoutine(routineId);
    if (!routine) return { outcome: "busy" };
    const schedule = parseStoredSchedule(routine.scheduleJson);
    const following = schedule.ok ? computeNextRunAt(schedule.value, routine.timezone, now) : null;

    if (scheduled && catchUpDecision(routine.nextRunAt, now) === "missed") {
      await recordMissedRun(routine, routine.nextRunAt!, now);
      next = { nextRunAt: following };
      return { outcome: "missed", nextRunAt: following };
    }
    const result = await runRoutine(routine, { mode: "live", trigger: opts.trigger, startedById: opts.startedById ?? null, now, deadlineAt: opts.deadlineAt, clock });
    // Switched off: recordRunOutcome has emptied nextRunAt, it stays empty.
    if (scheduled && !result.autoDisabled) next = { nextRunAt: following };
    return { outcome: "ran", result, nextRunAt: result.autoDisabled ? null : scheduled ? following : routine.nextRunAt };
  } finally {
    // On a crash the schedule is left as it was: the routine is still due and the next cron tries again.
    await releaseRunLock(lock, next).catch(() => {});
  }
}
