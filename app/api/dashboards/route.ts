/**
 * GET  /api/dashboards            → staff: all dashboards (?userId= filters); client: their own
 * POST /api/dashboards            → staff only: create a (provisioned) dashboard for a client
 *   Body: { userId, name? }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, requireStaff } from "@/lib/auth-helpers";
import { isStaff } from "@/lib/dashboard-auth";
import { provisionDashboardsForUser } from "@/lib/dashboard-widgets";

export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { session } = guard;

  const userIdParam = req.nextUrl.searchParams.get("userId");
  const where = isStaff(session)
    ? userIdParam ? { userId: userIdParam } : {}
    : { userId: session.userId };

  const dashboards = await prisma.dashboard.findMany({
    where,
    include: {
      user: { select: { id: true, email: true, name: true } },
      _count: { select: { widgets: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json({ dashboards });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => null);
  const userId = typeof body?.userId === "string" ? body.userId : null;
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  // Provisions one dashboard per ACL ad account (idempotent).
  const dashboards = await provisionDashboardsForUser(userId);
  return NextResponse.json({ dashboards, dashboard: dashboards[0] ?? null });
}
