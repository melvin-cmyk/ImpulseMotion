/**
 * POST /api/bot/[botId]/chat → starts a detached turn of the assistant.
 *   body { conversationId, message }   →   202 { jobId, conversationId }
 *
 * The answer is produced by the relay whatever the browser does next (the
 * client may switch conversation, open a dashboard, close the tab). The
 * browser follows it through GET /api/ai/jobs/[jobId]/events and reloads the
 * conversation when it is over; the answer is stored by lib/ai-jobs.ts.
 *
 * The route owns persistence so the browser never writes messages itself:
 *   1. loads the caller's conversation (owner = session.userId, else 404);
 *   2. builds the system prompt (business context + enabled sources + data
 *      coverage + loaded datasets, memoised in lib/bot-context.ts) and the
 *      relay body with MCP servers derived from the sources, account / data
 *      scopes derived from the dashboard (server-side scoping: the model
 *      never picks an account or a client_key; the TikTok advertisers are
 *      the ones attached to the dashboard);
 *   3. writes the user message to the thread, starts the relay job, records
 *      it (AiJob) with the ledger context of its usage line.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isStaff, requireSession } from "@/lib/auth-helpers";
import { loadBotFor } from "@/lib/bot-access";
import { parseMessages, parseSources, serversForSources, type BotMessage } from "@/lib/bot-types";
import { buildBotSystemPrompt } from "@/lib/bot-prompt";
import { loadBotCoverage, loadBotDatasets } from "@/lib/bot-context";
import { getDashboardTikTokIds } from "@/lib/tiktok-accounts";
import type { RelayChatBody, RelayMessage } from "@/lib/relay-chat";
import { appendBotMessages, jobTitle, runningJobCount, runningJobOf, startAiJob } from "@/lib/ai-jobs";
import { botDailyCap, botMessagesToday, readQuotas } from "@/lib/quotas";

const MAX_RUNNING_JOBS_PER_USER = 3;

const MAX_HISTORY = 30;
const MAX_MESSAGE_CHARS = 12000;
/** Detached: the relay allows a long turn; the browser is not holding a function open. */
const BUDGET_MS = 10 * 60_000;

function toRelayMessages(history: BotMessage[]): RelayMessage[] {
  return history
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { botId } = await params;
  const loaded = await loadBotFor(guard.session, botId);
  if (loaded.status !== 200) {
    return NextResponse.json({ error: loaded.status === 403 ? "forbidden" : "not found" }, { status: loaded.status });
  }
  const { bot } = loaded;

  const body = (await req.json().catch(() => ({}))) as { conversationId?: unknown; message?: unknown };
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE_CHARS) : "";
  if (!conversationId || !message) return NextResponse.json({ error: "conversationId et message requis" }, { status: 400 });

  const conversation = await prisma.botConversation.findFirst({
    where: { id: conversationId, botId: bot.id, userId: guard.session.userId },
    select: { id: true, title: true, messagesJson: true },
  });
  if (!conversation) return NextResponse.json({ error: "not found" }, { status: 404 });
  const running = await runningJobOf(conversation.id, guard.session.userId);
  if (running) return NextResponse.json({ error: "Une réponse est déjà en cours sur cette conversation. Attendez qu'elle soit terminée avant d'envoyer la suite.", jobId: running.id }, { status: 409 });
  // Every detached turn is a model call of up to ten minutes: a person gets a few at a time, not an unbounded fan-out.
  if (await runningJobCount(guard.session.userId) >= MAX_RUNNING_JOBS_PER_USER) {
    return NextResponse.json({ error: `${MAX_RUNNING_JOBS_PER_USER} réponses sont déjà en cours sur votre compte. Attendez qu'une se termine.` }, { status: 429 });
  }

  // Daily cap of the bot (its own, else the agency's — Admin → Quotas): all its users together, Paris day.
  const cap = botDailyCap(bot, await readQuotas());
  if (cap > 0 && (await botMessagesToday(bot.id)) >= cap) {
    return NextResponse.json({ error: `Le quota du jour de cet assistant est atteint (${cap} message${cap > 1 ? "s" : ""}). Il sera de nouveau disponible demain.` }, { status: 429 });
  }

  const sources = parseSources(bot.sourcesJson);
  // TikTok: read only when the admin ticked it, on the advertisers attached to
  // this dashboard. None attached → the source is dropped for this turn (no
  // server asked, nothing promised in the prompt).
  const tiktokIds = sources.tiktok ? await getDashboardTikTokIds(bot.dashboard.id) : [];
  if (!tiktokIds.length) delete sources.tiktok;
  const history = parseMessages(conversation.messagesJson);
  const userMessage: BotMessage = { role: "user", content: message, at: new Date().toISOString() };
  const thread = [...history, userMessage];

  const coverage = sources.data ? await loadBotCoverage(bot.clientKey) : null;
  // Files: announced only when at least one dataset is loaded (a ticked source
  // with nothing behind it is dropped for this turn, like TikTok).
  const datasets = sources.files ? await loadBotDatasets(bot.clientKey) : [];
  if (!datasets.length) delete sources.files;
  const systemPrompt = buildBotSystemPrompt({ bot: { ...bot, sources }, dashboard: bot.dashboard, coverage, tiktokAdvertiserIds: tiktokIds, datasets });

  const accountScope: NonNullable<RelayChatBody["accountScope"]> = {};
  if (sources.meta && bot.dashboard.metaAccountId) accountScope.meta = [bot.dashboard.metaAccountId];
  if (sources.google && bot.dashboard.googleCustomerId) accountScope.google = [bot.dashboard.googleCustomerId];
  if (tiktokIds.length) accountScope.tiktok = tiktokIds;

  const relayBody: RelayChatBody = {
    sessionKey: `bot:${conversation.id}`,
    messages: toRelayMessages(thread),
    systemPrompt,
    allowedServers: serversForSources(sources),
    accountScope,
    budgetMs: BUDGET_MS,
    // Client-bot restrictions (no HQ, no web) whoever is asking.
    clientBot: true,
  };
  // Amazon Bedrock (AWS, EU region) is for clients only: a consultant or an
  // admin trying a bot runs it on the agency's Claude Max accounts (rule of
  // 2026-10-01, Melvin).
  if (!isStaff(guard.session)) relayBody.provider = "bedrock";
  if (sources.data || sources.files || sources.ga4PropertyId) {
    const tools: Array<"orders" | "datasets"> = [];
    if (sources.data) tools.push("orders");
    if (sources.files) tools.push("datasets");
    relayBody.dataScope = { clientKey: bot.clientKey, ga4PropertyId: sources.ga4PropertyId, ...(tools.length ? { tools } : {}) };
  }

  // The question is part of the thread from now on; the answer joins it when
  // the job ends (whoever notices first: the browser's reader, the relay's
  // webhook, the reconciliation of the lists).
  await appendBotMessages(conversation.id, [userMessage], conversation.title ?? jobTitle(message));
  const started = await startAiJob({
    relayBody,
    surface: "bot",
    userId: guard.session.userId,
    conversationId: conversation.id,
    botId: bot.id,
    title: message,
    usageContext: {
      feature: "client_bot",
      dashboardId: bot.dashboard.id,
      clientName: bot.dashboard.name,
      botId: bot.id,
      clientKey: bot.clientKey,
      user: { id: guard.session.userId, email: guard.session.user?.email, role: guard.session.role },
    },
  });
  if ("error" in started) {
    await appendBotMessages(conversation.id, [{ role: "assistant", content: `_L'assistant n'a pas pu répondre : ${started.error}_`, at: new Date().toISOString() }]);
    return NextResponse.json({ error: started.error }, { status: 502 });
  }
  return NextResponse.json({ jobId: started.jobId, conversationId: conversation.id }, { status: 202 });
}
