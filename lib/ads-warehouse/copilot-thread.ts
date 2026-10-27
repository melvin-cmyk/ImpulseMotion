/** Analyse Ads copilot threads (AnalyseThread): stored messages per consultant and client, appended when a detached reply ends. */

import { prisma } from "@/lib/prisma";

export interface AnalyseMessage { role: "user" | "assistant"; content: string; at: string }
const MAX_MESSAGES = 60;

export function parseAnalyseMessages(json: string | null | undefined): AnalyseMessage[] {
  try {
    const list = JSON.parse(json || "[]");
    return Array.isArray(list) ? list.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").map((m) => ({ role: m.role, content: m.content, at: typeof m.at === "string" ? m.at : new Date(0).toISOString() })) : [];
  } catch { return []; }
}

export async function ensureAnalyseThread(accountKey: string, userId: string, clientParam: string | null) {
  return prisma.analyseThread.upsert({ where: { accountKey_userId: { accountKey, userId } }, create: { accountKey, userId, clientParam }, update: { clientParam: clientParam ?? undefined } });
}

export async function appendAnalyseMessages(threadId: string, messages: AnalyseMessage[]): Promise<void> {
  const row = await prisma.analyseThread.findUnique({ where: { id: threadId }, select: { messagesJson: true } });
  if (!row) return;
  const next = [...parseAnalyseMessages(row.messagesJson), ...messages].slice(-MAX_MESSAGES);
  await prisma.analyseThread.update({ where: { id: threadId }, data: { messagesJson: JSON.stringify(next) } });
}
