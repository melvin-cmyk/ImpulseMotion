/**
 * Routines — what a proposal changes of a routine that has already worked,
 * said before it is applied (card of the proposal, answer of the definition
 * route). Server side: it reads the items of the routine.
 *
 * One notice for now: the ad set has changed. The items of a routine are
 * known by ad set (itemKeyOf): the rows done in the former ad set are not
 * done in the new one, and will be created there again. That is wanted; it
 * must not be a surprise.
 */

import { adsetChangeNotice } from "@/lib/routines/notices";
import { listItems, type RoutineRecord } from "@/lib/routines/store";
import { parseStoredDefinition } from "@/lib/routines/validate";
import type { RoutineDefinition } from "@/lib/routines/types";

const adsetOf = (definition: RoutineDefinition): string | null => {
  const step = definition.steps.find((s) => s.type === "meta.create_ads");
  return step && step.type === "meta.create_ads" ? step.adsetId : null;
};

export async function proposalNotices(routine: Pick<RoutineRecord, "id" | "definitionJson">, proposed: RoutineDefinition): Promise<string[]> {
  const next = adsetOf(proposed);
  if (!next) return [];
  const current = parseStoredDefinition(routine.definitionJson);
  const former = current.ok ? adsetOf(current.value) : null;
  if (former === next) return [];
  // Rows done in any other ad set than the one proposed, the former one first in mind.
  const rows = new Set<string>();
  for (const item of await listItems(routine.id)) {
    const at = item.itemKey.indexOf(":");
    if (at <= 0 || item.itemKey.slice(0, at) === next) continue;
    if (former && item.itemKey.slice(0, at) !== former) continue;
    if (item.status === "created" || item.externalId) rows.add(item.itemKey.slice(at + 1));
  }
  const notice = adsetChangeNotice(rows.size);
  return notice ? [notice] : [];
}
