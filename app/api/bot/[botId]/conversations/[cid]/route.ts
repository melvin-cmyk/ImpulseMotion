/**
 * /api/bot/[botId]/conversations/[cid] — one of the caller's threads.
 *   GET    → { conversation: { id, title, updatedAt, messages: BotMessage[] } }
 *   DELETE → { ok: true }
 * A thread owned by someone else is a 404 (never reveal it exists).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { loadBotFor } from "@/lib/bot-access";
import { parseMessages } from "@/lib/bot-types";

type Params = { params: Promise<{ botId: string; cid: string }> };

async function guardConversation(botId: string, cid: string) {
  const guard = await requireSession();
  if ("error" in guard) return { error: guard.error } as const;
  const loaded = await loadBotFor(guard.session, botId);
  if (loaded.status !== 200) {
    return { error: NextResponse.json({ error: loaded.status === 403 ? "forbidden" : "not found" }, { status: loaded.status }) } as const;
  }
  const conversation = await prisma.botConversation.findFirst({
    where: { id: cid, botId, userId: guard.session.userId },
    select: { id: true, title: true, updatedAt: true, messagesJson: true },
  });
  if (!conversation) return { error: NextResponse.json({ error: "not found" }, { status: 404 }) } as const;
  return { session: guard.session, conversation } as const;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { botId, cid } = await params;
  const g = await guardConversation(botId, cid);
  if ("error" in g) return g.error;
  const { messagesJson, ...rest } = g.conversation;
  return NextResponse.json({ conversation: { ...rest, messages: parseMessages(messagesJson) } });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { botId, cid } = await params;
  const g = await guardConversation(botId, cid);
  if ("error" in g) return g.error;
  await prisma.botConversation.delete({ where: { id: g.conversation.id } });
  return NextResponse.json({ ok: true });
}
