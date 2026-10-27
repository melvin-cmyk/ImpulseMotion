/**
 * Analyse Ads copilot — detached replies, so the consultant can leave the page
 * and come back (lib/ai-jobs.ts, surface "analyse").
 *   GET  ?accountKey=…            → { threadId, messages, jobId } (jobId = a reply still running)
 *   POST { ...report query, accountKey, clientParam?, message, groupLabel?, clientName? } → 202 { jobId, threadId }
 * The server re-runs the report query (scope-safe) to give the model the
 * context, then starts the turn on the relay; the answer is appended to the
 * thread when the job ends, and the browser follows it through /api/ai/jobs.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";
import { queryAds } from "@/lib/ads-warehouse/query";
import { buildAnalyseContext, buildAnalyseSystemPrompt } from "@/lib/ads-warehouse/copilot";
import { appendAnalyseMessages, ensureAnalyseThread, parseAnalyseMessages } from "@/lib/ads-warehouse/copilot-thread";
import { STAFF_CHAT_PROFILE } from "@/lib/ai-profiles";
import { runningJobCount, startAiJob } from "@/lib/ai-jobs";
import type { RelayMessage } from "@/lib/relay-chat";

export const maxDuration = 60;
const MAX_HISTORY = 12;
const KEY_RE = /^(client|meta):[\w-]{3,40}$/;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const accountKey = req.nextUrl.searchParams.get("accountKey") ?? "";
  const threadId = req.nextUrl.searchParams.get("threadId") ?? "";
  // By thread id (the « réponse prête » notice) or by account key (the panel of the report).
  const thread = /^[a-z0-9]{10,40}$/i.test(threadId)
    ? await prisma.analyseThread.findFirst({ where: { id: threadId, userId: guard.session.userId } })
    : KEY_RE.test(accountKey) ? await prisma.analyseThread.findUnique({ where: { accountKey_userId: { accountKey, userId: guard.session.userId } } }) : null;
  if (!thread) return NextResponse.json({ threadId: null, accountKey: null, clientParam: null, messages: [], jobId: null }, { headers: { "Cache-Control": "no-store" } });
  const running = await prisma.aiJob.findFirst({ where: { conversationId: thread.id, surface: "analyse", status: "running" }, select: { id: true } });
  return NextResponse.json({ threadId: thread.id, accountKey: thread.accountKey, clientParam: thread.clientParam, messages: parseAnalyseMessages(thread.messagesJson), jobId: running?.id ?? null }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const clone = req.clone();
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  const body = (await clone.json().catch(() => ({}))) as { accountKey?: string; clientParam?: string | null; message?: string; groupLabel?: string; clientName?: string };
  const accountKey = body.accountKey ?? "";
  const message = (body.message ?? "").trim().slice(0, 6000);
  if (!KEY_RE.test(accountKey) || !message) return NextResponse.json({ error: "accountKey et message attendus" }, { status: 400 });
  if (await runningJobCount(guard.session.userId) >= 3) return NextResponse.json({ error: "3 réponses sont déjà en cours sur votre compte. Attendez qu'une se termine." }, { status: 429 });

  const thread = await ensureAnalyseThread(accountKey, guard.session.userId, body.clientParam ?? null);
  const running = await prisma.aiJob.findFirst({ where: { conversationId: thread.id, surface: "analyse", status: "running" }, select: { id: true } });
  if (running) return NextResponse.json({ error: "Le copilote répond déjà. Attendez la fin de sa réponse.", jobId: running.id, threadId: thread.id }, { status: 409 });

  const result = await queryAds({ ...parsed.q, limit: 40, offset: 0 });
  const context = result.rows.length
    ? buildAnalyseContext(parsed.q, result, { clientName: body.clientName?.slice(0, 80) ?? null, groupLabel: body.groupLabel?.slice(0, 40) ?? parsed.q.groupBy })
    : "Le rapport affiché est vide sur cette période (aucune annonce ne correspond aux filtres).";
  const systemPrompt = `${buildAnalyseSystemPrompt()}\n\n=== RAPPORT AFFICHÉ ===\n${context}`;
  const at = new Date().toISOString();
  const history: RelayMessage[] = [...parseAnalyseMessages(thread.messagesJson), { role: "user" as const, content: message, at }].slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: m.content }));
  await appendAnalyseMessages(thread.id, [{ role: "user", content: message, at }]);
  const started = await startAiJob({
    relayBody: { messages: history, systemPrompt, sessionKey: `analyse:${thread.id}`, allowedServers: [], accountScope: {}, model: STAFF_CHAT_PROFILE.model, effort: STAFF_CHAT_PROFILE.effort, maxTurns: 1, budgetMs: 150_000 },
    surface: "analyse",
    userId: guard.session.userId,
    conversationId: thread.id,
    title: message,
    usageContext: { feature: "analyse_copilot", clientName: body.clientName ?? accountKey, user: { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "" } },
  });
  if ("error" in started) {
    await appendAnalyseMessages(thread.id, [{ role: "assistant", content: `_Le copilote n'a pas pu démarrer : ${started.error}_`, at: new Date().toISOString() }]);
    return NextResponse.json({ error: started.error }, { status: 502 });
  }
  return NextResponse.json({ jobId: started.jobId, threadId: thread.id }, { status: 202 });
}
