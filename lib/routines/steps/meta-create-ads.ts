/** Routines — BOUCHON, remplacé par le lot C. Contrat d'export : voir lib/routines/steps/index.ts. */

import { stubHandler } from "@/lib/routines/steps/stub";
import type { StepHandler, StepOf } from "@/lib/routines/types";

export const metaCreateAdsHandler: StepHandler<StepOf<"meta.create_ads">> = stubHandler("meta.create_ads");
