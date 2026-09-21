/**
 * GET /api/admin/usage?month=YYYY-MM          → admin: Bedrock usage per client for the month
 * GET /api/admin/usage?month=YYYY-MM&format=csv → same, as a CSV download (one line per client × user)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { monthRange, summarizeUsage, usageCsv } from "@/lib/ai-usage";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const { month, start, end } = monthRange(req.nextUrl.searchParams.get("month"));
  const rows = await prisma.aiUsage.findMany({
    where: { provider: "bedrock", createdAt: { gte: start, lt: end } },
    select: {
      dashboardId: true, clientName: true, clientKey: true, userEmail: true, userRole: true,
      inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, costUsd: true,
    },
  });
  const clients = summarizeUsage(rows);

  if (req.nextUrl.searchParams.get("format") === "csv") {
    return new NextResponse(usageCsv(month, clients), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="consommation-ia-${month}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({ month, clients }, { headers: { "Cache-Control": "no-store" } });
}
