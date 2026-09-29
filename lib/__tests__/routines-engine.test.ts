import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", async () => ({ prisma: (await import("./routines-engine-fakes")).db }));
vi.mock("@/lib/routines/steps/sheet-read", async () => ({ sheetReadHandler: (await import("./routines-engine-fakes")).fakeHandler("sheet.read") }));
vi.mock("@/lib/routines/steps/sheet-write", async () => ({ sheetWriteHandler: (await import("./routines-engine-fakes")).fakeHandler("sheet.write") }));
vi.mock("@/lib/routines/steps/google-insights", async () => ({ googleInsightsHandler: (await import("./routines-engine-fakes")).fakeHandler("google.insights") }));
vi.mock("@/lib/routines/steps/slack-message", async () => ({ slackMessageHandler: (await import("./routines-engine-fakes")).fakeHandler("slack.message") }));
vi.mock("@/lib/routines/steps/email-send", async () => ({ emailSendHandler: (await import("./routines-engine-fakes")).fakeHandler("email.send") }));
vi.mock("@/lib/routines/steps/meta-insights", async () => ({ metaInsightsHandler: (await import("./routines-engine-fakes")).fakeHandler("meta.insights") }));
vi.mock("@/lib/routines/steps/meta-create-ads", async () => ({ metaCreateAdsHandler: (await import("./routines-engine-fakes")).fakeHandler("meta.create_ads") }));
vi.mock("@/lib/routines/steps/ai-summary", async () => ({ aiSummaryHandler: (await import("./routines-engine-fakes")).fakeHandler("ai.summary") }));

import { classifyError, compactSteps, runLocked, runRoutine } from "@/lib/routines/engine";
import { hashDefinition } from "@/lib/routines/hash";
import { acquireRunLock, claimItem, getRoutine, peekItem, releaseRunLock, settleItem, wasDeferred, type RoutineRecord } from "@/lib/routines/store";
import { isWriteGuard } from "@/lib/routines/write-guard-check";
import type { Row, RoutineDefinition, Schedule, StepContext, StepRunOutcome } from "@/lib/routines/types";
import { behaviours, createAdsStep, db, okOutcome, readStep, resetDb, resetSteps, seen, slackStep, type Behaviour } from "./routines-engine-fakes";

const NOW = new Date("2026-09-29T08:00:00Z");
const DAILY: Schedule = { kind: "daily", time: "09:00" };

async function seed(steps: unknown[], extra: Record<string, unknown> = {}): Promise<RoutineRecord> {
  const definition = { version: 1, steps } as RoutineDefinition;
  const schedule = (extra.schedule as Schedule | undefined) ?? DAILY;
  const maxItemsPerRun = (extra.maxItemsPerRun as number | undefined) ?? 20;
  const { schedule: _s, ...columns } = extra;
  void _s;
  await db.user.create({ data: { id: "u1", role: "consultant" } }).catch(() => {});
  const row = await db.routine.create({
    data: {
      name: "Créas de la semaine", status: "active", createdById: "u1", activatedById: "u1", metaAccountId: "act_123",
      definitionJson: JSON.stringify(definition), scheduleJson: JSON.stringify(schedule), maxItemsPerRun,
      definitionHash: hashDefinition({ definition, schedule, maxItemsPerRun }),
      nextRunAt: new Date("2026-09-29T07:00:00Z"), ...columns,
    },
  });
  return row as unknown as RoutineRecord;
}
const reload = async (id: string) => (await getRoutine(id))!;

const sheetRows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `crea-${i + 1}`, nom: `Créa ${i + 1}`, statut: "à créer" }));
const reads = (n: number): Behaviour => () => okOutcome({ rowsOut: n, output: { rows: { columns: ["id", "nom", "statut"], rows: sheetRows(n), truncated: false } } });

/** External writes really made, as a platform would count them. */
let platformCalls: string[] = [];

/** What a well-behaved writing step does: reserve, write with the guard, settle. */
const createsAds: Behaviour = async (step, ctx) => {
  const out = okOutcome({ rowsIn: ctx.input?.rows.length ?? 0 });
  for (const row of ctx.input?.rows ?? []) {
    const key = `creer:${row.id}`;
    const claim = await ctx.claimItem(step.id, key, String(row.nom));
    if (claim !== "claimed") continue;
    if (!ctx.write) { out.planned.push({ target: "meta", summary: `Créer ${row.nom}`, itemKey: key, preview: { nom: row.nom } }); continue; }
    if (!isWriteGuard(ctx.write)) throw new Error("forged guard");
    platformCalls.push(key);
    await ctx.settleItem(step.id, key, { status: "created", externalId: `ad_${row.id}` });
    out.written.push({ itemKey: key, externalId: `ad_${row.id}`, summary: `Créée : ${row.nom}` });
  }
  return out;
};
const posts: Behaviour = (_step, ctx) => {
  if (!ctx.write) return okOutcome({ planned: [{ target: "slack", summary: "Message dans #client", preview: {} }] });
  platformCalls.push("slack");
  return okOutcome({ written: [{ summary: "Message envoyé" }] });
};
const fails = (cls: "functional" | "infra", message: string): Behaviour => () => ({
  status: "failed", rowsIn: 0, rowsOut: 0, output: {}, planned: [], written: [], warnings: [], error: { class: cls, message },
});

const live = (routine: RoutineRecord, extra: Partial<Parameters<typeof runRoutine>[1]> = {}) =>
  runRoutine(routine, { mode: "live", trigger: "manual", startedById: "u1", now: NOW, ...extra });
const dry = (routine: RoutineRecord) => runRoutine(routine, { mode: "dry_run", trigger: "dry_run", startedById: "u1", now: NOW });

beforeEach(() => {
  resetDb();
  resetSteps();
  platformCalls = [];
  behaviours["sheet.read"] = reads(3);
  behaviours["meta.create_ads"] = createsAds;
  behaviours["slack.message"] = posts;
});

describe("routines — dry run", () => {
  it("writes nothing: no guard, no item, nothing sent", async () => {
    const routine = await seed([readStep, createAdsStep, slackStep]);
    const before = JSON.stringify(db.routine.rows[0]);
    const result = await dry(routine);

    expect(result).toMatchObject({ mode: "dry_run", status: "success", timedOut: false, totals: { planned: 4, created: 0, skipped: 0, failed: 0 } });
    expect(seen.map((s) => s.stepId)).toEqual(["lire", "creer", "prevenir"]);
    for (const s of seen) {
      expect(s.ctx.write, s.stepId).toBeNull();
      expect(s.ctx.mode).toBe("dry_run");
    }
    expect(platformCalls).toEqual([]);
    expect(db.routineItem.rows).toEqual([]);
    expect(db.routineItem.writes).toEqual([]);
    expect(result.steps[1].planned.map((p) => p.itemKey)).toEqual(["creer:crea-1", "creer:crea-2", "creer:crea-3"]);
    expect(result.steps.every((s) => s.written.length === 0)).toBe(true);
    // The routine itself is untouched: a dry run is not a run of the schedule.
    expect(JSON.stringify(db.routine.rows[0])).toBe(before);
    expect(db.routineRun.rows).toHaveLength(1);
    expect(db.routineRun.rows[0]).toMatchObject({ trigger: "dry_run", status: "success", itemsPlanned: 4, itemsCreated: 0 });
    expect(db.routineEvent.rows).toEqual([]);
  });

  it("does not count towards the automatic stop", async () => {
    behaviours["sheet.read"] = fails("functional", "Colonne « statut » absente");
    const routine = await seed([readStep, createAdsStep]);
    for (let i = 0; i < 4; i++) expect((await dry(await reload(routine.id))).status).toBe("failed");
    expect(await reload(routine.id)).toMatchObject({ status: "active", consecutiveFailures: 0, lastRunAt: null });
  });

  it("shows what is already created or unknown without reserving anything", async () => {
    const routine = await seed([readStep, createAdsStep]);
    await db.routineItem.create({ data: { routineId: routine.id, stepId: "creer", itemKey: "creer:crea-1", status: "created" } });
    await db.routineItem.create({ data: { routineId: routine.id, stepId: "creer", itemKey: "creer:crea-2", status: "pending" } });
    db.routineItem.writes.length = 0;
    const result = await dry(routine);
    expect(result.steps[1].planned.map((p) => p.itemKey)).toEqual(["creer:crea-3"]);
    expect(result.totals).toMatchObject({ planned: 1, skipped: 2 });
    expect(db.routineItem.writes).toEqual([]);
    expect(db.routineItem.rows.map((r) => r.status)).toEqual(["created", "pending"]);
  });

  it("fails a step that claims to have written", async () => {
    behaviours["slack.message"] = () => okOutcome({ written: [{ summary: "envoyé quand même" }] });
    const result = await dry(await seed([readStep, slackStep]));
    expect(result.status).toBe("failed");
    expect(result.steps[1]).toMatchObject({ status: "failed", error: { class: "functional" } });
  });

  it("refuses a mode and a trigger that disagree", async () => {
    const routine = await seed([readStep]);
    await expect(runRoutine(routine, { mode: "dry_run", trigger: "schedule" })).rejects.toThrow();
    await expect(runRoutine(routine, { mode: "live", trigger: "dry_run" })).rejects.toThrow();
    expect(db.routineRun.rows).toEqual([]);
  });
});

describe("routines — live run", () => {
  it("hands the same minted guard to every step and records what was written", async () => {
    const routine = await seed([readStep, createAdsStep, slackStep]);
    const result = await live(routine);
    expect(result).toMatchObject({ status: "success", totals: { planned: 0, created: 4, skipped: 0, failed: 0 }, deferred: 0 });
    expect(seen.every((s) => isWriteGuard(s.ctx.write))).toBe(true);
    expect(new Set(seen.map((s) => s.ctx.write)).size).toBe(1);
    expect(seen[0].ctx.write?.runId).toBe(result.runId);
    expect(platformCalls).toEqual(["creer:crea-1", "creer:crea-2", "creer:crea-3", "slack"]);
    expect(db.routineItem.rows.map((r) => [r.itemKey, r.status, r.externalId, r.runId])).toEqual([
      ["creer:crea-1", "created", "ad_crea-1", result.runId], ["creer:crea-2", "created", "ad_crea-2", result.runId], ["creer:crea-3", "created", "ad_crea-3", result.runId],
    ]);
    expect(await reload(routine.id)).toMatchObject({ lastRunStatus: "success", consecutiveFailures: 0 });
    expect((await reload(routine.id)).lastRunAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("gives each step the rows of its input and the outputs of the steps before it", async () => {
    behaviours["ai.summary"] = () => okOutcome({ output: { text: "Semaine calme." } });
    await live(await seed([
      readStep, { id: "deux", type: "rows.limit", count: 2 },
      { id: "resume", type: "ai.summary", instruction: "Résume", onFailure: "fail" },
      { ...slackStep, text: "{{steps.resume.text}}", includeTable: true },
      { ...slackStep, id: "tout", input: "lire", includeTable: true },
    ]));
    const ctxOf = (id: string) => seen.find((s) => s.stepId === id)!.ctx;
    expect(ctxOf("lire").input).toBeNull();
    expect(ctxOf("resume").input?.rows).toHaveLength(2);
    expect(ctxOf("prevenir").input?.rows).toHaveLength(2);
    expect(ctxOf("prevenir").outputs.resume.text).toBe("Semaine calme.");
    expect(Object.keys(ctxOf("prevenir").outputs)).toEqual(["lire", "deux", "resume"]);
    expect(ctxOf("tout").input?.rows).toHaveLength(3);
    expect(ctxOf("tout").routine).toEqual({ id: expect.any(String), name: "Créas de la semaine", metaAccountId: "act_123", googleCustomerId: null, timezone: "Europe/Paris", maxItemsPerRun: 20 });
  });

  it("creates nothing twice: a second run finds every key done", async () => {
    const routine = await seed([readStep, createAdsStep]);
    await live(routine);
    const again = await live(await reload(routine.id));
    expect(again).toMatchObject({ status: "success", totals: { created: 0, skipped: 3 } });
    expect(platformCalls).toHaveLength(3);
    expect(db.routineItem.rows).toHaveLength(3);
  });
});

describe("routines — ceiling of items per run", () => {
  it("stops at maxItemsPerRun and leaves the rest to the next runs", async () => {
    behaviours["sheet.read"] = reads(12);
    const routine = await seed([readStep, createAdsStep], { maxItemsPerRun: 5 });

    const first = await live(routine);
    expect(first).toMatchObject({ status: "success", deferred: 7, totals: { created: 5, skipped: 0 } });
    expect(platformCalls).toEqual(["creer:crea-1", "creer:crea-2", "creer:crea-3", "creer:crea-4", "creer:crea-5"]);
    expect(db.routineItem.rows).toHaveLength(5);
    expect(first.steps[1].warnings.join(" ")).toMatch(/7 élément\(s\) reporté\(s\).*plafond de 5/);

    // Keys already done do not use up the ceiling: the run moves on in the Sheet.
    const second = await live(await reload(routine.id));
    expect(second).toMatchObject({ deferred: 2, totals: { created: 5, skipped: 5 } });
    const third = await live(await reload(routine.id));
    expect(third).toMatchObject({ deferred: 0, totals: { created: 2, skipped: 10 } });
    expect(platformCalls).toHaveLength(12);
    expect(new Set(platformCalls).size).toBe(12);
  });

  it("tells a step which keys were put off", async () => {
    behaviours["sheet.read"] = reads(3);
    const asked: boolean[] = [];
    behaviours["meta.create_ads"] = async (step, ctx) => {
      for (const row of ctx.input!.rows) {
        const claim = await ctx.claimItem(step.id, `k:${row.id}`, "x");
        asked.push(claim === "already_done" && wasDeferred(ctx.runId, `k:${row.id}`));
      }
      return okOutcome();
    };
    await live(await seed([readStep, createAdsStep], { maxItemsPerRun: 2 }));
    expect(asked).toEqual([false, false, true]);
  });

  it("applies to the dry run too", async () => {
    behaviours["sheet.read"] = reads(9);
    const result = await dry(await seed([readStep, createAdsStep], { maxItemsPerRun: 4 }));
    expect(result.steps[1].planned).toHaveLength(4);
    expect(result).toMatchObject({ deferred: 5, totals: { planned: 4 } });
  });

  it("cuts what a careless step planned, and fails one that wrote past the ceiling", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ itemKey: `k${i}`, summary: "x" }));
    behaviours["meta.create_ads"] = () => okOutcome({ planned: many(30).map((w) => ({ ...w, target: "meta" as const, preview: {} })) });
    expect((await dry(await seed([readStep, createAdsStep], { maxItemsPerRun: 10 }))).steps[1].planned).toHaveLength(10);

    behaviours["meta.create_ads"] = () => okOutcome({ written: many(11) });
    const result = await live(await seed([readStep, createAdsStep], { maxItemsPerRun: 10 }));
    expect(result.steps[1]).toMatchObject({ status: "failed", error: { class: "functional" } });
  });

  it("never goes over 50, whatever the row says", async () => {
    behaviours["sheet.read"] = reads(60);
    const routine = await seed([readStep, createAdsStep], { maxItemsPerRun: 20 });
    // Row edited by hand: the hash no longer matches, nothing runs.
    db.routine.rows[0].maxItemsPerRun = 500;
    const result = await live(await reload(routine.id));
    expect(result.status).toBe("failed");
    expect(platformCalls).toEqual([]);
  });
});

describe("routines — failures", () => {
  it("skips the steps that depend on a failed one, and runs the others", async () => {
    behaviours["sheet.read"] = fails("functional", "Onglet introuvable");
    behaviours["meta.insights"] = () => okOutcome({ output: { rows: { columns: ["spend"], rows: [{ spend: 10 }], truncated: false } } });
    behaviours["ai.summary"] = () => okOutcome({ output: { text: "ok" } });
    const result = await live(await seed([
      readStep,
      { id: "garder", type: "rows.filter", where: [{ column: "statut", op: "not_empty" }] },
      createAdsStep,
      { id: "stats", type: "meta.insights", level: "account", window: "7d", metrics: ["spend"] },
      { id: "resume", type: "ai.summary", instruction: "Résume", onFailure: "fail" },
      { ...slackStep, text: "{{steps.resume.text}}" },
    ]));
    expect(result.steps.map((s) => [s.stepId, s.status])).toEqual([
      ["lire", "failed"], ["garder", "skipped"], ["creer", "skipped"], ["stats", "ok"], ["resume", "ok"], ["prevenir", "ok"],
    ]);
    expect(result.steps[2].warnings[0]).toMatch(/dépend de l'étape « garder »/);
    expect(seen.map((s) => s.stepId)).toEqual(["lire", "stats", "resume", "prevenir"]);
    // Something was sent, something failed.
    expect(result.status).toBe("partial");
    expect(result.error).toBe("Onglet introuvable");
    expect((await reload(result.steps.length ? db.routine.rows[0].id as string : "")).consecutiveFailures).toBe(1);
  });

  it("skips a message whose quoted text failed", async () => {
    behaviours["ai.summary"] = fails("infra", "Relay inaccessible");
    const result = await live(await seed([readStep, { id: "resume", type: "ai.summary", instruction: "x", onFailure: "fail" }, { ...slackStep, text: "{{steps.resume.text}}" }]));
    expect(result.steps.map((s) => s.status)).toEqual(["ok", "failed", "skipped"]);
    expect(result.status).toBe("infra_failed");
    expect(platformCalls).toEqual([]);
  });

  it("turns a step that throws into a failed step, sorted by what was thrown", async () => {
    behaviours["sheet.read"] = () => { throw new Error("Relay inaccessible (http://127.0.0.1:3457)"); };
    expect((await live(await seed([readStep]))).steps[0]).toMatchObject({ status: "failed", error: { class: "infra", message: expect.stringContaining("Relay inaccessible") } });
    behaviours["sheet.read"] = () => { throw new TypeError("Cannot read properties of undefined"); };
    expect((await live(await seed([readStep]))).steps[0]).toMatchObject({ status: "failed", error: { class: "functional" } });
    behaviours["sheet.read"] = () => undefined as unknown as StepRunOutcome;
    expect((await live(await seed([readStep]))).steps[0]).toMatchObject({ status: "failed", error: { class: "functional" } });
  });

  it("sorts thrown errors", () => {
    for (const infra of ["Relay inaccessible", "fetch failed", "ETIMEDOUT", "socket hang up", "HTTP 503", "429 Too Many Requests", "User request limit reached (rate limit)", "quota dépassé", "The operation was aborted"]) {
      expect(classifyError(new Error(infra)), infra).toBe("infra");
    }
    const abort = new Error("x"); abort.name = "AbortError";
    expect(classifyError(abort)).toBe("infra");
    for (const functional of ["Colonne « id » absente", "Ensemble de publicités hors du compte", "Invalid parameter", "Canal Slack inconnu"]) {
      expect(classifyError(new Error(functional)), functional).toBe("functional");
    }
  });

  it("switches the routine off at the third functional failure in a row", async () => {
    behaviours["sheet.read"] = fails("functional", "Colonne « statut » absente");
    const routine = await seed([readStep, createAdsStep]);

    const one = await live(await reload(routine.id));
    expect(one).toMatchObject({ status: "failed", consecutiveFailures: 1, autoDisabled: false });
    const two = await live(await reload(routine.id));
    expect(two).toMatchObject({ consecutiveFailures: 2, autoDisabled: false });
    expect(await reload(routine.id)).toMatchObject({ status: "active" });
    expect(db.routineEvent.rows).toEqual([]);

    const three = await live(await reload(routine.id));
    expect(three).toMatchObject({ status: "failed", consecutiveFailures: 3, autoDisabled: true });
    expect(await reload(routine.id)).toMatchObject({ status: "error", nextRunAt: null, dryRunHash: null, lastRunStatus: "failed", consecutiveFailures: 3 });
    expect(db.routineEvent.rows).toHaveLength(1);
    expect(db.routineEvent.rows[0]).toMatchObject({ kind: "auto_disabled", routineId: routine.id, userId: null, definitionHash: routine.definitionHash });
    expect(String(db.routineEvent.rows[0].detail)).toContain("Colonne « statut » absente");
    // Off: the lock is refused, neither the cron nor "run now" starts it again.
    expect(await acquireRunLock(routine.id, NOW)).toBeNull();
  });

  it("never switches it off on infrastructure failures", async () => {
    behaviours["sheet.read"] = fails("infra", "Relay inaccessible");
    const routine = await seed([readStep, createAdsStep]);
    for (let i = 0; i < 6; i++) {
      expect(await live(await reload(routine.id))).toMatchObject({ status: "infra_failed", consecutiveFailures: 0, autoDisabled: false });
    }
    expect(await reload(routine.id)).toMatchObject({ status: "active", consecutiveFailures: 0, lastRunStatus: "infra_failed" });
    expect(db.routineEvent.rows).toEqual([]);
  });

  it("counts consecutive failures only: a success resets, an infrastructure failure does not", async () => {
    const routine = await seed([readStep, createAdsStep]);
    const run = async (b: Behaviour) => { behaviours["sheet.read"] = b; return live(await reload(routine.id)); };
    const bad = fails("functional", "Colonne absente"), down = fails("infra", "fetch failed");

    expect((await run(bad)).consecutiveFailures).toBe(1);
    expect((await run(bad)).consecutiveFailures).toBe(2);
    expect((await run(reads(1))).consecutiveFailures).toBe(0);
    expect((await run(bad)).consecutiveFailures).toBe(1);
    // The relay goes down between two functional failures: the count is kept, not raised.
    expect((await run(down)).consecutiveFailures).toBe(1);
    expect((await run(bad)).consecutiveFailures).toBe(2);
    expect(await reload(routine.id)).toMatchObject({ status: "active" });
    expect((await run(bad)).autoDisabled).toBe(true);
  });

  it("refuses a definition that was changed outside the application", async () => {
    const routine = await seed([readStep, createAdsStep]);
    db.routine.rows[0].definitionJson = JSON.stringify({ version: 1, steps: [readStep, { ...createAdsStep, adsetId: "999" }] });
    const result = await live(await reload(routine.id));
    expect(result).toMatchObject({ status: "failed", steps: [] });
    expect(result.error).toMatch(/empreinte/);
    expect(seen).toEqual([]);

    // Same when what is stored no longer passes validation, even with a matching hash.
    const forged = { version: 1, steps: [readStep, { ...createAdsStep, status: "ACTIVE" }] } as unknown as RoutineDefinition;
    db.routine.rows[0].definitionJson = JSON.stringify(forged);
    db.routine.rows[0].definitionHash = hashDefinition({ definition: forged, schedule: DAILY, maxItemsPerRun: 20 });
    const second = await live(await reload(routine.id));
    expect(second.status).toBe("failed");
    expect(second.error).toMatch(/Définition refusée/);
    expect(seen).toEqual([]);
    expect(platformCalls).toEqual([]);
  });

  it("does not run on schedule for someone who left the team", async () => {
    const routine = await seed([readStep, createAdsStep]);
    db.user.rows[0].role = "client";
    const result = await runRoutine(await reload(routine.id), { mode: "live", trigger: "schedule", now: NOW });
    expect(result).toMatchObject({ status: "failed", steps: [] });
    expect(result.error).toMatch(/ne fait plus partie de l'équipe/);
    db.user.rows.length = 0;
    expect((await runRoutine(await reload(routine.id), { mode: "live", trigger: "schedule", now: NOW })).error).toMatch(/n'a plus de compte/);
  });
});

describe("routines — time budget", () => {
  it("stops before the deadline and leaves the rest for the next run", async () => {
    let t = 1_000_000;
    const clock = () => t;
    behaviours["sheet.read"] = (...args) => { t += 100_000; return reads(3)(...args); };
    behaviours["meta.create_ads"] = async (step, ctx) => { const out = await createsAds(step, ctx); t += 168_000; return out; };
    const routine = await seed([readStep, createAdsStep, slackStep]);
    const result = await live(routine, { clock, deadlineAt: t + 270_000 });

    expect(result.steps.map((s) => s.status)).toEqual(["ok", "ok", "skipped"]);
    expect(result.steps[2].warnings[0]).toMatch(/budget de temps/);
    expect(result).toMatchObject({ status: "partial", timedOut: true, totals: { created: 3 } });
    expect(platformCalls).not.toContain("slack");
    expect(db.routineRun.rows[0]).toMatchObject({ status: "partial", durationMs: 268_000 });
    // Running out of time is nobody's fault.
    expect(await reload(routine.id)).toMatchObject({ status: "active", consecutiveFailures: 0 });
  });

  it("reserves no item once the deadline has passed", async () => {
    let t = 0;
    behaviours["sheet.read"] = reads(4);
    behaviours["meta.create_ads"] = async (step, ctx) => {
      const out = okOutcome();
      for (const row of ctx.input!.rows) {
        if ((await ctx.claimItem(step.id, `k:${row.id}`, "x")) !== "claimed") continue;
        t += 100_000; // each creation is slow
        await ctx.settleItem(step.id, `k:${row.id}`, { status: "created", externalId: "ad" });
        out.written.push({ itemKey: `k:${row.id}`, summary: "créée" });
      }
      return out;
    };
    const result = await live(await seed([readStep, createAdsStep]), { clock: () => t, deadlineAt: 250_000 });
    expect(result).toMatchObject({ status: "partial", timedOut: true, deferred: 1, totals: { created: 3 } });
    expect(db.routineItem.rows).toHaveLength(3);
    expect(result.steps[1].warnings.join(" ")).toMatch(/budget de temps épuisé/);
  });
});

describe("routines — items", () => {
  const args = (itemKey: string, runId = "run1") => ({ routineId: "r1", runId, stepId: "creer", itemKey, label: "Créa" });

  it("lets one of several concurrent claims through", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claimItem(args("k1", `run${i}`))));
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "uncertain")).toHaveLength(7);
    expect(db.routineItem.rows).toHaveLength(1);
  });

  it("never creates again what is created, nor what is unknown", async () => {
    expect(await claimItem(args("k1"))).toBe("claimed");
    expect(await settleItem({ routineId: "r1", itemKey: "k1", status: "created", externalId: "ad_1" })).toBe(true);
    expect(await claimItem(args("k1", "run2"))).toBe("already_done");
    // Settled once: a late answer does not rewrite it.
    expect(await settleItem({ routineId: "r1", itemKey: "k1", status: "failed", error: "trop tard" })).toBe(false);
    expect(db.routineItem.rows[0]).toMatchObject({ status: "created", externalId: "ad_1", runId: "run1" });

    // Reserved, never settled (creation timed out): unknown, for good.
    expect(await claimItem(args("k2"))).toBe("claimed");
    expect(await claimItem(args("k2", "run2"))).toBe("uncertain");
    expect(await claimItem(args("k2", "run3"))).toBe("uncertain");
    expect(db.routineItem.rows[1]).toMatchObject({ status: "uncertain", attempts: 1 });
    expect(await peekItem("r1", "k2")).toBe("uncertain");
    expect(await peekItem("r1", "k1")).toBe("already_done");
    expect(await peekItem("r1", "jamais-vue")).toBe("claimed");
    await expect(claimItem(args(""))).rejects.toThrow();
  });

  it("tries a failed item again, three attempts in all", async () => {
    for (const attempt of [1, 2, 3]) {
      expect(await claimItem(args("k1", `run${attempt}`)), `attempt ${attempt}`).toBe("claimed");
      expect(db.routineItem.rows[0]).toMatchObject({ status: "pending", attempts: attempt, runId: `run${attempt}` });
      await settleItem({ routineId: "r1", itemKey: "k1", status: "failed", error: "Image refusée" });
    }
    expect(await claimItem(args("k1", "run4"))).toBe("already_done");
    expect(db.routineItem.rows[0]).toMatchObject({ status: "failed", attempts: 3, error: "Image refusée" });
  });

  it("turns what a run reserved and never settled into unknown", async () => {
    behaviours["meta.create_ads"] = async (step, ctx) => {
      await ctx.claimItem(step.id, "k:1", "a");
      await ctx.settleItem(step.id, "k:1", { status: "failed", error: "Image refusée" });
      await ctx.claimItem(step.id, "k:2", "b"); // the platform never answered
      return okOutcome({ warnings: ["1 création sans réponse"] });
    };
    const result = await live(await seed([readStep, createAdsStep]));
    expect(db.routineItem.rows.map((r) => r.status)).toEqual(["failed", "uncertain"]);
    expect(result).toMatchObject({ status: "partial", totals: { created: 0, failed: 1, skipped: 1 } });
  });
});

describe("routines — run lock", () => {
  it("has a single winner among concurrent callers", async () => {
    const routine = await seed([readStep]);
    const locks = await Promise.all(Array.from({ length: 10 }, () => acquireRunLock(routine.id, NOW, { due: true })));
    expect(locks.filter(Boolean)).toHaveLength(1);
    expect(await acquireRunLock(routine.id, new Date(NOW.getTime() + 60_000))).toBeNull();
  });

  it("is given back by its holder only, and expires by itself", async () => {
    const routine = await seed([readStep]);
    const lock = (await acquireRunLock(routine.id, NOW))!;
    expect(lock.lockedUntil.getTime() - NOW.getTime()).toBe(330_000);
    expect(await releaseRunLock({ routineId: routine.id, lockedUntil: new Date(0) })).toBe(false);
    expect(await acquireRunLock(routine.id, NOW)).toBeNull();

    // The function died: six minutes later the routine can be taken again.
    const later = new Date(NOW.getTime() + 331_000);
    const second = (await acquireRunLock(routine.id, later))!;
    expect(second).not.toBeNull();
    // The first holder wakes up: its lock is gone, it releases nothing.
    expect(await releaseRunLock(lock)).toBe(false);
    expect((await reload(routine.id)).lockedUntil?.getTime()).toBe(second.lockedUntil.getTime());
    expect(await releaseRunLock(second, { nextRunAt: null })).toBe(true);
    expect(await reload(routine.id)).toMatchObject({ lockedUntil: null, nextRunAt: null });
  });

  it("is refused to a routine that is not active or not due", async () => {
    for (const status of ["draft", "ready", "paused", "error", "archived"]) {
      const routine = await seed([readStep], { status });
      expect(await acquireRunLock(routine.id, NOW), status).toBeNull();
    }
    const early = await seed([readStep], { nextRunAt: new Date(NOW.getTime() + 1) });
    expect(await acquireRunLock(early.id, NOW, { due: true })).toBeNull();
    const manual = await seed([readStep], { nextRunAt: null });
    expect(await acquireRunLock(manual.id, NOW, { due: true })).toBeNull();
    expect(await acquireRunLock(manual.id, NOW)).not.toBeNull();
  });

  it("makes one run of two firings at the same instant", async () => {
    const routine = await seed([readStep, createAdsStep, slackStep]);
    const outcomes = await Promise.all([1, 2, 3].map(() => runLocked(routine.id, { trigger: "schedule", now: NOW })));
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["busy", "busy", "ran"]);
    expect(db.routineRun.rows).toHaveLength(1);
    expect(platformCalls).toEqual(["creer:crea-1", "creer:crea-2", "creer:crea-3", "slack"]);
    expect(await reload(routine.id)).toMatchObject({ lockedUntil: null, lastRunStatus: "success" });
    // Next occurrence after now: 09:00 in Paris the same day.
    expect((await reload(routine.id)).nextRunAt?.toISOString()).toBe("2026-09-30T07:00:00.000Z");
    // Not due any more: the next firing finds nothing to do.
    expect((await runLocked(routine.id, { trigger: "schedule", now: new Date(NOW.getTime() + 900_000) })).outcome).toBe("busy");
  });

  it("shares the lock between the cron and « run now », and leaves the schedule to a manual run", async () => {
    const routine = await seed([readStep, slackStep]);
    const due = (await reload(routine.id)).nextRunAt;
    const outcomes = await Promise.all([
      runLocked(routine.id, { trigger: "manual", startedById: "u1", now: NOW }),
      runLocked(routine.id, { trigger: "schedule", now: NOW }),
    ]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["ran", "busy"]);
    expect(db.routineRun.rows).toMatchObject([{ trigger: "manual", startedById: "u1" }]);
    expect((await reload(routine.id)).nextRunAt).toEqual(due);
  });

  it("records a run that is more than 12 hours late as missed, and runs one that is less", async () => {
    const late = await seed([readStep, slackStep], { nextRunAt: new Date(NOW.getTime() - 13 * 3_600_000) });
    const missed = await runLocked(late.id, { trigger: "schedule", now: NOW });
    expect(missed.outcome).toBe("missed");
    expect(seen).toEqual([]);
    expect(db.routineRun.rows).toMatchObject([{ status: "missed", trigger: "schedule" }]);
    expect(await reload(late.id)).toMatchObject({ status: "active", lockedUntil: null, lastRunStatus: "missed", consecutiveFailures: 0 });
    expect((await reload(late.id)).nextRunAt?.toISOString()).toBe("2026-09-30T07:00:00.000Z");

    const almost = await seed([readStep, slackStep], { nextRunAt: new Date(NOW.getTime() - 11 * 3_600_000) });
    expect((await runLocked(almost.id, { trigger: "schedule", now: NOW })).outcome).toBe("ran");
    expect(seen.map((s) => s.stepId)).toEqual(["lire", "prevenir"]);
  });

  it("gives the lock back when the run crashes, and keeps the routine due", async () => {
    const routine = await seed([readStep]);
    const create = db.routineRun.create;
    db.routineRun.create = async () => { throw new Error("connection lost"); };
    await expect(runLocked(routine.id, { trigger: "schedule", now: NOW })).rejects.toThrow("connection lost");
    db.routineRun.create = create;
    expect(await reload(routine.id)).toMatchObject({ lockedUntil: null, status: "active" });
    expect((await reload(routine.id)).nextRunAt?.toISOString()).toBe("2026-09-29T07:00:00.000Z");
    expect((await runLocked(routine.id, { trigger: "schedule", now: NOW })).outcome).toBe("ran");
  });

  it("leaves a routine that was switched off without a next run", async () => {
    behaviours["sheet.read"] = fails("functional", "Onglet introuvable");
    const routine = await seed([readStep], { consecutiveFailures: 2 });
    const ran = await runLocked(routine.id, { trigger: "schedule", now: NOW });
    expect(ran).toMatchObject({ outcome: "ran", nextRunAt: null, result: { autoDisabled: true } });
    expect(await reload(routine.id)).toMatchObject({ status: "error", nextRunAt: null, lockedUntil: null });
  });
});

describe("routines — what is stored of a run", () => {
  it("keeps a sample of the rows, not the data", async () => {
    behaviours["sheet.read"] = reads(500);
    behaviours["ai.summary"] = () => okOutcome({ output: { text: "x".repeat(10_000) } });
    const result = await live(await seed([readStep, { id: "resume", type: "ai.summary", instruction: "x", onFailure: "fail" }]));
    expect(result.steps[0].output.rows?.rows).toHaveLength(500);
    const stored = JSON.parse(String(db.routineRun.rows[0].stepsJson));
    expect(stored[0].output.rows.rows).toHaveLength(20);
    expect(stored[0].output.rows.truncated).toBe(true);
    expect(stored[0]).toMatchObject({ stepId: "lire", type: "sheet.read", status: "ok", rowsOut: 500 });
    expect(stored[1].output.text).toHaveLength(4000);
    expect(compactSteps(result.steps, 5)[0].output.rows?.rows).toHaveLength(5);
  });
});

// Type-level: the context handed to a step is the shared contract, nothing more.
const _ctx: keyof StepContext = "write";
void _ctx;
