/**
 * Routines — registry of the step handlers.
 *
 * FROZEN FILE: the lots replace the step files below and never edit this one.
 * Each file keeps its name and its export names, typed exactly as listed:
 *
 *   file                  export                  type
 *   ────────────────────  ──────────────────────  ─────────────────────────────────
 *   rows.ts               rowsFilterHandler       StepHandler<RowsFilterStep>        lot A
 *                         rowsSortHandler         StepHandler<RowsSortStep>
 *                         rowsLimitHandler        StepHandler<RowsLimitStep>
 *                         rowsSelectHandler       StepHandler<RowsSelectStep>
 *   sheet-read.ts         sheetReadHandler        StepHandler<SheetReadStep>         lot B
 *   sheet-write.ts        sheetWriteHandler       StepHandler<SheetWriteStep>        lot B
 *   google-insights.ts    googleInsightsHandler   StepHandler<GoogleInsightsStep>    lot B
 *   slack-message.ts      slackMessageHandler     StepHandler<SlackMessageStep>      lot B
 *   email-send.ts         emailSendHandler        StepHandler<EmailSendStep>         lot B
 *   meta-insights.ts      metaInsightsHandler     StepHandler<MetaInsightsStep>      lot C
 *   meta-create-ads.ts    metaCreateAdsHandler    StepHandler<MetaCreateAdsStep>     lot C
 *   ai-summary.ts         aiSummaryHandler        StepHandler<AiSummaryStep>         lot D
 *
 * Rules for a handler:
 *   - named export (no default export), `type` and `writes` equal to the step
 *     type and to STEP_WRITES[type] (lib/routines/types.ts) — tested;
 *   - `validate` takes untrusted input and rebuilds the step, no network;
 *   - `run` never writes when `ctx.write` is null (dry run): it fills
 *     `planned` instead. It returns a failed outcome rather than throwing;
 *   - a file may export more (helpers for its tests), never less.
 */

import type { RoutineStep, StepHandler, StepOf, StepType } from "@/lib/routines/types";
import { STEP_TYPES } from "@/lib/routines/types";
import { aiSummaryHandler } from "@/lib/routines/steps/ai-summary";
import { emailSendHandler } from "@/lib/routines/steps/email-send";
import { googleInsightsHandler } from "@/lib/routines/steps/google-insights";
import { metaCreateAdsHandler } from "@/lib/routines/steps/meta-create-ads";
import { metaInsightsHandler } from "@/lib/routines/steps/meta-insights";
import { rowsFilterHandler, rowsLimitHandler, rowsSelectHandler, rowsSortHandler } from "@/lib/routines/steps/rows";
import { sheetReadHandler } from "@/lib/routines/steps/sheet-read";
import { sheetWriteHandler } from "@/lib/routines/steps/sheet-write";
import { slackMessageHandler } from "@/lib/routines/steps/slack-message";

/** One handler per step type; a missing or mistyped one does not compile. */
export const STEP_HANDLERS: { readonly [T in StepType]: StepHandler<StepOf<T>> } = {
  "sheet.read": sheetReadHandler,
  "meta.insights": metaInsightsHandler,
  "google.insights": googleInsightsHandler,
  "rows.filter": rowsFilterHandler,
  "rows.sort": rowsSortHandler,
  "rows.limit": rowsLimitHandler,
  "rows.select": rowsSelectHandler,
  "ai.summary": aiSummaryHandler,
  "sheet.write": sheetWriteHandler,
  "slack.message": slackMessageHandler,
  "email.send": emailSendHandler,
  "meta.create_ads": metaCreateAdsHandler,
};

export function isStepType(value: unknown): value is StepType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STEP_HANDLERS, value);
}

/** Handler of a known step type, typed for that step. */
export function getStepHandler<T extends StepType>(type: T): StepHandler<StepOf<T>> {
  return STEP_HANDLERS[type];
}

/** Handler for a type read from untrusted input (definition, proposal); null when unknown. */
export function findStepHandler(type: unknown): StepHandler | null {
  return isStepType(type) ? (STEP_HANDLERS[type] as StepHandler) : null;
}

/** Handler of a validated step, seen as a handler of any step (what the engine loops on). */
export function handlerFor(step: RoutineStep): StepHandler {
  return STEP_HANDLERS[step.type] as StepHandler;
}

/** Step types that write somewhere (Sheet, message or platform). */
export const WRITING_STEP_TYPES: readonly StepType[] = STEP_TYPES.filter((t) => STEP_HANDLERS[t].writes !== "none");

/** Step types that write on an ad platform: they set Routine.writesPlatform. */
export const PLATFORM_WRITING_STEP_TYPES: readonly StepType[] = STEP_TYPES.filter((t) => STEP_HANDLERS[t].writes === "platform");

export function writesPlatform(steps: ReadonlyArray<{ type: StepType }>): boolean {
  return steps.some((s) => STEP_HANDLERS[s.type].writes === "platform");
}
