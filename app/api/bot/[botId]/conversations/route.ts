/**
 * /api/bot/[botId]/conversations — the caller's own threads on one bot.
 *   GET  → { conversations: [{ id, title, updatedAt, jobId }] } (50 most recent;
 *          jobId = detached turn still running on that thread, else null)
 *   POST → { conversation: { id, title, updatedAt } } (new, empty)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { loadBotFor } from "@/lib/bot-access";
import { runningConversationIds } from "@/lib/ai-jobs";

const MAX_CONVERSATIONS = 100;
const MAX_LIST = 50;

async function guardBot(botId: string) {
  const guard = await requireSession();
  if ("error" in guard) return { error: guard.error } as const;
  const loaded = await loadBotFor(guard.session, botId);
  if (loaded.status !== 200) {
    return { error: NextResponse.json({ error: loaded.status === 403 ? "forbidden" : "not found" }, { status: loaded.status }) } as const;
  }
  return { session: guard.session, bot: loaded.bot } as const;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;
  const g = await guardBot(botId);
  if ("error" in g) return g.error;
  const rows = await prisma.botConversation.findMany({
    where: { botId, userId: g.session.userId },
    select: { id: true, title: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: MAX_LIST,
  });
  // `jobId`: a reply is being produced on that thread (detached turn).
  const running = await runningConversationIds(rows.map((r) => r.id), g.session.userId);
  const conversations = rows.map((r) => ({ ...r, jobId: running.get(r.id) ?? null }));
  return NextResponse.json({ conversations }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;
  const g = await guardBot(botId);
  if ("error" in g) return g.error;
  // A bounded number of threads per person and bot: each one may carry a paid AI turn.
  const count = await prisma.botConversation.count({ where: { botId, userId: g.session.userId } });
  if (count >= MAX_CONVERSATIONS) {
    return NextResponse.json({ error: `Limite de ${MAX_CONVERSATIONS} conversations atteinte : supprimez-en une pour continuer.` }, { status: 429 });
  }
  const conversation = await prisma.botConversation.create({
    data: { botId, userId: g.session.userId, messagesJson: "[]" },
    select: { id: true, title: true, updatedAt: true },
  });
  return NextResponse.json({ conversation }, { status: 201 });
}
