/**
 * /api/bot/[botId]/conversations — the caller's own threads on one bot.
 *   GET  → { conversations: [{ id, title, updatedAt }] } (50 most recent)
 *   POST → { conversation: { id, title, updatedAt } } (new, empty)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { loadBotFor } from "@/lib/bot-access";

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
  const conversations = await prisma.botConversation.findMany({
    where: { botId, userId: g.session.userId },
    select: { id: true, title: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: MAX_LIST,
  });
  return NextResponse.json({ conversations });
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;
  const g = await guardBot(botId);
  if ("error" in g) return g.error;
  const conversation = await prisma.botConversation.create({
    data: { botId, userId: g.session.userId, messagesJson: "[]" },
    select: { id: true, title: true, updatedAt: true },
  });
  return NextResponse.json({ conversation }, { status: 201 });
}
