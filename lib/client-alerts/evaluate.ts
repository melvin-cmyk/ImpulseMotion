/** STUB (lot 0) — replaced by lot A. The signatures are the contract: keep them. */
import type { AlertDefinition, ClientSeries, Evaluation } from "@/lib/client-alerts/types";

/**
 * Pure. `asOf` = last full day of the window (default: series.until).
 * `live` = the check of the cron, which may read the day in progress for `stopped`; the replay never does.
 */
export function evaluate(_def: AlertDefinition, _series: ClientSeries, _opts: { asOf?: string; live?: boolean } = {}): Evaluation {
  throw new Error("not implemented");
}

/** Stable hash of what changes the evaluation or the delivery (not the label, not the explanation). */
export function definitionHash(_def: AlertDefinition): string {
  throw new Error("not implemented");
}
