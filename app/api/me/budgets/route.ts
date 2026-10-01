/**
 * Monthly budgets of the session (AccountBudget), with their pacing.
 *
 * GET  ?withPacing=1 → { budgets: [...] , each with `pacing` }
 * POST { accountId, platform?: "meta" | "tiktok", monthlyTarget, currency? }
 *      Meta: an account assigned to the person (admins: any). TikTok: an
 *      advertiser in the person's scope (lib/scope.ts), stored by its digits.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { assertAccountAllowed } from "@/lib/acl";
import { prisma } from "@/lib/prisma";
import { computePacingBatch, isPacingPlatform } from "@/lib/budgets";
import { getAccountScope, tiktokInScope } from "@/lib/scope";
import { normalizeAdvertiserId } from "@/lib/tiktok-accounts";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { searchParams } = new URL(req.url);
  const withPacing = searchParams.get("withPacing") === "1";

  const budgets = await prisma.accountBudget.findMany({
    where: { userId: guard.session.userId },
    orderBy: { updatedAt: "desc" },
  });

  if (!withPacing) return NextResponse.json({ budgets });

  // Only the platforms whose spend can be read get a pacing (a Google row, if any, gets none).
  const readable = budgets.filter((b) => isPacingPlatform(b.platform));
  const pacing = await computePacingBatch(
    readable.map((b) => ({ accountId: b.accountId, monthlyTarget: b.monthlyTarget, currency: b.currency, platform: isPacingPlatform(b.platform) ? b.platform : undefined })),
  );
  // Same order as asked: keyed by row, since one id could be budgeted on two platforms.
  const pacingByRow = new Map(readable.map((b, i) => [b.id, pacing[i]]));

  return NextResponse.json({
    budgets: budgets.map((b) => ({ ...b, pacing: pacingByRow.get(b.id) ?? null })),
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const body = await req.json();
  const { platform, monthlyTarget, currency } = body as {
    accountId: string;
    platform?: string;
    monthlyTarget: number;
    currency?: string;
  };
  let accountId = typeof body.accountId === "string" ? body.accountId : "";
  if (!accountId || typeof monthlyTarget !== "number" || monthlyTarget <= 0) {
    return NextResponse.json(
      { error: "accountId et monthlyTarget (> 0) requis" },
      { status: 400 },
    );
  }
  const platformValue = platform ?? "meta";
  if (!isPacingPlatform(platformValue)) {
    return NextResponse.json({ error: "plateforme non prise en charge (meta ou tiktok)" }, { status: 400 });
  }
  if (platformValue === "tiktok") {
    const advertiserId = normalizeAdvertiserId(accountId);
    if (!advertiserId) return NextResponse.json({ error: "Identifiant TikTok invalide : des chiffres seulement." }, { status: 400 });
    if (!tiktokInScope(await getAccountScope(guard.session), advertiserId)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    accountId = advertiserId;
  } else {
    const allowed = await assertAccountAllowed(guard.session.userId, platformValue, accountId);
    if (!allowed && guard.session.role !== "admin") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const budget = await prisma.accountBudget.upsert({
    where: {
      userId_platform_accountId: {
        userId: guard.session.userId,
        platform: platformValue,
        accountId,
      },
    },
    create: {
      userId: guard.session.userId,
      accountId,
      platform: platformValue,
      monthlyTarget,
      currency: currency ?? "EUR",
    },
    update: { monthlyTarget, currency: currency ?? "EUR" },
  });
  return NextResponse.json({ budget });
}
