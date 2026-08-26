/**
 * GET /api/dashboards/clients — staff: the client logins a dashboard can be
 * linked to. Lighter than /api/admin/users (which stays admin-only).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  const clients = await prisma.user.findMany({
    where: { role: "client" },
    select: { id: true, email: true, name: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ clients });
}
