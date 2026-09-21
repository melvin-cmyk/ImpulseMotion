/**
 * GET  /api/dashboards            → staff: all dashboards (?userId= filters); client: owned or member
 * POST /api/dashboards            → admin only: create a dashboard and attach people by email
 *   Body: { name?, metaAccountId?, googleCustomerId?, consultants?: string[], clients?: string[] }
 *   → { dashboard, invites: [{ email, role, created, tempPassword?, error? }] }
 */

import { getAccountScope, dashboardWhere } from "@/lib/scope";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, requireAdmin } from "@/lib/auth-helpers";
import { isStaff } from "@/lib/dashboard-auth";
import { createDashboardForUser } from "@/lib/dashboard-widgets";
import { addDashboardMember, parseEmails, type MemberRole } from "@/lib/dashboard-members";

export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { session } = guard;

  const userIdParam = req.nextUrl.searchParams.get("userId");
  const staff = isStaff(session);
  const scope = staff ? await getAccountScope(session) : null;
  const where = staff && scope
    ? { AND: [dashboardWhere(scope), userIdParam ? { userId: userIdParam } : {}] }
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
  // Creating a dashboard opens a silo and hands out access: admin only.
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => null);
  const metaAccountId = typeof body?.metaAccountId === "string" && body.metaAccountId.trim() ? body.metaAccountId.trim() : null;
  const googleCustomerId = typeof body?.googleCustomerId === "string" && body.googleCustomerId.trim() ? body.googleCustomerId.trim() : null;
  if (!metaAccountId && !googleCustomerId) {
    return NextResponse.json({ error: "Un compte Meta ou Google est requis" }, { status: 400 });
  }
  const consultants = parseEmails(body?.consultants);
  const clients = parseEmails(body?.clients);
  const both = consultants.find((e) => clients.includes(e));
  if (both) return NextResponse.json({ error: `${both} ne peut pas être à la fois consultant et client` }, { status: 400 });

  let dashboard;
  try {
    // The creating admin owns the dashboard; people get in through membership.
    dashboard = await createDashboardForUser({
      userId: guard.session.userId,
      name: typeof body?.name === "string" ? body.name : undefined,
      metaAccountId,
      googleCustomerId,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "creation failed" }, { status: 400 });
  }

  // One bad email must not lose the others: report per person.
  const invites: Array<{ email: string; role: MemberRole; created: boolean; tempPassword?: string; error?: string }> = [];
  const wanted: Array<[string, MemberRole]> = [
    ...consultants.map((e): [string, MemberRole] => [e, "consultant"]),
    ...clients.map((e): [string, MemberRole] => [e, "client"]),
  ];
  for (const [email, role] of wanted) {
    try {
      const r = await addDashboardMember({ dashboardId: dashboard.id, email, role });
      invites.push({ email, role, created: r.created, ...(r.tempPassword ? { tempPassword: r.tempPassword } : {}) });
    } catch (e) {
      invites.push({ email, role, created: false, error: e instanceof Error ? e.message : "échec" });
    }
  }
  return NextResponse.json({ dashboard, invites });
}
