/**
 * Routines — database access (Routine, RoutineRun, RoutineItem, RoutineEvent).
 *
 * Two guards live here and nowhere else:
 *
 *   - the run lock. A routine is taken by one conditional updateMany on
 *     `lockedUntil`: of two callers at the same instant, the database lets a
 *     single one through (count === 1). The lock expires by itself, so a
 *     function killed by the platform never blocks a routine for good.
 *
 *   - the item reservation. Before anything is created on a platform, the
 *     item is inserted in RoutineItem, unique per routine and key. The
 *     database is the reference: a key already created is never created
 *     again, and one whose outcome is unknown (reserved, never settled) turns
 *     `uncertain` and waits for a person.
 *
 * The API routes and the engine go through this module; none of them writes
 * these tables directly. It imports no step handler.
 */

import type { Prisma, Routine, RoutineRun } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { initialChatJson, type RoutinePage } from "@/lib/routines/context";
import { hashDefinition } from "@/lib/routines/hash";
import { effectiveRole } from "@/lib/roles";
import { bindingOutOfScope, getAccountScope } from "@/lib/scope";
import {
  DEFAULT_TIMEZONE, MAX_CONSECUTIVE_FAILURES, MAX_ITEM_ATTEMPTS, WRITE_COUNT_KEYS, emptyCounts,
  type ItemClaim, type RoutineDefinition, type RoutineEventKind, type RoutineStatus, type RunStatus, type RunTrigger, type Schedule,
  type StepResult, type WriteCounts,
} from "@/lib/routines/types";

export { MAX_ITEM_ATTEMPTS };

export type RoutineRecord = Routine;
export type RoutineRunRecord = RoutineRun;

/** Who does something, for the audit trail. `role` is the real one (session.baseRole). */
export interface Actor { userId: string | null; email?: string | null; role?: string | null }

/** A run holds its lock a little longer than the 300 s a function may live. */
export const LOCK_TTL_MS = 330_000;
const MAX_ERROR_CHARS = 2000;
const MAX_DETAIL_CHARS = 4000;

const clip = (text: string | null | undefined, max: number) => (text ? text.slice(0, max) : null);

// ── Routines ─────────────────────────────────────────────────────────────

export interface CreateRoutineInput {
  name: string;
  clientName: string;
  dashboardId: string | null;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  timezone?: string;
  /** Facebook Page chosen in the form, for the AI that writes the routine. Kept in chatJson. */
  page?: RoutinePage | null;
}

export async function createRoutine(input: CreateRoutineInput, actor: Actor): Promise<RoutineRecord> {
  const routine = await prisma.routine.create({
    data: {
      name: input.name,
      status: "draft",
      createdById: actor.userId ?? "",
      createdByEmail: actor.email ?? null,
      dashboardId: input.dashboardId,
      clientName: input.clientName || "—",
      metaAccountId: input.metaAccountId,
      googleCustomerId: input.googleCustomerId,
      timezone: input.timezone ?? DEFAULT_TIMEZONE,
      chatJson: initialChatJson({ page: input.page ?? undefined }),
    },
  });
  await logEvent(routine.id, "created", actor, input.page ? { detail: `Page Facebook choisie : ${input.page.name} (${input.page.id})` } : {});
  return routine;
}

export function getRoutine(id: string): Promise<RoutineRecord | null> {
  return prisma.routine.findUnique({ where: { id } });
}

export function listRoutines(opts: { includeArchived?: boolean; dashboardId?: string; take?: number } = {}): Promise<RoutineRecord[]> {
  return prisma.routine.findMany({
    where: {
      ...(opts.includeArchived ? {} : { status: { not: "archived" } }),
      ...(opts.dashboardId ? { dashboardId: opts.dashboardId } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: Math.min(opts.take ?? 200, 500),
  });
}

export async function renameRoutine(id: string, name: string): Promise<void> {
  await prisma.routine.updateMany({ where: { id, status: { not: "archived" } }, data: { name } });
}

/**
 * Moves a routine from one of the `from` statuses to `to`, in one conditional
 * update. False when the routine was not in one of them (someone was faster).
 */
export async function setStatus(
  id: string, from: readonly RoutineStatus[], to: RoutineStatus,
  data: Prisma.RoutineUpdateManyMutationInput = {},
  /** Further conditions, e.g. the hash the caller has just checked. */
  only: { definitionHash?: string; dryRunHash?: string } = {},
): Promise<boolean> {
  const { count } = await prisma.routine.updateMany({ where: { id, status: { in: [...from] }, ...only }, data: { ...data, status: to } });
  return count === 1;
}

export interface AppliedDefinition {
  name: string;
  description: string;
  schedule: Schedule;
  definition: RoutineDefinition;
  maxItemsPerRun: number;
  /** writesPlatform(definition.steps), from the step registry. */
  writesPlatform: boolean;
}

/**
 * Stores a validated definition. The routine goes back to `ready`, leaves the
 * schedule and loses its dry run: it has to be tried again before activation.
 * Returns the new hash, or null when the routine is archived or gone.
 */
export async function applyDefinition(id: string, applied: AppliedDefinition, actor: Actor): Promise<string | null> {
  // The accounts and the timezone are those of the routine, fixed when it was created: they are part of the fingerprint.
  const routine = await prisma.routine.findUnique({ where: { id }, select: { metaAccountId: true, googleCustomerId: true, timezone: true } });
  if (!routine) return null;
  const definitionHash = hashDefinition({
    definition: applied.definition, schedule: applied.schedule, maxItemsPerRun: applied.maxItemsPerRun,
    metaAccountId: routine.metaAccountId, googleCustomerId: routine.googleCustomerId, timezone: routine.timezone,
  });
  const { count } = await prisma.routine.updateMany({
    // Conditional on what was hashed: an account changed meanwhile leaves the definition unapplied.
    where: { id, status: { not: "archived" }, metaAccountId: routine.metaAccountId, googleCustomerId: routine.googleCustomerId, timezone: routine.timezone },
    data: {
      name: applied.name,
      description: applied.description || null,
      definitionJson: JSON.stringify(applied.definition),
      definitionHash,
      scheduleJson: JSON.stringify(applied.schedule),
      maxItemsPerRun: applied.maxItemsPerRun,
      writesPlatform: applied.writesPlatform,
      status: "ready",
      nextRunAt: null,
      dryRunHash: null,
      dryRunAt: null,
      activatedById: null,
      activatedAt: null,
      consecutiveFailures: 0,
    },
  });
  if (count !== 1) return null;
  await logEvent(id, "definition_applied", actor, { definitionHash });
  return definitionHash;
}

/** Remembers which definition the last successful dry run has checked. */
export async function recordDryRun(id: string, definitionHash: string, at: Date, actor: Actor, detail?: string): Promise<void> {
  await prisma.routine.updateMany({ where: { id }, data: { dryRunHash: definitionHash, dryRunAt: at } });
  await logEvent(id, "dry_run", actor, { definitionHash, detail });
}

export async function logEvent(
  routineId: string, kind: RoutineEventKind, actor: Actor,
  extra: { definitionHash?: string | null; detail?: string | null } = {},
): Promise<void> {
  await prisma.routineEvent.create({
    data: {
      routineId, kind,
      userId: actor.userId ?? null,
      userEmail: actor.email ?? null,
      userRole: actor.role ?? null,
      definitionHash: extra.definitionHash ?? null,
      detail: clip(extra.detail, MAX_DETAIL_CHARS),
    },
  });
}

/** Adds a line to the latest event of a kind (what was done about it, after the fact). */
export async function noteOnLastEvent(routineId: string, kind: RoutineEventKind, note: string): Promise<void> {
  const last = await prisma.routineEvent.findFirst({ where: { routineId, kind }, orderBy: { createdAt: "desc" }, select: { id: true, detail: true } });
  if (!last) return;
  await prisma.routineEvent.update({ where: { id: last.id }, data: { detail: clip([last.detail, note].filter(Boolean).join(" "), MAX_DETAIL_CHARS) } });
}

const bareMeta = (id: string) => id.trim().replace(/^act_/, "");
const bareGoogle = (id: string) => id.trim().replace(/-/g, "");

/**
 * Internal Slack channel of the agency for the client of a routine: the one
 * the automatic alerts already post in (AlertClient, lib/auto-alerts). Found
 * by the ad accounts of the routine, then by its dashboard. Null when the
 * client has no channel: nothing is guessed, and never a channel written in
 * the routine itself, which may be one the client reads.
 */
export async function internalChannelFor(
  routine: Pick<RoutineRecord, "dashboardId" | "metaAccountId" | "googleCustomerId">,
): Promise<string | null> {
  const meta = routine.metaAccountId ? bareMeta(routine.metaAccountId) : null;
  const google = routine.googleCustomerId ? bareGoogle(routine.googleCustomerId) : null;
  if (!meta && !google && !routine.dashboardId) return null;
  const clients = await prisma.alertClient.findMany({
    where: { gone: false },
    select: { accountsJson: true, dashboardId: true, slackChannel: true, slackChannelId: true },
  });
  const holds = (json: string): boolean => {
    const accounts = parseJson(json, []);
    if (!Array.isArray(accounts)) return false;
    return accounts.some((a) => {
      if (!a || typeof a !== "object") return false;
      const { platform, accountId } = a as { platform?: unknown; accountId?: unknown };
      if (typeof accountId !== "string") return false;
      return (platform === "meta" && !!meta && bareMeta(accountId) === meta) || (platform === "google" && !!google && bareGoogle(accountId) === google);
    });
  };
  const withChannel = clients.filter((c) => c.slackChannelId || c.slackChannel);
  const found = withChannel.find((c) => holds(c.accountsJson))
    ?? (routine.dashboardId ? withChannel.find((c) => c.dashboardId === routine.dashboardId) : undefined);
  return found ? found.slackChannelId || found.slackChannel : null;
}

/** The session as the audit trail wants it. */
export function actorOf(session: { userId: string; baseRole?: string | null; role?: string | null; user?: { email?: string | null } | null }): Actor {
  return { userId: session.userId, email: session.user?.email ?? null, role: session.baseRole ?? session.role ?? null };
}

/**
 * Loads a routine for a staff session: 404 when it does not exist, 403 when
 * one of its ad accounts is outside the person's scope (lib/scope.ts).
 */
export async function routineForSession(
  session: { userId: string; role?: string | null }, id: string,
): Promise<{ status: 200; routine: RoutineRecord } | { status: 403 | 404 }> {
  if (typeof id !== "string" || !/^[a-z0-9]{8,40}$/i.test(id)) return { status: 404 };
  const routine = await getRoutine(id);
  if (!routine) return { status: 404 };
  const scope = await getAccountScope(session);
  return bindingOutOfScope(scope, routine) ? { status: 403 } : { status: 200, routine };
}

// ── Run lock ─────────────────────────────────────────────────────────────

export interface RunLock { routineId: string; lockedUntil: Date }

/**
 * Takes an active routine for a run. `due` restricts to a routine whose
 * nextRunAt has come (the cron); "run now" leaves it out. Null = not taken:
 * already running, not active, or not due any more.
 *
 * `advance` moves nextRunAt in the SAME statement as the lock, before any step
 * runs: whatever happens to the run after that (crash, function killed by the
 * platform), the routine is no longer due and the next firing of the cron does
 * not start it again. `from` is the nextRunAt the caller has read and computed
 * `to` from: changed meanwhile, the lock is not taken.
 */
export async function acquireRunLock(
  id: string, now: Date,
  opts: { due?: boolean; ttlMs?: number; advance?: { from: Date | null; to: Date | null } } = {},
): Promise<RunLock | null> {
  const lockedUntil = new Date(now.getTime() + (opts.ttlMs ?? LOCK_TTL_MS));
  const { count } = await prisma.routine.updateMany({
    where: {
      id,
      status: "active",
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      ...(opts.due ? { AND: [{ nextRunAt: { lte: now } }, ...(opts.advance ? [{ nextRunAt: opts.advance.from }] : [])] } : {}),
    },
    data: { lockedUntil, ...(opts.advance ? { nextRunAt: opts.advance.to } : {}) },
  });
  return count === 1 ? { routineId: id, lockedUntil } : null;
}

/**
 * Gives the lock back, and sets the next run when the caller computed one.
 * Conditional on the lock still being ours: a lock that expired and was taken
 * by another run is left alone.
 */
export async function releaseRunLock(lock: RunLock, next?: { nextRunAt: Date | null }): Promise<boolean> {
  const { count } = await prisma.routine.updateMany({
    where: { id: lock.routineId, lockedUntil: lock.lockedUntil },
    data: { lockedUntil: null, ...(next ? { nextRunAt: next.nextRunAt } : {}) },
  });
  return count === 1;
}

/** Active routines whose time has come and that nobody is running, oldest first. */
export async function dueRoutineIds(now: Date, take = 50): Promise<string[]> {
  const rows = await prisma.routine.findMany({
    where: { status: "active", nextRunAt: { lte: now }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    orderBy: { nextRunAt: "asc" },
    select: { id: true },
    take,
  });
  return rows.map((r) => r.id);
}

/**
 * The person who answers for a scheduled run (who activated the routine, its
 * author otherwise) must still be staff and still have the accounts of the
 * routine in scope. Null when all is well, the reason otherwise.
 */
export async function ownerProblem(routine: Pick<RoutineRecord, "createdById" | "activatedById" | "metaAccountId" | "googleCustomerId">): Promise<string | null> {
  const userId = routine.activatedById || routine.createdById;
  const user = userId ? await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } }) : null;
  if (!user) return "La personne qui a activé la routine n'a plus de compte.";
  const role = effectiveRole(user.role);
  if (role !== "admin" && role !== "consultant") return "La personne qui a activé la routine ne fait plus partie de l'équipe.";
  const outside = bindingOutOfScope(await getAccountScope({ userId: user.id, role }), routine);
  return outside ? `Le compte ${outside} n'est plus dans le périmètre de la personne qui a activé la routine.` : null;
}

/** E-mail of the person who answers for the routine: who activated it, its author otherwise. */
export async function ownerEmail(routine: Pick<RoutineRecord, "createdById" | "createdByEmail" | "activatedById">): Promise<string | null> {
  if (!routine.activatedById || routine.activatedById === routine.createdById) return routine.createdByEmail;
  const user = await prisma.user.findUnique({ where: { id: routine.activatedById }, select: { email: true } }).catch(() => null);
  return user?.email ?? routine.createdByEmail;
}

// ── Items ────────────────────────────────────────────────────────────────

export type ClaimResult = ItemClaim;

const UNKNOWN_OUTCOME = "Réservé par une exécution précédente, résultat inconnu : à vérifier sur la plateforme.";
const KNOWN_OBJECT = "L'objet existe sur la plateforme sous cet identifiant : il est relu, jamais créé de nouveau.";

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
}

interface StoredItem { id: string; status: string; externalId: string | null; error: string | null; attempts: number }

/** What a stored item answers to a reservation that does not change it. */
function answerOf(item: StoredItem): ItemClaim {
  const known = item.externalId ? { externalId: item.externalId } : {};
  const error = item.error ? { error: item.error } : {};
  if (item.status === "created") return { state: "already_done", ...known, attempts: item.attempts };
  // An item that carries an external id is never played again, whatever its status.
  if (item.externalId) return { state: "uncertain", ...known, ...error, attempts: item.attempts };
  if (item.status === "failed") {
    return item.attempts >= MAX_ITEM_ATTEMPTS
      ? { state: "abandoned", ...error, attempts: item.attempts }
      : { state: "claimed", attempts: item.attempts + 1 };
  }
  return { state: "uncertain", ...error, attempts: item.attempts };
}

/**
 * Reserves an item before the platform call. The insert is the guard: the
 * unique constraint lets one caller through. For a key that exists already:
 *   created                  → already_done
 *   any status + externalId  → uncertain, and stored so (the object exists: read it, never create another)
 *   pending, uncertain       → uncertain (outcome unknown, never created again by the routine)
 *   failed, no externalId    → claimed again, up to MAX_ITEM_ATTEMPTS attempts, then abandoned
 */
export async function claimItem(args: { routineId: string; runId: string; stepId: string; itemKey: string; label: string }): Promise<ItemClaim> {
  const { routineId, runId, stepId, itemKey } = args;
  if (!itemKey) throw new Error("Clé d'élément vide : réservation refusée");
  const label = clip(args.label, 300);
  try {
    await prisma.routineItem.create({ data: { routineId, runId, stepId, itemKey, label, status: "pending" } });
    return { state: "claimed", attempts: 1 };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
  const existing = await prisma.routineItem.findUnique({ where: { routineId_itemKey: { routineId, itemKey } } });
  if (!existing) return { state: "uncertain" };
  const answer = answerOf(existing);
  if (answer.state === "claimed") {
    const { count } = await prisma.routineItem.updateMany({
      where: { id: existing.id, status: "failed", externalId: null, attempts: existing.attempts },
      data: { status: "pending", runId, stepId, label, error: null, attempts: { increment: 1 } },
    });
    return count === 1 ? answer : { state: "uncertain" };
  }
  if (answer.state === "uncertain" && existing.status !== "uncertain") {
    await prisma.routineItem.updateMany({
      where: { id: existing.id, status: existing.status },
      data: { status: "uncertain", ...(existing.externalId ? (existing.error ? {} : { error: KNOWN_OBJECT }) : { error: UNKNOWN_OUTCOME }) },
    });
  }
  return answer;
}

/** Same answer as claimItem, without touching anything: what a dry run uses. */
export async function peekItem(routineId: string, itemKey: string): Promise<ItemClaim> {
  const existing = await prisma.routineItem.findUnique({ where: { routineId_itemKey: { routineId, itemKey } } });
  return existing ? answerOf(existing) : { state: "claimed", attempts: 1 };
}

/**
 * Closes a reservation. Only a pending item can be settled. A failure that
 * carries an external id is stored `uncertain`: the object exists on the
 * platform, the item must never come back as one to create.
 */
export async function settleItem(args: { routineId: string; itemKey: string; status: "created" | "failed"; externalId?: string; error?: string }): Promise<boolean> {
  const status = args.status === "failed" && args.externalId ? "uncertain" : args.status;
  const { count } = await prisma.routineItem.updateMany({
    where: { routineId: args.routineId, itemKey: args.itemKey, status: "pending" },
    data: { status, externalId: args.externalId ?? null, error: clip(args.error, MAX_ERROR_CHARS) },
  });
  return count === 1;
}

/**
 * An item whose object was read again by its id and found as wanted (the ad
 * is there, paused): `uncertain` → `created`. Conditional on the id read being
 * the one stored.
 */
export async function confirmItem(args: { routineId: string; itemKey: string; externalId: string }): Promise<boolean> {
  if (!args.externalId) return false;
  const { count } = await prisma.routineItem.updateMany({
    where: { routineId: args.routineId, itemKey: args.itemKey, externalId: args.externalId, status: { in: ["uncertain", "failed"] } },
    data: { status: "created", error: null },
  });
  return count === 1;
}

/** Reservations a run never settled: their outcome is unknown. Returns how many. */
export async function markUnsettledUncertain(runId: string): Promise<number> {
  const { count } = await prisma.routineItem.updateMany({
    where: { runId, status: "pending" },
    data: { status: "uncertain", error: "Exécution terminée sans résultat pour cet élément : à vérifier sur la plateforme." },
  });
  return count;
}

// ── Runs ─────────────────────────────────────────────────────────────────

export async function startRun(args: { routineId: string; trigger: RunTrigger; definitionHash: string; startedById: string | null; startedAt: Date }): Promise<string> {
  const run = await prisma.routineRun.create({
    data: {
      routineId: args.routineId, trigger: args.trigger, status: "running",
      definitionHash: args.definitionHash, startedById: args.startedById, startedAt: args.startedAt,
    },
    select: { id: true },
  });
  return run.id;
}

/**
 * Closes a run that is still `running`, and only such a run: the engine that
 * ends late does not rewrite a run the cron has closed as interrupted, and the
 * other way round. False when the run was closed already.
 */
export async function closeRun(runId: string, done: { status: Exclude<RunStatus, "running">; finishedAt: Date; durationMs: number; error: string }): Promise<boolean> {
  const { count } = await prisma.routineRun.updateMany({
    where: { id: runId, status: "running" },
    data: { status: done.status, finishedAt: done.finishedAt, durationMs: Math.max(0, Math.round(done.durationMs)), error: clip(done.error, MAX_ERROR_CHARS) },
  });
  return count === 1;
}

/** Runs still `running` that started before `before`, oldest first. */
export function runningRunsBefore(before: Date, opts: { routineId?: string; take?: number } = {}): Promise<RoutineRunRecord[]> {
  return prisma.routineRun.findMany({
    where: { status: "running", startedAt: { lt: before }, ...(opts.routineId ? { routineId: opts.routineId } : {}) },
    orderBy: { startedAt: "asc" },
    take: opts.take ?? 50,
  });
}

/** The last live runs of a routine (scheduled or by hand), most recent first. */
export function lastLiveRuns(routineId: string, take: number): Promise<RoutineRunRecord[]> {
  return prisma.routineRun.findMany({
    where: { routineId, trigger: { in: ["schedule", "manual"] } },
    orderBy: { startedAt: "desc" },
    take,
  });
}

/** Switches a routine off outside the count of functional failures (runs interrupted again and again). */
export async function switchOff(routineId: string, definitionHash: string, detail: string): Promise<boolean> {
  const disabled = await setStatus(routineId, ["active"], "error", { nextRunAt: null, dryRunHash: null, dryRunAt: null });
  if (disabled) await logEvent(routineId, "auto_disabled", { userId: null }, { definitionHash, detail });
  return disabled;
}

/** Status of the last run, written on the routine without touching the count of failures. */
export async function noteLastRun(routineId: string, at: Date, status: RunStatus): Promise<void> {
  // Only when no later run has written its own outcome.
  await prisma.routine.updateMany({
    where: { id: routineId, OR: [{ lastRunAt: null }, { lastRunAt: { lt: at } }] },
    data: { lastRunAt: at, lastRunStatus: status },
  });
}

export interface FinishedRun {
  status: Exclude<RunStatus, "running" | "missed">;
  finishedAt: Date;
  durationMs: number;
  totals: { planned: number; created: number; skipped: number; failed: number };
  /** Already compacted by the engine: a few rows per step, not the whole data. */
  steps: StepResult[];
  error?: string | null;
}

/** False when the run was no longer `running`: closed as interrupted meanwhile, its record is left as it is. */
export async function finishRun(runId: string, done: FinishedRun): Promise<boolean> {
  const { count } = await prisma.routineRun.updateMany({
    where: { id: runId, status: "running" },
    data: {
      status: done.status,
      finishedAt: done.finishedAt,
      durationMs: Math.max(0, Math.round(done.durationMs)),
      itemsPlanned: done.totals.planned,
      itemsCreated: done.totals.created,
      itemsSkipped: done.totals.skipped,
      itemsFailed: done.totals.failed,
      stepsJson: JSON.stringify(done.steps),
      error: clip(done.error, MAX_ERROR_CHARS),
    },
  });
  return count === 1;
}

/** A scheduled run that was too late to start (more than 12 hours). */
export async function recordMissedRun(routine: Pick<RoutineRecord, "id" | "definitionHash">, dueAt: Date, now: Date): Promise<void> {
  await prisma.routineRun.create({
    data: {
      routineId: routine.id, trigger: "schedule", status: "missed", definitionHash: routine.definitionHash,
      startedAt: now, finishedAt: now,
      error: `Exécution prévue le ${dueAt.toISOString()} non lancée : retard de plus de 12 heures.`,
    },
  });
  await prisma.routine.updateMany({ where: { id: routine.id }, data: { lastRunAt: now, lastRunStatus: "missed" } });
}

/**
 * none        nothing failed: the count of consecutive failures goes back to 0
 * functional  the run failed as a whole, and it is the routine's fault: counts
 * infra       relay, network, quota, run interrupted: the count is left as it is
 * partial     something was written, or only items failed (each bounded by
 *             its own attempts): the count is left as it is
 */
export type FailureKind = "none" | "functional" | "infra" | "partial";

/**
 * Writes the outcome of a live run on the routine and keeps the count of
 * consecutive functional failures: reset by a run without failure, untouched
 * by an infrastructure failure and by a partial run. At the third one the
 * routine is switched off (status `error`, dry run forgotten) and the event
 * `auto_disabled` is logged.
 */
export async function recordRunOutcome(args: {
  routineId: string; status: RunStatus; failure: FailureKind; at: Date; definitionHash: string; message?: string | null;
}): Promise<{ consecutiveFailures: number; autoDisabled: boolean }> {
  const base = { lastRunAt: args.at, lastRunStatus: args.status };
  if (args.failure !== "functional") {
    const updated = await prisma.routine.update({
      where: { id: args.routineId },
      data: args.failure === "none" ? { ...base, consecutiveFailures: 0 } : base,
      select: { consecutiveFailures: true },
    });
    return { consecutiveFailures: updated.consecutiveFailures, autoDisabled: false };
  }
  const updated = await prisma.routine.update({
    where: { id: args.routineId },
    data: { ...base, consecutiveFailures: { increment: 1 } },
    select: { consecutiveFailures: true },
  });
  if (updated.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return { consecutiveFailures: updated.consecutiveFailures, autoDisabled: false };
  const disabled = await setStatus(args.routineId, ["active"], "error", { nextRunAt: null, dryRunHash: null, dryRunAt: null });
  if (disabled) {
    await logEvent(args.routineId, "auto_disabled", { userId: null }, {
      definitionHash: args.definitionHash,
      detail: `${updated.consecutiveFailures} échecs consécutifs. Dernier : ${args.message ?? "sans message"}`,
    });
  }
  return { consecutiveFailures: updated.consecutiveFailures, autoDisabled: disabled };
}

export async function listRuns(routineId: string, opts: { page: number; pageSize: number }): Promise<{ runs: RoutineRunRecord[]; total: number }> {
  const [runs, total] = await Promise.all([
    prisma.routineRun.findMany({
      where: { routineId },
      orderBy: { startedAt: "desc" },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
    }),
    prisma.routineRun.count({ where: { routineId } }),
  ]);
  return { runs, total };
}

// ── What the API returns ─────────────────────────────────────────────────

function parseJson(json: string | null | undefined, fallback: unknown): unknown {
  try { return JSON.parse(json || ""); } catch { return fallback; }
}

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);

/** A routine as the interface reads it: JSON columns parsed, dates in epoch ms, no conversation. */
export function routineView(r: RoutineRecord) {
  return {
    id: r.id, name: r.name, description: r.description ?? "", status: r.status as RoutineStatus,
    createdById: r.createdById, createdByEmail: r.createdByEmail,
    dashboardId: r.dashboardId, clientName: r.clientName,
    metaAccountId: r.metaAccountId, googleCustomerId: r.googleCustomerId,
    definition: parseJson(r.definitionJson, {}) as Partial<RoutineDefinition>,
    definitionHash: r.definitionHash,
    schedule: parseJson(r.scheduleJson, {}) as Partial<Schedule>,
    timezone: r.timezone, maxItemsPerRun: r.maxItemsPerRun, writesPlatform: r.writesPlatform,
    nextRunAt: ms(r.nextRunAt), lastRunAt: ms(r.lastRunAt), lastRunStatus: r.lastRunStatus,
    consecutiveFailures: r.consecutiveFailures,
    running: !!r.lockedUntil && r.lockedUntil.getTime() > Date.now(),
    dryRunAt: ms(r.dryRunAt),
    /** The last successful dry run covers the definition as it is now. */
    dryRunValid: !!r.dryRunHash && !!r.definitionHash && r.dryRunHash === r.definitionHash,
    activatedById: r.activatedById, activatedAt: ms(r.activatedAt),
    createdAt: r.createdAt.getTime(), updatedAt: r.updatedAt.getTime(),
  };
}
export type RoutineView = ReturnType<typeof routineView>;

export function runView(r: RoutineRunRecord) {
  const parsed = parseJson(r.stepsJson, []);
  const steps = (Array.isArray(parsed) ? parsed : []) as StepResult[];
  return {
    id: r.id, routineId: r.routineId, trigger: r.trigger as RunTrigger, status: r.status as RunStatus,
    definitionHash: r.definitionHash, startedById: r.startedById,
    startedAt: r.startedAt.getTime(), finishedAt: ms(r.finishedAt), durationMs: r.durationMs,
    totals: { planned: r.itemsPlanned, created: r.itemsCreated, skipped: r.itemsSkipped, failed: r.itemsFailed },
    counts: sumCounts(steps),
    steps,
    error: r.error,
    timedOut: steps.some((s) => s?.timedOut === true),
  };
}

/** Counters by nature of write, added over the steps kept in stepsJson. */
export function sumCounts(steps: ReadonlyArray<Pick<StepResult, "counts"> | null | undefined>): WriteCounts {
  const total = emptyCounts();
  for (const step of steps) {
    const counts = step && typeof step === "object" ? step.counts : undefined;
    if (!counts || typeof counts !== "object") continue;
    for (const key of WRITE_COUNT_KEYS) {
      const n = (counts as Partial<WriteCounts>)[key];
      if (typeof n === "number" && Number.isFinite(n) && n > 0) total[key] += Math.round(n);
    }
  }
  return total;
}
export type RunView = ReturnType<typeof runView>;
