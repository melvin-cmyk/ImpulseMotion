/**
 * One console conversation of the caller.
 *
 * GET    → its messages
 * PUT    → create or replace it ({ messages }) — the id is the uuid the
 *          console generated; an id owned by someone else answers 404
 * DELETE → remove it
 *
 * Every query is filtered by the session's userId: a conversation is only
 * ever visible to the consultant who wrote it.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { CONSOLE_MAX_CONVERSATIONS, conversationTitle, isConversationId, parseStoredMessages, sanitizeConsoleMessages } from "@/lib/console-conversations";

const NOT_FOUND = () => NextResponse.json({ error: "not found" }, { status: 404 });
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  if (!isConversationId(id)) return NOT_FOUND();
  const row = await prisma.consoleConversation.findFirst({ where: { id, userId: guard.session.userId } });
  if (!row) return NOT_FOUND();
  return NextResponse.json({ id: row.id, title: row.title, updatedAt: row.updatedAt.getTime(), messages: parseStoredMessages(row.messagesJson) }, { headers: NO_STORE });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  if (!isConversationId(id)) return NextResponse.json({ error: "conversation invalide" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const messages = sanitizeConsoleMessages(body?.messages);
  if (!messages) return NextResponse.json({ error: "messages invalid" }, { status: 400 });
  if (!messages.length) return NextResponse.json({ ok: true, saved: false });

  const userId = guard.session.userId;
  const existing = await prisma.consoleConversation.findUnique({ where: { id }, select: { userId: true } });
  if (existing && existing.userId !== userId) return NOT_FOUND();

  const data = { title: conversationTitle(messages), messagesJson: JSON.stringify(messages) };
  const row = existing
    ? await prisma.consoleConversation.update({ where: { id }, data })
    : await prisma.consoleConversation.create({ data: { id, userId, ...data } });

  // Keep the most recent conversations of the consultant only.
  const stale = await prisma.consoleConversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    skip: CONSOLE_MAX_CONVERSATIONS,
    select: { id: true },
  });
  if (stale.length) await prisma.consoleConversation.deleteMany({ where: { userId, id: { in: stale.map((s) => s.id) } } });

  return NextResponse.json({ ok: true, saved: true, id: row.id, title: row.title, updatedAt: row.updatedAt.getTime() });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  if (!isConversationId(id)) return NOT_FOUND();
  const { count } = await prisma.consoleConversation.deleteMany({ where: { id, userId: guard.session.userId } });
  return count ? NextResponse.json({ ok: true }) : NOT_FOUND();
}
