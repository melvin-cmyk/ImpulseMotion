/**
 * Routines — fingerprint of what a dry run has checked.
 *
 * The hash covers the definition, the schedule and the ceiling of items per
 * run. Activation compares the hash of the last successful dry run with the
 * current one: any change in between sends the routine back to a dry run.
 *
 * Keys are sorted at every level and absent values are left out, so two
 * definitions that say the same thing have the same hash whatever the order
 * in which the AI or the database wrote them. Arrays keep their order: the
 * order of the steps is part of the definition.
 */

import { createHash } from "node:crypto";
import type { RoutineDefinition, Schedule } from "@/lib/routines/types";

export interface HashInput {
  definition: RoutineDefinition;
  schedule: Schedule;
  maxItemsPerRun: number;
}

/** JSON with sorted keys; undefined and functions are dropped, as JSON.stringify does. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(o).sort()) {
      const v = o[key];
      if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return "null";
}

export function hashDefinition(input: HashInput): string {
  const payload = canonicalJson({
    definition: input.definition,
    maxItemsPerRun: input.maxItemsPerRun,
    schedule: input.schedule,
  });
  return createHash("sha256").update(payload).digest("hex");
}
