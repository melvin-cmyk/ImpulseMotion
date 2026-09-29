/**
 * Routines — where a WriteGuard is made.
 *
 * ENGINE ONLY. This module is imported by lib/routines/engine.ts and by
 * lib/routines/write-guard-check.ts, and by nothing else: a step handler, a
 * service (lib/meta-write.ts, lib/relay-sheets.ts) or a route that could mint
 * its own guard would make the dry run meaningless. The registry test scans
 * the code and fails on any other import.
 *
 * Two locks:
 *   - at compile time, the brand of WriteGuard is a symbol that is not
 *     exported (lib/routines/types.ts), so no object literal has the type;
 *   - at run time, the guards minted here are remembered, and the services
 *     refuse anything else through assertWriteGuard() (write-guard-check.ts),
 *     which stops a cast (`as unknown as WriteGuard`) too.
 *
 * The engine mints one guard per run, in live mode only; a dry run carries
 * `ctx.write = null`.
 */

import type { RunMode, WriteGuard } from "@/lib/routines/types";

const minted = new WeakSet<object>();

/** One guard per live run. Throws in dry run: nothing may write there. */
export function mintWriteGuard(mode: RunMode, runId: string): WriteGuard {
  if (mode !== "live") throw new Error("Essai à blanc : aucune écriture n'est autorisée");
  if (!runId) throw new Error("Exécution inconnue : écriture refusée");
  const guard = Object.freeze({ runId }) as unknown as WriteGuard;
  minted.add(guard);
  return guard;
}

/** True for a guard minted by this module, false for anything else (copies included). */
export function isMintedWriteGuard(value: unknown): value is WriteGuard {
  return typeof value === "object" && value !== null && minted.has(value);
}
