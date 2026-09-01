/**
 * GET /api/reports/clients → staff: the client list for report pickers.
 * One entry per dashboard (a client = an ad account pair), with its report
 * frequency and last report. Duplicated dashboards (same accounts) are
 * collapsed on the first created one.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  const dashboards = await prisma.dashboard.findMany({
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

  const seen = new Set<string>();
  const clients = dashboards
    .filter((d) => {
      const key = `${d.metaAccountId ?? "-"}|${d.googleCustomerId ?? "-"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
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
