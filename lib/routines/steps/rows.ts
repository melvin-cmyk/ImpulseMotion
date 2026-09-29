/** Routines — BOUCHON, remplacé par le lot A. Contrat d'export : voir lib/routines/steps/index.ts. */

import { stubHandler } from "@/lib/routines/steps/stub";
import type { StepHandler, StepOf } from "@/lib/routines/types";

export const rowsFilterHandler: StepHandler<StepOf<"rows.filter">> = stubHandler("rows.filter");
export const rowsSortHandler: StepHandler<StepOf<"rows.sort">> = stubHandler("rows.sort");
export const rowsLimitHandler: StepHandler<StepOf<"rows.limit">> = stubHandler("rows.limit");
export const rowsSelectHandler: StepHandler<StepOf<"rows.select">> = stubHandler("rows.select");
