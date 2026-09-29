import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_ITEMS_PER_RUN, ITEM_STATUSES, MAX_EMAIL_RECIPIENTS, MAX_ITEMS_PER_RUN_CAP, MAX_STEPS,
  ROUTINE_STATUSES, RUN_STATUSES, SCHEDULE_STEP_MINUTES, STEP_TYPES, STEP_WRITES, platformWriteNeedsAdmin,
  type RoutineStep, type StepContext, type StepType, type WriteGuard, type WriteKind,
} from "@/lib/routines/types";
import {
  PLATFORM_WRITING_STEP_TYPES, STEP_HANDLERS, WRITING_STEP_TYPES,
  findStepHandler, getStepHandler, handlerFor, isStepType, writesPlatform,
} from "@/lib/routines/steps";
import { isMintedWriteGuard, mintWriteGuard } from "@/lib/routines/write-guard";
import { assertWriteGuard, isWriteGuard } from "@/lib/routines/write-guard-check";
import { ROUTINE_COMPOSE_PROFILE } from "@/lib/ai-profiles";

// Written by hand on purpose: the test must not read its expectations from the code it checks.
const EXPECTED: Record<StepType, WriteKind> = {
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
const ALL = Object.keys(EXPECTED) as StepType[];

// Compile-time: a step type added to the union without being listed here fails tsc.
type Missing = Exclude<StepType, (typeof STEP_TYPES)[number]>;
const noneMissing: Missing extends never ? true : false = true;

describe("routines — step registry", () => {
  it("lists every step type once", () => {
    expect(noneMissing).toBe(true);
    expect([...STEP_TYPES].sort()).toEqual([...ALL].sort());
    expect(new Set(STEP_TYPES).size).toBe(STEP_TYPES.length);
  });

  it("has one handler per step type, registered under its own type", () => {
    expect(Object.keys(STEP_HANDLERS).sort()).toEqual([...ALL].sort());
    for (const type of ALL) {
      const handler = getStepHandler(type);
      expect(handler, type).toBeTruthy();
      expect(handler.type).toBe(type);
      for (const fn of ["validate", "preflight", "run"] as const) expect(typeof handler[fn], `${type}.${fn}`).toBe("function");
    }
  });

  it("declares what each step writes", () => {
    expect(STEP_WRITES).toEqual(EXPECTED);
    for (const type of ALL) expect(STEP_HANDLERS[type].writes, type).toBe(EXPECTED[type]);
  });

  it("knows which steps write, and which write on a platform", () => {
    expect([...WRITING_STEP_TYPES].sort()).toEqual(["email.send", "meta.create_ads", "sheet.write", "slack.message"]);
    expect(PLATFORM_WRITING_STEP_TYPES).toEqual(["meta.create_ads"]);
    expect(writesPlatform([{ type: "sheet.read" }, { type: "slack.message" }])).toBe(false);
    expect(writesPlatform([{ type: "sheet.read" }, { type: "meta.create_ads" }])).toBe(true);
  });

  it("finds a handler from untrusted input, and nothing for an unknown type", () => {
    expect(findStepHandler("sheet.read")?.type).toBe("sheet.read");
    expect(handlerFor({ id: "s1", type: "rows.limit", count: 3 }).type).toBe("rows.limit");
    for (const bad of ["meta.update_budget", "", "constructor", "toString", "__proto__", null, undefined, 3, {}]) {
      expect(isStepType(bad)).toBe(false);
      expect(findStepHandler(bad)).toBeNull();
    }
  });
});

describe("routines — shared limits", () => {
  it("keeps the agreed ceilings", () => {
    expect(MAX_STEPS).toBe(12);
    expect(DEFAULT_MAX_ITEMS_PER_RUN).toBe(20);
    expect(MAX_ITEMS_PER_RUN_CAP).toBe(50);
    expect(MAX_EMAIL_RECIPIENTS).toBe(5);
    expect(SCHEDULE_STEP_MINUTES).toBe(15);
  });

  it("names the statuses stored in the database", () => {
    expect(ROUTINE_STATUSES).toEqual(["draft", "ready", "active", "paused", "error", "archived"]);
    expect(RUN_STATUSES).toEqual(["running", "success", "partial", "failed", "infra_failed", "missed"]);
    expect(ITEM_STATUSES).toEqual(["pending", "created", "failed", "uncertain"]);
  });

  it("requires an administrator for platform writes only when asked", () => {
    expect(platformWriteNeedsAdmin({})).toBe(false);
    expect(platformWriteNeedsAdmin({ ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN: "0" })).toBe(false);
    expect(platformWriteNeedsAdmin({ ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN: "true" })).toBe(false);
    expect(platformWriteNeedsAdmin({ ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN: "1" })).toBe(true);
  });

  it("composes routines on Opus, medium effort, 20 turns", () => {
    // Model and effort can be overridden by env; the turn cap cannot.
    expect(ROUTINE_COMPOSE_PROFILE.maxTurns).toBe(20);
    if (!process.env.AI_ROUTINE_MODEL) expect(ROUTINE_COMPOSE_PROFILE.model).toBe("opus");
    if (!process.env.AI_ROUTINE_EFFORT) expect(ROUTINE_COMPOSE_PROFILE.effort).toBe("medium");
  });
});

// Every step file is a placeholder for now. When a lot replaces a file, its
// type leaves this list — nothing else in this test changes.
const STILL_STUBBED: StepType[] = [...ALL];

describe("routines — placeholders", () => {
  const routine: StepContext["routine"] = { id: "r1", name: "Test", metaAccountId: null, googleCustomerId: null, timezone: "Europe/Paris", maxItemsPerRun: 20 };
  const ctx: StepContext = {
    mode: "dry_run", routine, runId: "run1", now: new Date("2026-09-29T08:00:00Z"), deadlineAt: Date.now() + 60_000,
    input: { columns: ["a"], rows: [{ a: 1 }, { a: 2 }], truncated: false },
    outputs: {}, write: null,
    claimItem: async () => { throw new Error("a placeholder must not claim an item"); },
    settleItem: async () => { throw new Error("a placeholder must not settle an item"); },
  };

  it.each(STILL_STUBBED)("%s refuses the step and fails without writing", async (type) => {
    const handler = findStepHandler(type)!;
    const checked = handler.validate({ id: "s1", type });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error).toContain("pas encore disponible");

    const step = { id: "s1", type } as unknown as RoutineStep;
    expect(await handler.preflight(step, routine)).toEqual([]);

    const out = await handler.run(step, ctx);
    expect(out.status).toBe("failed");
    expect(out.error).toMatchObject({ class: "functional" });
    expect(out.error?.message).toContain("pas encore disponible");
    expect(out).toMatchObject({ rowsIn: 2, rowsOut: 0, planned: [], written: [], warnings: [], output: {} });
  });
});

describe("routines — write guard", () => {
  it("cannot be written as a plain object", () => {
    // @ts-expect-error the brand is a symbol that is not exported: no literal is a WriteGuard
    const forged: WriteGuard = { runId: "run1" };
    // @ts-expect-error a made-up brand is not the brand either
    const branded: WriteGuard = { runId: "run1", [Symbol("writeGuardBrand")]: true };
    // A cast gets past the compiler, not past the run-time check.
    const cast = { runId: "run1" } as unknown as WriteGuard;

    for (const fake of [forged, branded, cast, null, undefined, "run1", {}, Object.freeze({ runId: "run1" })]) {
      expect(isWriteGuard(fake)).toBe(false);
      expect(isMintedWriteGuard(fake)).toBe(false);
      expect(() => assertWriteGuard(fake)).toThrow(/Écriture refusée/);
    }
  });

  it("is minted for a live run only", () => {
    const guard = mintWriteGuard("live", "run1");
    expect(guard.runId).toBe("run1");
    expect(isWriteGuard(guard)).toBe(true);
    expect(() => assertWriteGuard(guard)).not.toThrow();
    expect(Object.isFrozen(guard)).toBe(true);

    expect(() => mintWriteGuard("dry_run", "run1")).toThrow(/Essai à blanc/);
    expect(() => mintWriteGuard("live", "")).toThrow();
    // A copy of a real guard is not a guard.
    expect(isWriteGuard({ ...guard })).toBe(false);
    expect(isWriteGuard(JSON.parse(JSON.stringify(guard)))).toBe(false);
  });

  it("is made by the engine alone", () => {
    const root = path.resolve(__dirname, "../..");
    const allowed = new Set(["lib/routines/write-guard.ts", "lib/routines/engine.ts", "lib/routines/write-guard-check.ts"]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|mts|mjs|js)$/.test(name)) continue;
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (allowed.has(rel)) continue;
        const source = readFileSync(full, "utf8");
        // Imports only (static, dynamic, require): a comment may name the module.
        if (/(?:from|import|require)\s*\(?\s*["'][^"']*\/write-guard["']/.test(source)) offenders.push(rel);
      }
    };
    for (const dir of ["lib", "app", "components", "server"]) walk(path.join(root, dir));
    expect(offenders).toEqual([]);
    // The check module only reads, it never mints.
    expect(readFileSync(path.join(root, "lib/routines/write-guard-check.ts"), "utf8")).not.toContain("mintWriteGuard");
  });
});
