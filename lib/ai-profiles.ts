/**
 * Named model / effort profiles for the relay (server/relay.mjs).
 *
 * One place decides which model each AI surface runs on, so token spend is a
 * product decision rather than a per-route accident:
 *
 * - STAFF_CHAT: the internal chats that drive MCP tools (console /ai,
 *   dashboard copilot, report chat). Opus 5 at LOW effort: the strongest model
 *   for tool orchestration, with the smallest thinking budget — most of the
 *   value there is in reading tool results, not in long deliberation.
 * - HQ_CONTEXT: the deterministic "what do we know about this client" lookup
 *   in HQ before a report. A few file reads and a compact brief: Sonnet, low
 *   effort, short turn cap.
 * - One-shot writers (report body, creative analysis, action plans) keep the
 *   relay default (no profile): everything they need is inline in the prompt.
 *
 * Overridable without a deploy through env vars on Vercel.
 */

import type { RelayEffort, RelayModel } from "@/lib/relay-chat";

export interface AiProfile {
  model: RelayModel;
  effort: RelayEffort;
  maxTurns?: number;
}

const MODELS: ReadonlySet<string> = new Set<RelayModel>(["sonnet", "opus"]);
const EFFORTS: ReadonlySet<string> = new Set<RelayEffort>(["low", "medium", "high"]);

function fromEnv(modelVar: string, effortVar: string, fallback: AiProfile): AiProfile {
  const model = process.env[modelVar];
  const effort = process.env[effortVar];
  return {
    ...fallback,
    model: model && MODELS.has(model) ? (model as RelayModel) : fallback.model,
    effort: effort && EFFORTS.has(effort) ? (effort as RelayEffort) : fallback.effort,
  };
}

/** Staff chats with MCP tools: console /ai, copilote dashboard, chat rapport. */
export const STAFF_CHAT_PROFILE: AiProfile = fromEnv("AI_STAFF_MODEL", "AI_STAFF_EFFORT", { model: "opus", effort: "low" });

/** HQ client-context lookup before a report (lib/hq-client-context.ts). */
export const HQ_CONTEXT_PROFILE: AiProfile = fromEnv("AI_HQ_MODEL", "AI_HQ_EFFORT", { model: "sonnet", effort: "low", maxTurns: 15 });
