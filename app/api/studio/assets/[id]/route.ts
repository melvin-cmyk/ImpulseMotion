/**
 * GET    /api/studio/assets/[id] → the asset, a video in progress being asked again (polling of the page)
 * DELETE /api/studio/assets/[id] → hidden from the Studio (its author or an admin)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { assetView, refreshVideo } from "@/lib/studio-assets";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await prisma.creativeAsset.findUnique({ where: { id } });
  if (!row || row.deletedAt) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  return NextResponse.json({ asset: assetView(await refreshVideo(row), guard.session.userId) }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await prisma.creativeAsset.findUnique({ where: { id }, select: { createdById: true, deletedAt: true } });
  if (!row || row.deletedAt) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  if (row.createdById !== guard.session.userId && guard.session.baseRole !== "admin") return NextResponse.json({ error: "Seul son auteur peut le retirer." }, { status: 403 });
  await prisma.creativeAsset.update({ where: { id }, data: { deletedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
