import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

/** Liste tous les dashboards (= clients) avec l'état de leur bot privé. Admin only. */
export async function GET() {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const dashboards = await prisma.dashboard.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      metaAccountId: true,
      googleCustomerId: true,
      user: { select: { email: true } },
      bot: {
        select: {
          id: true,
          enabled: true,
          name: true,
          clientKey: true,
          lastIngestAt: true,
          _count: { select: { accesses: true } },
        },
      },
    },
  });

  return NextResponse.json({
    dashboards: dashboards.map((d) => ({
      id: d.id,
      name: d.name,
      metaAccountId: d.metaAccountId,
      googleCustomerId: d.googleCustomerId,
      ownerEmail: d.user.email,
      bot: d.bot
        ? {
            id: d.bot.id,
            enabled: d.bot.enabled,
            name: d.bot.name,
            clientKey: d.bot.clientKey,
            accessCount: d.bot._count.accesses,
            lastIngestAt: d.bot.lastIngestAt,
          }
        : null,
    })),
  });
}
