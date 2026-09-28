/**
 * GET /api/relay/conversations — the caller's own console conversations
 * (title and date only), most recent first. Nobody else can list them.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { CONSOLE_MAX_CONVERSATIONS } from "@/lib/console-conversations";

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const rows = await prisma.consoleConversation.findMany({
    where: { userId: guard.session.userId },
    orderBy: { updatedAt: "desc" },
    take: CONSOLE_MAX_CONVERSATIONS,
    select: { id: true, title: true, updatedAt: true },
  });
  return NextResponse.json(
    { conversations: rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.getTime() })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
