/**
 * GET /api/relay/conversations — the caller's own console conversations
 * (title and date only, plus `jobId` when a detached turn is still running
 * on it), most recent first. Nobody else can list them.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { CONSOLE_MAX_CONVERSATIONS } from "@/lib/console-conversations";
import { runningConversationIds } from "@/lib/ai-jobs";

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const rows = await prisma.consoleConversation.findMany({
    where: { userId: guard.session.userId },
    orderBy: { updatedAt: "desc" },
    take: CONSOLE_MAX_CONVERSATIONS,
    select: { id: true, title: true, updatedAt: true },
  });
  const running = await runningConversationIds(rows.map((r) => r.id), guard.session.userId);
  return NextResponse.json(
    { conversations: rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.getTime(), jobId: running.get(r.id) ?? null })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
