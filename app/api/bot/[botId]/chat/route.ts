/**
 * POST /api/bot/[botId]/chat → SSE stream of the assistant's answer.
 *   body { conversationId, message }
 *
 * The route owns persistence so the browser never writes messages itself:
 *   1. loads the caller's conversation (owner = session.userId, else 404);
 *   2. builds the system prompt (business context + enabled sources + data
 *      coverage) and calls the relay with MCP servers derived from the sources,
 *      account / data scopes derived from the dashboard (server-side scoping:
 *      the model never picks an account or a client_key);
 *   3. TEES the relay's SSE body: bytes go to the browser untouched while the
 *      `delta` events are accumulated; on `done` (or stream end with text) the
 *      user + assistant messages are appended to messagesJson and the title is
 *      set from the first user message.
 *
 * Events forwarded as-is: init, delta {text}, tool_call {name}, tool_result,
 * content, usage, error {message}, done.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { loadBotFor } from "@/lib/bot-access";
import { parseMessages, parseSources, serializeMessages, serversForSources, type BotMessage } from "@/lib/bot-types";
import { buildBotSystemPrompt, type BotDataCoverage } from "@/lib/bot-prompt";
import { relayStream, type RelayChatBody, type RelayMessage } from "@/lib/relay-chat";

export const maxDuration = 120;

const MAX_HISTORY = 30;
const MAX_MESSAGE_CHARS = 12000;
const TITLE_CHARS = 60;
/** Under maxDuration, leaving room for the persistence write after `done`. */
const BUDGET_MS = 105_000;

/**
 * Data coverage for the prompt. `lib/client-data.ts` (warehouse access) is
 * owned by another part of the codebase and may be absent or unconfigured
 * (no DATA_DATABASE_URL); either way the bot must still answer.
 */
async function loadCoverage(clientKey: string): Promise<BotDataCoverage | null> {
  try {
    const mod = (await import("@/lib/client-data")) as {
      getCoverage?: (key: string) => Promise<BotDataCoverage | null>;
    };
    if (typeof mod.getCoverage !== "function") return null;
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
    return await Promise.race([mod.getCoverage(clientKey), timeout]);
  } catch {
    return null;
  }
}

function toRelayMessages(history: BotMessage[]): RelayMessage[] {
  return history
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > TITLE_CHARS ? oneLine.slice(0, TITLE_CHARS - 1).trimEnd() + "…" : oneLine;
}

/**
 * Wraps the relay's SSE body: forwards every byte and accumulates the text
 * deltas; `onFinish(text, sawDone)` runs once when the stream ends.
 */
function teeSse(
  source: ReadableStream<Uint8Array>,
  onFinish: (text: string, sawDone: boolean) => Promise<void>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let sawDone = false;
  let finished = false;

  const finish = async () => {
    if (finished) return;
    finished = true;
    try { await onFinish(text, sawDone); } catch (e) { console.error("[bot/chat] persist failed", e); }
  };

  const parseLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    let evt: { type?: string; text?: string };
    try { evt = JSON.parse(payload); } catch { return; }
    if (evt.type === "delta" && typeof evt.text === "string") text += evt.text;
    else if (evt.type === "content" && typeof evt.text === "string" && !text) text = evt.text;
    else if (evt.type === "done") sawDone = true;
  };

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) parseLine(line);
      },
      async flush() {
        if (buffer) parseLine(buffer);
        await finish();
      },
    }),
  );
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

  const sources = parseSources(bot.sourcesJson);
  const history = parseMessages(conversation.messagesJson);
  const userMessage: BotMessage = { role: "user", content: message, at: new Date().toISOString() };
  const thread = [...history, userMessage];

  const coverage = sources.data ? await loadCoverage(bot.clientKey) : null;
  const systemPrompt = buildBotSystemPrompt({ bot, dashboard: bot.dashboard, coverage });

  const accountScope: NonNullable<RelayChatBody["accountScope"]> = {};
  if (sources.meta && bot.dashboard.metaAccountId) accountScope.meta = [bot.dashboard.metaAccountId];
  if (sources.google && bot.dashboard.googleCustomerId) accountScope.google = [bot.dashboard.googleCustomerId];

  const relayBody: RelayChatBody = {
    messages: toRelayMessages(thread),
    systemPrompt,
    allowedServers: serversForSources(sources),
    accountScope,
    budgetMs: BUDGET_MS,
    // Client bots — and only them — run on Amazon Bedrock (AWS, EU region).
    provider: "bedrock",
  };
  if (sources.data || sources.ga4PropertyId) {
    relayBody.dataScope = { clientKey: bot.clientKey, ga4PropertyId: sources.ga4PropertyId };
  }

  const upstream = await relayStream(relayBody);
  if (upstream.status !== 200 || !upstream.body) return upstream;

  const persist = async (text: string, sawDone: boolean) => {
    const answer = text.trim();
    if (!answer) return; // nothing usable: leave the thread untouched, the UI keeps the draft
    const assistant: BotMessage = {
      role: "assistant",
      content: sawDone ? answer : `${answer}\n\n_(réponse possiblement tronquée)_`,
      at: new Date().toISOString(),
    };
    await prisma.botConversation.update({
      where: { id: conversation.id },
      data: {
        messagesJson: serializeMessages([...thread, assistant]),
        title: conversation.title ?? titleFrom(thread.find((m) => m.role === "user")?.content ?? message),
      },
    });
  };

  return new Response(teeSse(upstream.body, persist), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
