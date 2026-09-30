/** STUB (lot 0) — replaced by lot A. The signatures are the contract: keep them. */
import type { AlertAccountRef, ClientSeries } from "@/lib/client-alerts/types";

/**
 * SERIES_DAYS full days and the day in progress for every account, in euros.
 * An account that cannot be read comes back with `error` and no day: it never throws.
 */
export async function readClientSeries(_accounts: AlertAccountRef[], _opts: { now?: Date; fresh?: boolean } = {}): Promise<ClientSeries> {
  throw new Error("not implemented");
}

/** Compact text of the last `days` days (per platform and combined, euros) — what the AI reads. */
export function summarizeSeries(_series: ClientSeries, _days = 60): string {
  throw new Error("not implemented");
}
