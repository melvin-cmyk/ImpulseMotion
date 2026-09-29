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

import { isMintedWriteGuard, isRevokedWriteGuard } from "@/lib/routines/write-guard";
import type { WriteGuard } from "@/lib/routines/types";

export const WRITE_REVOKED = "Écriture refusée : l'exécution est terminée, son autorisation d'écriture a été révoquée";

export function isWriteGuard(value: unknown): value is WriteGuard {
  return isMintedWriteGuard(value);
}

/** Throws unless the guard was made by the engine for a live run that is still going. */
export function assertWriteGuard(value: unknown): asserts value is WriteGuard {
  if (isRevokedWriteGuard(value)) throw new Error(WRITE_REVOKED);
  if (!isMintedWriteGuard(value)) throw new Error("Écriture refusée : autorisation d'écriture absente ou invalide");
}

/**
 * For a step, before each write: throws when the engine has ended the run or
 * given the step up (StepContext.signal), or when the guard is no longer valid.
 */
export function assertCanWrite(ctx: { write: unknown; signal?: AbortSignal }): void {
  if (ctx.signal?.aborted) throw new Error(WRITE_REVOKED);
  assertWriteGuard(ctx.write);
}
