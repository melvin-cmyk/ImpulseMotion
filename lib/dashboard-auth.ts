import { prisma } from "@/lib/prisma";
import type { Session } from "next-auth";

export function isStaff(session: Session): boolean {
  return session.role === "admin" || session.role === "consultant";
}

/** Loads a dashboard if the session may see it: staff, the client who owns it,
 *  or a client attached as member (DashboardMember). */
export async function loadDashboardFor(session: Session, dashboardId: string) {
  const dashboard = await prisma.dashboard.findUnique({
    where: { id: dashboardId },
    include: {
      widgets: { orderBy: { position: "asc" } },
      members: { select: { userId: true } },
    },
  });
  if (!dashboard) return { status: 404 as const };
  const allowed =
    isStaff(session) ||
    dashboard.userId === session.userId ||
    dashboard.members.some((m) => m.userId === session.userId);
  if (!allowed) return { status: 403 as const };
  return { status: 200 as const, dashboard };
}
