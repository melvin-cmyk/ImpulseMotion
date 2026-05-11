import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { assertAccountAllowed } from "@/lib/acl";
import { prisma } from "@/lib/prisma";
import { computePacingBatch } from "@/lib/budgets";

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

  const pacing = await computePacingBatch(
    budgets.map((b) => ({ accountId: b.accountId, monthlyTarget: b.monthlyTarget, currency: b.currency })),
  );
  const pacingById = new Map(pacing.map((p) => [p.accountId, p]));

  return NextResponse.json({
    budgets: budgets.map((b) => ({ ...b, pacing: pacingById.get(b.accountId) ?? null })),
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const body = await req.json();
  const { accountId, platform, monthlyTarget, currency } = body as {
    accountId: string;
    platform?: string;
    monthlyTarget: number;
    currency?: string;
  };
  if (!accountId || typeof monthlyTarget !== "number" || monthlyTarget <= 0) {
    return NextResponse.json(
      { error: "accountId et monthlyTarget (> 0) requis" },
      { status: 400 },
    );
  }
  const platformValue = (platform ?? "meta") as "meta";
  const allowed = await assertAccountAllowed(guard.session.userId, platformValue, accountId);
  if (!allowed && guard.session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
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
