import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { generateIngestToken, requestOrigin } from "@/lib/admin-bots";

type Ctx = { params: Promise<{ dashboardId: string }> };

/**
 * (Re)génère le token Bearer utilisé par n8n sur POST /api/ingest/orders.
 * Le token est renvoyé UNE fois ; seul son sha256 est stocké. Régénérer révoque l'ancien.
 */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const { dashboardId } = await params;
  const bot = await prisma.clientBot.findUnique({ where: { dashboardId }, select: { id: true } });
  if (!bot) {
    return NextResponse.json({ error: "bot non configuré : enregistrez d'abord le bot" }, { status: 404 });
  }

  const { token, hash } = generateIngestToken();
  await prisma.clientBot.update({ where: { id: bot.id }, data: { ingestTokenHash: hash } });

  return NextResponse.json({
    token,
    ingestUrl: `${requestOrigin(req)}/api/ingest/orders`,
  });
}
