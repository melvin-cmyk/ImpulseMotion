/** Routines — BOUCHON, remplacé par le lot B. Contrat d'export : voir lib/routines/steps/index.ts. */

import { stubHandler } from "@/lib/routines/steps/stub";
import type { StepHandler, StepOf } from "@/lib/routines/types";

export const sheetReadHandler: StepHandler<StepOf<"sheet.read">> = stubHandler("sheet.read");
