/**
 * GET /api/admin/usage?month=YYYY-MM          → admin: Bedrock usage per client for the month
 * GET /api/admin/usage?month=YYYY-MM&format=csv → same, as a CSV download (one line per client × user)
 * GET /api/admin/usage?month=YYYY-MM&format=csv&by=profile → every surface, one line per profile × surface
 *
 * `profiles` = what each person consumed over the month, every surface and
 * provider together; the name and the role are the ones of the account today.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { SYSTEM_PROFILE, monthRange, profilesCsv, summarizeByFeature, summarizeByUser, summarizeUsage, usageCsv } from "@/lib/ai-usage";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const { month, start, end } = monthRange(req.nextUrl.searchParams.get("month"));
  const rows = await prisma.aiUsage.findMany({
    where: { provider: "bedrock", createdAt: { gte: start, lt: end } },
    select: {
      dashboardId: true, clientName: true, clientKey: true, userEmail: true, userRole: true,
      inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true,
    },
  });
  const clients = summarizeUsage(rows);
  // Internal view: every surface, every provider — where the tokens go.
  const allRows = await prisma.aiUsage.findMany({
    where: { createdAt: { gte: start, lt: end } },
    select: {
      feature: true, provider: true, model: true, turns: true, userId: true, costUsd: true,
      dashboardId: true, clientName: true, clientKey: true, userEmail: true, userRole: true,
      inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true,
    },
  });
  const features = summarizeByFeature(allRows);

  const profiles = summarizeByUser(allRows);
  const ids = profiles.map((p) => p.userId).filter((id): id is string => !!id);
  const emails = profiles.filter((p) => !p.userId && p.email).map((p) => p.email as string);
  const people = ids.length || emails.length
    ? await prisma.user.findMany({
      where: { OR: [...(ids.length ? [{ id: { in: ids } }] : []), ...(emails.length ? [{ email: { in: emails } }] : [])] },
      select: { id: true, name: true, email: true, role: true },
    })
    : [];
  for (const p of profiles) {
    if (p.key === SYSTEM_PROFILE) continue;
    const who = people.find((u) => u.id === p.userId) ?? people.find((u) => !!u.email && u.email.toLowerCase() === p.email?.toLowerCase());
    // The role of the account, not the one applied to the session when the row was written.
    if (who) { p.name = who.name; p.email = who.email ?? p.email; p.role = who.role; }
  }

  if (req.nextUrl.searchParams.get("format") === "csv" && req.nextUrl.searchParams.get("by") === "profile") {
    return new NextResponse(profilesCsv(month, profiles), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="consommation-ia-profils-${month}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (req.nextUrl.searchParams.get("format") === "csv") {
    return new NextResponse(usageCsv(month, clients), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="consommation-ia-${month}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({ month, clients, features, profiles }, { headers: { "Cache-Control": "no-store" } });
}
