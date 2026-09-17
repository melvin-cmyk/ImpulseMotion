/**
 * GET /api/reports/clients → staff: the client list for report pickers.
 * One entry per dashboard (a client = an ad account pair), with its report
 * frequency and last report. Duplicated dashboards (same accounts) are
 * collapsed on the first created one.
 */

import { getAccountScope, dashboardWhere } from "@/lib/scope";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { groupDashboardsByAccount } from "@/lib/portfolio";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  const scope = await getAccountScope(guard.session);
  const dashboards = await prisma.dashboard.findMany({
    where: dashboardWhere(scope),
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    select: {
      id: true, name: true, metaAccountId: true, googleCustomerId: true, reportFrequency: true, createdAt: true,
      user: { select: { id: true, name: true, email: true } },
      reports: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, status: true, periodSince: true, periodUntil: true, createdAt: true },
      },
    },
  });

  // Same grouping as the portfolio: dashboards sharing a Meta account OR a
  // Google customer are one client, transitively and across owners. The exact
  // "meta|google" pair key used here before missed those, so the report picker
  // listed duplicates the portfolio had already merged.
  const { groups, unlinked } = groupDashboardsByAccount(dashboards);
  const clients = [...groups.map((g) => g.primary), ...unlinked]
    .map((d) => ({
      id: d.id,
      name: d.name,
      metaAccountId: d.metaAccountId,
      googleCustomerId: d.googleCustomerId,
      reportFrequency: d.reportFrequency,
      owner: d.user,
      lastReport: d.reports[0]
        ? { ...d.reports[0], createdAt: d.reports[0].createdAt.toISOString() }
        : null,
    }));

  return NextResponse.json({ clients });
}
