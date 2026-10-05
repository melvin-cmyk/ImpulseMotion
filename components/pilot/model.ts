/** Pilotage — what the page holds (types shared by its components). */

import type { PilotKind, PilotObjectType } from "@/lib/pilot/ops";
export type { PilotActionView, PilotOperationView } from "@/lib/pilot/service";

export interface PilotClient {
  id: string;
  name: string;
  dormant: boolean;
  accounts: Array<{ platform: "meta" | "google"; accountId: string; name?: string; currency?: string }>;
}

/** A row of the account tree, as /api/pilot/structure sends it. */
export interface TreeRow {
  id: string;
  type: PilotObjectType;
  name: string;
  status: string;
  effectiveStatus: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  endTime: string | null;
  bidAmount: number | null;
  bidStrategy: string | null;
  /** Why the budget cannot be changed here (a shared Google Ads budget). */
  budgetLock?: string | null;
  /** Why the end date cannot be changed here. */
  endTimeLock?: string | null;
  parentId: string | null;
  parentName: string;
  spend7d: number;
}

/** A change waiting in the panel, before the preview. `label` is only for the panel. */
export interface PendingChange {
  kind: PilotKind;
  objectType: PilotObjectType;
  objectId: string;
  value: string | number;
  label: string;
}

export const changeKey = (c: { objectId: string; kind: string }) => `${c.objectId}:${c.kind === "set_status" ? "status" : c.kind}`;

export async function readJson<T>(res: Response): Promise<T & { error?: string; errors?: string[] }> {
  return (await res.json().catch(() => ({}))) as T & { error?: string; errors?: string[] };
}
