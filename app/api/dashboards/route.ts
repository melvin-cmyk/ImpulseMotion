/**
 * GET  /api/dashboards            → staff: all dashboards (?userId= filters); client: owned or member
 * POST /api/dashboards            → staff only: create a (provisioned) dashboard for a client
 *   Body: { userId, name? }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, requireStaff } from "@/lib/auth-helpers";
import { isStaff } from "@/lib/dashboard-auth";
import { provisionDashboardsForUser, createDashboardForUser } from "@/lib/dashboard-widgets";

export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { session } = guard;

  const userIdParam = req.nextUrl.searchParams.get("userId");
  const staff = isStaff(session);
  const where = staff
    ? userIdParam ? { userId: userIdParam } : {}
    : { OR: [{ userId: session.userId }, { members: { some: { userId: session.userId } } }] };

  const dashboards = await prisma.dashboard.findMany({
    where,
    include: {
      user: { select: { id: true, email: true, name: true } },
      _count: { select: { widgets: true } },
      ...(staff
        ? { members: { include: { user: { select: { id: true, email: true, name: true } } } } }
        : {}),
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

  // Explicit creation: link a specific account (and its ACL grant) to a login.
  if (body.metaAccountId || body.googleCustomerId) {
    try {
      const dashboard = await createDashboardForUser({
        userId,
        name: typeof body.name === "string" ? body.name : undefined,
        metaAccountId: typeof body.metaAccountId === "string" ? body.metaAccountId : null,
        googleCustomerId: typeof body.googleCustomerId === "string" ? body.googleCustomerId : null,
      });
      return NextResponse.json({ dashboard });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "creation failed" }, { status: 400 });
    }
  }

  // Otherwise: provision one dashboard per ACL ad account (idempotent).
  const dashboards = await provisionDashboardsForUser(userId);
  return NextResponse.json({ dashboards, dashboard: dashboards[0] ?? null });
}
