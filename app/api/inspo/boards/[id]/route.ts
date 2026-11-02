/** Inspiration board: GET (items) · PATCH { name?, description? } · DELETE. Staff only. */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  const board = await prisma.inspoBoard.findUnique({ where: { id }, include: { items: { orderBy: [{ pinned: "desc" }, { createdAt: "desc" }] } } });
  if (!board) return NextResponse.json({ error: "board inconnu" }, { status: 404 });
  return NextResponse.json({ board }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { name?: string; description?: string };
  const data: { name?: string; description?: string } = {};
  if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 80); if (!n) return NextResponse.json({ error: "nom requis" }, { status: 400 }); data.name = n; }
  if (b.description !== undefined) data.description = String(b.description).slice(0, 500);
  try { await prisma.inspoBoard.update({ where: { id }, data }); return NextResponse.json({ ok: true }); } catch { return NextResponse.json({ error: "board inconnu" }, { status: 404 }); }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  await prisma.inspoBoard.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
