/** STUB (lot 0) — replaced by lot A. The signatures are the contract: keep them. */
import type { RunSummary } from "@/lib/client-alerts/types";

/** One pass of the cron: checks the active alerts that are due, records the triggers, sends the private messages. */
export async function runClientAlerts(_opts: { now?: Date; slot?: number | null; dryRun?: boolean; only?: string[] } = {}): Promise<RunSummary> {
  throw new Error("not implemented");
}
