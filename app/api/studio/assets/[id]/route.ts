/**
 * GET    /api/studio/assets/[id] → the asset, a video in progress being asked again (polling of the page)
 * PATCH  /api/studio/assets/[id] { feedback?: "keep"|"cut"|null, feedbackNote?, clientId? } → the consultant's verdict on a
 *        generated visual; keep / cut and the note are journaled in the client's HQ project (what works, what to stop).
 * DELETE /api/studio/assets/[id] → hidden from the Studio (its author or an admin)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { assetView, refreshVideo, setAssetFeedback } from "@/lib/studio-assets";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await prisma.creativeAsset.findUnique({ where: { id } });
  if (!row || row.deletedAt) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  return NextResponse.json({ asset: assetView(await refreshVideo(row), guard.session.userId) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { feedback?: unknown; feedbackNote?: unknown; clientId?: unknown };
  const input: Parameters<typeof setAssetFeedback>[1] = {};
  if (body.feedback === null || body.feedback === "keep" || body.feedback === "cut") input.feedback = body.feedback;
  if (typeof body.feedbackNote === "string") input.feedbackNote = body.feedbackNote;
  if (typeof body.clientId === "string" && body.clientId) input.clientId = body.clientId;
  const who = guard.session.user?.name ?? guard.session.user?.email ?? "consultant";
  const r = await setAssetFeedback(id, input, who);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ asset: assetView(r.asset, guard.session.userId), hq: r.hq }, { headers: { "Cache-Control": "no-store" } });
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
