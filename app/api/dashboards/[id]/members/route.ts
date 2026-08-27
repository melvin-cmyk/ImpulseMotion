/**
 * GET /api/dashboards/[id]/members → staff: client logins attached to the dashboard
 * PUT /api/dashboards/[id]/members → admin: replace the member list
 *   Body: { userIds: string[] } — only existing users with role "client" are kept
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff, requireAdmin } from "@/lib/auth-helpers";

const memberSelect = {
  id: true,
  userId: true,
  user: { select: { id: true, email: true, name: true } },
} as const;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const dashboard = await prisma.dashboard.findUnique({ where: { id }, select: { id: true } });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });

  const members = await prisma.dashboardMember.findMany({
    where: { dashboardId: id },
    select: memberSelect,
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ members });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const dashboard = await prisma.dashboard.findUnique({ where: { id }, select: { id: true } });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!Array.isArray(body?.userIds) || !body.userIds.every((u: unknown) => typeof u === "string")) {
    return NextResponse.json({ error: "userIds doit être un tableau d'identifiants" }, { status: 400 });
  }
  const userIds: string[] = [...new Set<string>(body.userIds)];

  // Only existing "client" logins can be attached; other ids are silently dropped.
  const clients = await prisma.user.findMany({
    where: { id: { in: userIds }, role: "client" },
    select: { id: true },
  });
  const clientIds = clients.map((c) => c.id);

  await prisma.$transaction([
    prisma.dashboardMember.deleteMany({ where: { dashboardId: id } }),
    prisma.dashboardMember.createMany({
      data: clientIds.map((userId) => ({ dashboardId: id, userId })),
      skipDuplicates: true,
    }),
  ]);

  const members = await prisma.dashboardMember.findMany({
    where: { dashboardId: id },
    select: memberSelect,
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ members });
}
