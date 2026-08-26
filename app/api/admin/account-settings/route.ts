/**
 * Admin management of per-account settings (AOV fallback, currency).
 *
 * GET  /api/admin/account-settings?platform=meta        → { settings: [...] }
 * PUT  /api/admin/account-settings                      → upsert one
 *   Body: { platform, accountId, aov?: number|null, currency?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  const platform = req.nextUrl.searchParams.get("platform") ?? undefined;
  const settings = await prisma.accountSetting.findMany({
    where: platform ? { platform } : undefined,
    orderBy: { accountId: "asc" },
  });
  return NextResponse.json({ settings });
}

export async function PUT(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => null);
  if (!body || typeof body.accountId !== "string" || !body.accountId.trim()) {
    return NextResponse.json({ error: "accountId required" }, { status: 400 });
  }
  const platform = typeof body.platform === "string" && body.platform ? body.platform : "meta";
  const accountId = body.accountId.replace(/^act_/, "");

  const aov =
    body.aov === null || body.aov === undefined
      ? null
      : Number(body.aov);
  if (aov !== null && (!Number.isFinite(aov) || aov <= 0 || aov > 100000)) {
    return NextResponse.json({ error: "aov must be a positive number" }, { status: 400 });
  }
  const currency = typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency)
    ? body.currency
    : undefined;

  const setting = await prisma.accountSetting.upsert({
    where: { platform_accountId: { platform, accountId } },
    create: { platform, accountId, aov, currency: currency ?? "EUR" },
    update: { aov, ...(currency ? { currency } : {}) },
  });
  return NextResponse.json({ setting });
}
