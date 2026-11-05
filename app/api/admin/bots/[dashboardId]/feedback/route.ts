/** GET /api/admin/bots/[dashboardId]/feedback → the last 100 client feedbacks on this bot (real admins). */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRealAdmin } from "@/lib/auth-helpers";

export async function GET(_req: Request, { params }: { params: Promise<{ dashboardId: string }> }) {
  const guard = await requireRealAdmin();
  if ("error" in guard) return guard.error;
  const { dashboardId } = await params;
  const bot = await prisma.clientBot.findUnique({ where: { dashboardId }, select: { id: true } });
  if (!bot) return NextResponse.json({ feedback: [] });
  const rows = await prisma.botFeedback.findMany({
    where: { botId: bot.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, rating: true, message: true, conversationId: true, createdAt: true, user: { select: { email: true, name: true } } },
  });
  return NextResponse.json({
    feedback: rows.map((r) => ({ id: r.id, rating: r.rating, message: r.message, conversationId: r.conversationId, createdAt: r.createdAt, email: r.user.email, name: r.user.name })),
  });
}
