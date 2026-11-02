/**
 * POST /api/inspo/boards/:id/items — saves an ad in a board: { source:
 * "adlib"|"own", ref, brand?, title?, body?, imageUrl?, videoUrl?, linkUrl?,
 * note? }. Saving the same ad twice in a board is a no-op. Staff only.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";

const s = (v: unknown, max: number) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, max));
const url = (v: unknown) => { const x = s(v, 2000); return x && (/^https:\/\//.test(x) || x.startsWith("/api/")) ? x : null; };

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const source = b.source === "own" ? "own" : b.source === "adlib" ? "adlib" : null;
  const ref = s(b.ref, 120);
  if (!source || !ref) return NextResponse.json({ error: "source et référence requises" }, { status: 400 });
  if (!(await prisma.inspoBoard.findUnique({ where: { id }, select: { id: true } }))) return NextResponse.json({ error: "board inconnu" }, { status: 404 });
  const data = { source, brand: s(b.brand, 120) ?? "", title: s(b.title, 500), body: s(b.body, 3000), imageUrl: url(b.imageUrl), videoUrl: url(b.videoUrl), linkUrl: url(b.linkUrl), note: s(b.note, 2000) ?? "", addedById: guard.session.userId, addedByName: guard.session.user?.name ?? guard.session.user?.email ?? "" };
  const item = await prisma.inspoItem.upsert({ where: { boardId_ref: { boardId: id, ref } }, create: { boardId: id, ref, ...data }, update: {} });
  await prisma.inspoBoard.update({ where: { id }, data: { updatedAt: new Date() } });
  return NextResponse.json({ item });
}
