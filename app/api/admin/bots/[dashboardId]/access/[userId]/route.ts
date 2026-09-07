import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

type Ctx = { params: Promise<{ dashboardId: string; userId: string }> };

export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const { dashboardId, userId } = await params;
  const bot = await prisma.clientBot.findUnique({ where: { dashboardId }, select: { id: true } });
  if (!bot) return NextResponse.json({ error: "bot not found" }, { status: 404 });

  const { count } = await prisma.clientBotAccess.deleteMany({ where: { botId: bot.id, userId } });
  return NextResponse.json({ ok: true, removed: count });
}
