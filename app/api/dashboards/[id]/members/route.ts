/**
 * GET    /api/dashboards/[id]/members            → staff: people attached to the dashboard
 * POST   /api/dashboards/[id]/members            → admin: attach someone by email
 *   Body: { email, role: "consultant" | "client", name? }
 *   → { member, created, tempPassword? } (tempPassword shown once for a new login)
 * DELETE /api/dashboards/[id]/members?userId=…   → admin: detach (revokes bot + ACL too)
 */

import { denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff, requireAdmin } from "@/lib/auth-helpers";
import { addDashboardMember, removeDashboardMember, memberSelect, MemberError } from "@/lib/dashboard-members";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;

  const dashboard = await prisma.dashboard.findUnique({ where: { id }, select: { id: true } });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });

  const members = await prisma.dashboardMember.findMany({
    where: { dashboardId: id },
    select: memberSelect,
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ members });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const role = body?.role === "consultant" || body?.role === "client" ? body.role : null;
  if (!role) return NextResponse.json({ error: "role doit être consultant ou client" }, { status: 400 });

  try {
    const result = await addDashboardMember({
      dashboardId: id,
      email: String(body?.email ?? ""),
      role,
      name: typeof body?.name === "string" ? body.name : null,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof MemberError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId requis" }, { status: 400 });

  try {
    await removeDashboardMember(id, userId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof MemberError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
