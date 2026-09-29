/**
 * Routines — fingerprint of what a dry run has checked.
 *
 * The hash covers everything that changes WHAT a run writes or WHERE: the
 * definition, the schedule, the ceiling of items per run, the Meta and Google
 * accounts of the routine and its timezone (it dates the reporting windows and
 * {{run.date}}). Activation compares the hash of the last successful dry run
 * with the current one: any change in between sends the routine back to a dry
 * run. The name of the routine is not part of it.
 *
 * Accounts are hashed by their digits: "act_123…" and "123…" are one account.
 *
 * Keys are sorted at every level and absent values are left out, so two
 * definitions that say the same thing have the same hash whatever the order
 * in which the AI or the database wrote them. Arrays keep their order: the
 * order of the steps is part of the definition.
 */

import { createHash } from "node:crypto";
import { googleCustomerDigits, metaAccountDigits } from "@/lib/routines/accounts";
import type { RoutineDefinition, Schedule } from "@/lib/routines/types";

export interface HashInput {
  definition: RoutineDefinition;
  schedule: Schedule;
  maxItemsPerRun: number;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  timezone: string;
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

/** An account as it is hashed: its digits, or the text as stored when it is not a valid id (so that it never matches). */
const account = (value: string | null, digits: (v: unknown) => string | null): string | null =>
  value === null || value === undefined || value === "" ? null : digits(value) ?? `invalide:${value}`;

export function hashDefinition(input: HashInput): string {
  const payload = canonicalJson({
    definition: input.definition,
    googleCustomerId: account(input.googleCustomerId, googleCustomerDigits),
    maxItemsPerRun: input.maxItemsPerRun,
    metaAccountId: account(input.metaAccountId, metaAccountDigits),
    schedule: input.schedule,
    timezone: input.timezone,
  });
  return createHash("sha256").update(payload).digest("hex");
}
