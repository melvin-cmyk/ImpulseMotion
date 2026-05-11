import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { generateRecommendations } from "@/lib/recommend";

export const maxDuration = 60;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const { id } = await params;
  const event = await prisma.alertEvent.findUnique({
    where: { id },
    include: { rule: true },
  });
  if (!event) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (guard.session.role !== "admin" && event.userId !== guard.session.userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Cache: if already generated recently, return cached unless force=1
  if (event.recommendations && event.recommendationsGeneratedAt) {
    const age = Date.now() - new Date(event.recommendationsGeneratedAt).getTime();
    if (age < 3600 * 1000) {
      return NextResponse.json({ recommendations: event.recommendations, cached: true });
    }
  }

  // Look up label for nicer prompt
  const accountRow = await prisma.userAdAccount.findFirst({
    where: { userId: event.userId, platform: "meta", accountId: event.clientId },
    select: { label: true },
  });

  try {
    const recommendations = await generateRecommendations(
      {
        metric: event.metric,
        condition: event.rule.condition,
        threshold: event.threshold,
        value: event.value,
        message: event.message,
        clientId: event.clientId,
        window: event.rule.window,
      },
      accountRow?.label ?? undefined,
    );

    await prisma.alertEvent.update({
      where: { id },
      data: { recommendations, recommendationsGeneratedAt: new Date() },
    });

    return NextResponse.json({ recommendations });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erreur génération";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
