/**
 * Routines — run-time check of a WriteGuard, for the code that writes
 * (lib/meta-write.ts, lib/relay-sheets.ts, message steps). First line of every
 * writing function:
 *
 *   assertWriteGuard(guard);
 *
 * Kept apart from lib/routines/write-guard.ts so that the writers never import
 * the module that makes guards.
 */

import { isMintedWriteGuard } from "@/lib/routines/write-guard";
import type { WriteGuard } from "@/lib/routines/types";

export function isWriteGuard(value: unknown): value is WriteGuard {
  return isMintedWriteGuard(value);
}

/** Throws unless the guard was made by the engine for a live run. */
export function assertWriteGuard(value: unknown): asserts value is WriteGuard {
  if (!isMintedWriteGuard(value)) throw new Error("Écriture refusée : autorisation d'écriture absente ou invalide");
}
