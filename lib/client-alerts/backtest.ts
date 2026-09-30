/** STUB (lot 0) — replaced by lot A. The signatures are the contract: keep them. */
import type { AlertDefinition, Backtest, ClientSeries } from "@/lib/client-alerts/types";

/** Replays the definition over the last BACKTEST_DAYS days with evaluate(), silence and re-arming applied. Pure. */
export function backtest(_def: AlertDefinition, _series: ClientSeries, _opts: { now?: Date } = {}): Backtest {
  throw new Error("not implemented");
}
