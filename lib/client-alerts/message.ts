/** STUB (lot 0) — replaced by lot B. The signatures are the contract: keep them. */
import type { AlertDefinition, Evaluation } from "@/lib/client-alerts/types";

/** One alert, as it reads in the private message (Slack mrkdwn, a few lines, per-platform detail). Pure. */
export function buildAlertLine(_input: { clientName: string; def: AlertDefinition; evaluation: Evaluation; kind: "trigger" | "reminder" }): string {
  throw new Error("not implemented");
}

/** The private message of one consultant for one pass: its alerts, then « N autres alertes » when capped. Pure. */
export function buildDmText(_lines: string[], _extra: number, _pageUrl: string | null): string {
  throw new Error("not implemented");
}
