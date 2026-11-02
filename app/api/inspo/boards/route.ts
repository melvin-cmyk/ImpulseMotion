/**
 * Inspiration boards (Motion's Inspo). GET ?clientId= — the client's boards and
 * the agency-wide ones, with item count and 4 covers. POST { name,
 * description?, clientId? } — new board. Staff only.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const clientId = req.nextUrl.searchParams.get("clientId");
  const boards = await prisma.inspoBoard.findMany({
    where: { OR: [{ clientId: null }, ...(clientId ? [{ clientId }] : [])] },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { items: true } }, items: { orderBy: [{ pinned: "desc" }, { createdAt: "desc" }], take: 4, select: { imageUrl: true, source: true } } },
    take: 100,
  });
  return NextResponse.json({ boards: boards.map((b) => ({ id: b.id, name: b.name, description: b.description, clientId: b.clientId, createdByName: b.createdByName, updatedAt: b.updatedAt, count: b._count.items, covers: b.items.map((i) => ({ imageUrl: i.imageUrl, source: i.source })) })) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const b = (await req.json().catch(() => ({}))) as { name?: string; description?: string; clientId?: string | null };
  const name = String(b.name ?? "").trim().slice(0, 80);
  if (!name) return NextResponse.json({ error: "nom requis" }, { status: 400 });
  const board = await prisma.inspoBoard.create({ data: { name, description: String(b.description ?? "").slice(0, 500), clientId: b.clientId ? String(b.clientId).slice(0, 60) : null, createdById: guard.session.userId, createdByName: guard.session.user?.name ?? guard.session.user?.email ?? "" } });
  return NextResponse.json({ board: { id: board.id, name: board.name, description: board.description, clientId: board.clientId, count: 0, covers: [] } });
}
