/**
 * Detached AI turns ("jobs"): the assistants answer in the relay while the
 * consultant goes elsewhere, switches conversation, or closes the tab.
 *
 *   start    → the relay gets the turn with `detach: true` and answers a job
 *              id; the user message is written to the conversation at once
 *              and an AiJob row (running) names the turn.
 *   end      → `finalizeAiJob` writes the assistant message and the usage
 *              ledger line, once: three paths may call it (the browser's
 *              reader of the stream, the relay's completion webhook, the
 *              reconciliation of the lists) and only the first one that
 *              claims the running row does the writes.
 *   lists    → `listJobs` reconciles the caller's running jobs with the relay
 *              before answering (a webhook that never came, a relay restart).
 *
 * Surfaces: the private client bots (BotConversation), the staff console
 * (ConsoleConversation), designs, the Analyse Ads copilot and Mo (MoBoard).
 */

import { prisma } from "@/lib/prisma";
import { recordAiUsage, type UsageContext } from "@/lib/ai-usage";
import { answerText, summaryFromRelayState, type AiJobSummary } from "@/lib/ai-job-summary";
import { relayDetach, relayJobState, relayJobStop, type RelayChatBody, type RelayJobState } from "@/lib/relay-chat";
import { parseMessages, serializeMessages, type BotMessage } from "@/lib/bot-types";
import { conversationTitle, parseStoredMessages, type StoredConsoleMessage } from "@/lib/console-conversations";
import { appendDesignMessages } from "@/lib/design/thread";
import { appendAnalyseMessages } from "@/lib/ads-warehouse/copilot-thread";
import { syncDesignOutputsToDrive } from "@/lib/design/drive-sync";
import { appendMoAnswer } from "@/lib/mo/thread";
import { closeMoTurnByJob } from "@/lib/mo/turns";

export type AiJobSurface = "bot" | "console" | "design" | "analyse" | "mo";
export type AiJobStatus = "running" | "done" | "stopped" | "failed";

export const JOB_ID_RE = /^[a-f0-9]{32}$/;
const TITLE_CHARS = 60;
/** A running job younger than this is not checked against the relay (it has barely started). */
const RECONCILE_MIN_AGE_MS = 15_000;
/** A job the relay no longer knows, older than this, is given up. */
const LOST_AFTER_MS = 3 * 60_000;
/** Finished jobs listed to the browser (so it can announce « réponse prête »). */
const RECENT_FINISHED_MS = 3 * 60_000;

export interface AiJobRow {
  id: string;
  userId: string;
  surface: AiJobSurface;
  conversationId: string;
  botId: string | null;
  status: AiJobStatus;
  title: string;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export function jobTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > TITLE_CHARS ? oneLine.slice(0, TITLE_CHARS - 1).trimEnd() + "…" : oneLine;
}

// ── Surfaces ────────────────────────────────────────────────────────────────

export async function appendBotMessages(conversationId: string, messages: BotMessage[], title?: string | null): Promise<void> {
  const row = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { title: true, messagesJson: true } });
  if (!row) return; // deleted meanwhile: the answer goes nowhere
  await prisma.botConversation.update({
    where: { id: conversationId },
    data: {
      messagesJson: serializeMessages([...parseMessages(row.messagesJson), ...messages]),
      ...(row.title || !title ? {} : { title }),
    },
  });
}

/** Creates the console conversation on its first turn (the browser names it). */
export async function appendConsoleMessages(conversationId: string, userId: string, messages: StoredConsoleMessage[]): Promise<void> {
  const row = await prisma.consoleConversation.findUnique({ where: { id: conversationId }, select: { userId: true, messagesJson: true } });
  if (row && row.userId !== userId) return;
  if (!row) {
    await prisma.consoleConversation.create({ data: { id: conversationId, userId, title: conversationTitle(messages), messagesJson: JSON.stringify(messages) } });
    return;
  }
  const all = [...parseStoredMessages(row.messagesJson), ...messages];
  await prisma.consoleConversation.update({ where: { id: conversationId }, data: { messagesJson: JSON.stringify(all), title: conversationTitle(all) } });
}

// ── Start ───────────────────────────────────────────────────────────────────

export interface StartAiJobInput {
  relayBody: RelayChatBody;
  surface: AiJobSurface;
  userId: string;
  conversationId: string;
  botId?: string | null;
  /** First words of the question (lists, notifications). */
  title: string;
  usageContext: UsageContext;
}

export async function startAiJob(input: StartAiJobInput): Promise<{ jobId: string } | { error: string }> {
  const started = await relayDetach(input.relayBody, { surface: input.surface, conversationId: input.conversationId });
  if ("error" in started) return started;
  await prisma.aiJob.create({
    data: {
      id: started.jobId,
      userId: input.userId,
      surface: input.surface,
      conversationId: input.conversationId,
      botId: input.botId ?? null,
      title: jobTitle(input.title),
      usageContextJson: JSON.stringify(input.usageContext),
    },
  });
  return { jobId: started.jobId };
}

// ── End ─────────────────────────────────────────────────────────────────────

function statusOf(summary: AiJobSummary, relayStatus: string | null | undefined): Exclude<AiJobStatus, "running"> {
  if (relayStatus === "stopped") return "stopped";
  if (!summary.text.trim()) return "failed";
  return "done";
}

/** The assistant message for a job that produced no usable text. */
function failureText(summary: AiJobSummary, status: AiJobStatus): string {
  if (status === "stopped") return "_(réponse arrêtée avant le premier mot)_";
  return `_L'assistant n'a pas pu répondre${summary.error ? ` : ${summary.error}` : "."}_`;
}

/**
 * Ends a job once: the first caller that claims the running row writes the
 * assistant message and the ledger line; later callers get `finalized: false`.
 */
export async function finalizeAiJob(
  jobId: string,
  summary: AiJobSummary,
  opts: { relayStatus?: string | null; error?: string | null } = {},
): Promise<{ finalized: boolean; status: AiJobStatus; job: AiJobRow | null }> {
  const status = opts.error && !summary.text.trim() ? "failed" : statusOf(summary, opts.relayStatus);
  const error = opts.error ?? summary.error ?? null;
  const claimed = await prisma.aiJob.updateMany({
    where: { id: jobId, status: "running" },
    data: { status, finishedAt: new Date(), error: error ? error.slice(0, 500) : null },
  });
  const row = await prisma.aiJob.findUnique({ where: { id: jobId } });
  const job = row ? toRow(row) : null;
  if (claimed.count === 0 || !row) return { finalized: false, status: job?.status ?? status, job };

  // Ledger first: the session was paid for even when no usable text came back.
  if (summary.usage) {
    let ctx: UsageContext | null = null;
    try { ctx = JSON.parse(row.usageContextJson) as UsageContext; } catch { ctx = null; }
    if (ctx?.feature) await recordAiUsage(summary.usage, ctx);
  }

  const text = answerText(summary, status) ?? failureText(summary, status);
  const at = new Date().toISOString();
  try {
    if (row.surface === "bot") {
      await appendBotMessages(row.conversationId, [{ role: "assistant", content: text, at }]);
    } else if (row.surface === "design") {
      await appendDesignMessages(row.conversationId, [{ role: "assistant", content: text, at }]);
      // What the AI exported during this reply joins the client's Drive folder (best effort, in the background).
      void syncDesignOutputsToDrive(row.conversationId, row.startedAt.getTime() - 60_000).catch((e) => console.error(`[design-drive] ${row.conversationId} : ${e instanceof Error ? e.message : e}`));
    } else if (row.surface === "analyse") {
      await appendAnalyseMessages(row.conversationId, [{ role: "assistant", content: text, at }]);
    } else if (row.surface === "mo") {
      // Mo answers in cards: parsed and laid on the board here (lib/mo/model.ts); the measured turn gets its total time.
      await appendMoAnswer(row.conversationId, text, at);
      await closeMoTurnByJob(jobId, Date.now() - row.startedAt.getTime());
    } else if (row.surface === "console") {
      const toolCalls = summary.toolCalls.filter((t) => t.name);
      await appendConsoleMessages(row.conversationId, row.userId, [{
        id: `a-${jobId.slice(0, 12)}`,
        role: "assistant",
        content: text,
        ...(toolCalls.length ? { toolCalls, toolResults: toolCalls.map((t) => ({ id: t.id, content: "" as const, is_error: false })) } : {}),
        ...(summary.usage ? { usage: { cost: summary.usage.costUsd, turns: summary.usage.turns, duration: summary.usage.durationMs } } : {}),
      }]);
    }
  } catch (e) {
    console.error(`[ai-jobs] ${jobId} : réponse non enregistrée`, e instanceof Error ? e.message : e);
  }
  return { finalized: true, status, job: { ...job!, status } };
}

/** Ends a job from the relay's summary (webhook, reconciliation). */
export async function finalizeFromRelayState(jobId: string, state: RelayJobState) {
  return finalizeAiJob(jobId, summaryFromRelayState(state), { relayStatus: state.status });
}

/** Asks the relay to stop the job; the end is recorded from its final state. */
export async function stopAiJob(job: AiJobRow): Promise<{ status: AiJobStatus }> {
  const stopped = await relayJobStop(job.id);
  if ("missing" in stopped) {
    const r = await finalizeAiJob(job.id, { text: "", sawDone: false, usage: null, toolCalls: [], error: null, resumable: false }, { relayStatus: "stopped", error: "Tâche introuvable sur le serveur IA" });
    return { status: r.status };
  }
  if ("error" in stopped) throw new Error(stopped.error);
  // The CLI is given a moment to leave; the relay's state is then final.
  for (let i = 0; i < 20; i++) {
    const st = await relayJobState(job.id);
    if ("state" in st && st.state.status !== "running") {
      const r = await finalizeFromRelayState(job.id, st.state);
      return { status: r.status };
    }
    if ("missing" in st) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { status: "running" };
}

// ── Lists & reconciliation ──────────────────────────────────────────────────

function toRow(row: { id: string; userId: string; surface: string; conversationId: string; botId: string | null; status: string; title: string; error: string | null; startedAt: Date; finishedAt: Date | null }): AiJobRow {
  return { ...row, surface: row.surface as AiJobSurface, status: row.status as AiJobStatus };
}

/** Brings one running job up to date with the relay. Returns its current state. */
export async function reconcileJob(job: AiJobRow, now = Date.now()): Promise<AiJobRow> {
  if (job.status !== "running") return job;
  const age = now - job.startedAt.getTime();
  if (age < RECONCILE_MIN_AGE_MS) return job;
  const st = await relayJobState(job.id);
  if ("state" in st) {
    if (st.state.status === "running") return job;
    const r = await finalizeFromRelayState(job.id, st.state);
    return r.job ?? { ...job, status: r.status };
  }
  if ("missing" in st && age > LOST_AFTER_MS) {
    const r = await finalizeAiJob(job.id, { text: "", sawDone: false, usage: null, toolCalls: [], error: null, resumable: false }, { error: "Réponse perdue : le serveur IA a redémarré pendant la tâche. Renvoyez votre message." });
    return r.job ?? { ...job, status: r.status };
  }
  return job; // relay unreachable for now: still running as far as we know
}

/** The caller's running jobs (reconciled) and the ones that ended recently. */
export async function listJobs(userId: string): Promise<{ running: AiJobRow[]; finished: AiJobRow[] }> {
  const now = Date.now();
  const rows = await prisma.aiJob.findMany({
    where: { userId, OR: [{ status: "running" }, { finishedAt: { gte: new Date(now - RECENT_FINISHED_MS) } }] },
    orderBy: { startedAt: "desc" },
    take: 50,
  });
  const jobs = await Promise.all(rows.map((r) => reconcileJob(toRow(r), now)));
  return { running: jobs.filter((j) => j.status === "running"), finished: jobs.filter((j) => j.status !== "running") };
}

/** The running job of a conversation, reconciled, or null. */
export async function runningJobOf(conversationId: string, userId: string): Promise<AiJobRow | null> {
  const row = await prisma.aiJob.findFirst({ where: { conversationId, userId, status: "running" }, orderBy: { startedAt: "desc" } });
  if (!row) return null;
  const job = await reconcileJob(toRow(row));
  return job.status === "running" ? job : null;
}

/** How many detached turns of this person are running right now (any surface). */
export async function runningJobCount(userId: string): Promise<number> {
  return prisma.aiJob.count({ where: { userId, status: "running" } });
}

/** Conversation ids (of the given ones) that have a running job. */
export async function runningConversationIds(conversationIds: string[], userId: string): Promise<Map<string, string>> {
  if (!conversationIds.length) return new Map();
  const rows = await prisma.aiJob.findMany({ where: { conversationId: { in: conversationIds }, userId, status: "running" }, select: { id: true, conversationId: true } });
  return new Map(rows.map((r) => [r.conversationId, r.id]));
}

export async function loadJobFor(jobId: string, userId: string): Promise<AiJobRow | null> {
  if (!JOB_ID_RE.test(jobId)) return null;
  const row = await prisma.aiJob.findFirst({ where: { id: jobId, userId } });
  return row ? toRow(row) : null;
}

export async function loadJob(jobId: string): Promise<AiJobRow | null> {
  if (!JOB_ID_RE.test(jobId)) return null;
  const row = await prisma.aiJob.findUnique({ where: { id: jobId } });
  return row ? toRow(row) : null;
}

/** Where the browser opens the conversation of a job. */
export function jobHref(job: Pick<AiJobRow, "surface" | "conversationId" | "botId">): string {
  if (job.surface === "bot" && job.botId) return `/bot/${job.botId}?c=${job.conversationId}`;
  if (job.surface === "design") return `/design/${job.conversationId}`;
  if (job.surface === "analyse") return `/analyse?thread=${job.conversationId}`;
  if (job.surface === "mo") return `/mo?b=${job.conversationId}`;
  return `/ai?c=${job.conversationId}`;
}

export function publicJob(job: AiJobRow) {
  return {
    id: job.id,
    surface: job.surface,
    conversationId: job.conversationId,
    botId: job.botId,
    status: job.status,
    title: job.title,
    error: job.error,
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    href: jobHref(job),
  };
}
export type PublicAiJob = ReturnType<typeof publicJob>;
