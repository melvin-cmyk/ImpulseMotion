/**
 * POST /api/bot/[botId]/feedback { message, rating?: "up" | "down", conversationId?, question?, answer? }
 * — a client's feedback on their assistant: the box of the chat (free text), or
 * the thumbs under one answer (`answer` = that answer, `question` = what was
 * asked; only their start is kept). Read by the admins on
 * /admin/bots/[dashboardId]. 40 per person and per day at most.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { loadBotFor } from "@/lib/bot-access";

const MAX_CHARS = 2000;
const PER_DAY = 40;
const EXCERPT_CHARS = 600;

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error ?? bad("unauthorized", 401);
  const { botId } = await params;
  const loaded = await loadBotFor(guard.session, botId);
  if (loaded.status !== 200) return bad(loaded.status === 404 ? "assistant introuvable" : "accès refusé", loaded.status);

  const body = (await req.json().catch(() => ({}))) as { message?: unknown; rating?: unknown; conversationId?: unknown; question?: unknown; answer?: unknown };
  const excerpt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, EXCERPT_CHARS) : null);
  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_CHARS) : "";
  const rating = body.rating === "up" || body.rating === "down" ? body.rating : null;
  if (!message && !rating) return bad("écrivez quelques mots ou choisissez un avis");

  const since = new Date(Date.now() - 24 * 3600 * 1000);
  if ((await prisma.botFeedback.count({ where: { userId: guard.session.userId, createdAt: { gte: since } } })) >= PER_DAY) {
    return bad("Merci, vous avez déjà envoyé plusieurs retours aujourd'hui. Vous pourrez en envoyer d'autres demain.", 429);
  }
  // A conversation id is kept only when it belongs to this person on this bot.
  let conversationId: string | null = null;
  if (typeof body.conversationId === "string" && body.conversationId) {
    const c = await prisma.botConversation.findFirst({ where: { id: body.conversationId, botId: loaded.bot.id, userId: guard.session.userId }, select: { id: true } });
    conversationId = c?.id ?? null;
  }
  await prisma.botFeedback.create({
    data: { botId: loaded.bot.id, userId: guard.session.userId, rating, message: message || (rating === "up" ? "(avis positif)" : "(avis négatif)"), conversationId, question: excerpt(body.question), answerExcerpt: excerpt(body.answer) },
  });
  return NextResponse.json({ ok: true });
}
