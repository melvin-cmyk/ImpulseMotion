import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Session } from "next-auth";
import { dashboardInScope, getAccountScope } from "@/lib/scope";

export function isStaff(session: Session): boolean {
  return session.role === "admin" || session.role === "consultant";
}

/** Loads a dashboard if the session may see it: admin, a consultant whose
 *  assigned accounts cover it (lib/scope), the client who owns it, or a
 *  client attached as member (DashboardMember). */
export async function loadDashboardFor(session: Session, dashboardId: string) {
  const dashboard = await prisma.dashboard.findUnique({
    where: { id: dashboardId },
    include: {
      widgets: { orderBy: { position: "asc" } },
      pages: { orderBy: { position: "asc" }, select: { id: true, name: true, position: true, intent: true } },
      members: { select: { userId: true } },
    },
  });
  if (!dashboard) return { status: 404 as const };
  let allowed =
    dashboard.userId === session.userId ||
    dashboard.members.some((m) => m.userId === session.userId);
  if (!allowed && isStaff(session)) {
    const scope = await getAccountScope(session);
    allowed = dashboardInScope(scope, dashboard);
  }
  if (!allowed) return { status: 403 as const };
  return { status: 200 as const, dashboard };
}

/**
 * Staff mutation guard: after requireStaff(), refuses (403) a dashboard whose
 * accounts are not assigned to the consultant. Admins always pass. Returns a
 * response to send, or null when the dashboard may be touched.
 */
export async function denyIfDashboardOutOfScope(session: Session, dashboardId: string): Promise<NextResponse | null> {
  const scope = await getAccountScope(session);
  if (scope.all) return null;
  const d = await prisma.dashboard.findUnique({
    where: { id: dashboardId },
    select: { metaAccountId: true, googleCustomerId: true },
  });
  if (!d) return null; // let the route answer 404 itself
  return dashboardInScope(scope, d) ? null : NextResponse.json({ error: "forbidden" }, { status: 403 });
}
