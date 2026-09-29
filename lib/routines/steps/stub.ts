/**
 * Routines — placeholder handler, used by every step file until its lot
 * replaces it. It refuses the step at validation, so no definition containing
 * it can be applied, and fails cleanly if it is run anyway. To delete once the
 * last step file stops importing it.
 */

import { STEP_WRITES, type StepHandler, type StepOf, type StepRunOutcome, type StepType } from "@/lib/routines/types";

export const STUB_MESSAGE = "étape pas encore disponible";

export function stubHandler<T extends StepType>(type: T): StepHandler<StepOf<T>> {
  const message = `${type} : ${STUB_MESSAGE}`;
  const failed = (rowsIn: number): StepRunOutcome => ({
    status: "failed", rowsIn, rowsOut: 0,
    output: {}, planned: [], written: [], warnings: [],
    error: { class: "functional", message },
  });
  const handler: StepHandler = {
    type,
    writes: STEP_WRITES[type],
    validate: () => ({ ok: false, error: message }),
    preflight: async () => [],
    run: async (_step, ctx) => failed(ctx.input?.rows.length ?? 0),
  };
  // Generic over T, the compiler cannot relate `type` to StepOf<T>["type"]; the value is the same.
  return handler as unknown as StepHandler<StepOf<T>>;
}
