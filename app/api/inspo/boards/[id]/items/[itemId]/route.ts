/** Saved ad of a board: PATCH { note?, pinned? } · DELETE. Staff only. */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; itemId: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id, itemId } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { note?: string; pinned?: boolean };
  const data: { note?: string; pinned?: boolean } = {};
  if (b.note !== undefined) data.note = String(b.note).slice(0, 2000);
  if (b.pinned !== undefined) data.pinned = !!b.pinned;
  const r = await prisma.inspoItem.updateMany({ where: { id: itemId, boardId: id }, data });
  return r.count ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "élément inconnu" }, { status: 404 });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; itemId: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id, itemId } = await ctx.params;
  await prisma.inspoItem.deleteMany({ where: { id: itemId, boardId: id } });
  return NextResponse.json({ ok: true });
}
