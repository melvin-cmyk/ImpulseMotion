/**
 * GET /api/dashboards/clients — staff: the client logins a dashboard can be
 * linked to. Lighter than /api/admin/users (which stays admin-only).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { dashboardWhere, getAccountScope } from "@/lib/scope";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const scope = await getAccountScope(guard.session);

  // A consultant sees the logins attached to their own clients — not the
  // agency's whole customer directory (emails + reusable user ids).
  const clients = await prisma.user.findMany({
    where: scope.all
      ? { role: "client" }
      : {
          role: "client",
          OR: [
            { dashboards: { some: dashboardWhere(scope) } },
            { dashboardMemberships: { some: { dashboard: dashboardWhere(scope) } } },
          ],
        },
    select: { id: true, email: true, name: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ clients });
}
