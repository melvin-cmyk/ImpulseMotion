/** Routines — BOUCHON, remplacé par le lot D. Contrat d'export : voir lib/routines/steps/index.ts. */

import { stubHandler } from "@/lib/routines/steps/stub";
import type { StepHandler, StepOf } from "@/lib/routines/types";

export const aiSummaryHandler: StepHandler<StepOf<"ai.summary">> = stubHandler("ai.summary");
