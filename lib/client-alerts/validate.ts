/** STUB (lot 0) — replaced by lot C. The signatures are the contract: keep them. */
import type { AlertAccountRef, AlertDefinition, ClientSeries } from "@/lib/client-alerts/types";

export type AlertValidation =
  | { ok: true; value: AlertDefinition; warnings: string[] }
  | { ok: false; errors: string[] };

/**
 * The ```alert block of the AI → a complete definition, or the reasons it is refused (French).
 * `accounts` = the accounts of the client: an account outside of them is refused, names and currencies come from them.
 * `series` lets it refuse what cannot be computed (a combined ROAS when a platform tracks no value).
 */
export function validateAlertProposal(_input: unknown, _ctx: { accounts: AlertAccountRef[]; series?: ClientSeries | null }): AlertValidation {
  return { ok: false, errors: ["not implemented"] };
}
