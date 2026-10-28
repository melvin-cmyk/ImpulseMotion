/**
 * One Mo board (owner only).
 *   GET    → { board, jobId } (jobId = a reply still running)
 *   PATCH  { cards: [{ id, x?, y?, w?, h?, minimized?, removed? }] } → { cards }  (geometry only)
 *   DELETE → { ok }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { runningJobOf } from "@/lib/ai-jobs";
import { loadBoard, toBoardData, updateMoCards } from "@/lib/mo/thread";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await loadBoard(id, guard.session.userId);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const job = await runningJobOf(row.id, guard.session.userId);
  return NextResponse.json({ board: toBoardData(row), jobId: job?.id ?? null }, NO_STORE);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await loadBoard(id, guard.session.userId);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { cards?: unknown };
  const patch = (Array.isArray(body.cards) ? body.cards : []).filter((c): c is { id: string } => !!c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string").slice(0, 200);
  const cards = await updateMoCards(row.id, patch);
  return NextResponse.json({ cards }, NO_STORE);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await loadBoard(id, guard.session.userId);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  await prisma.moBoard.delete({ where: { id: row.id } });
  return NextResponse.json({ ok: true }, NO_STORE);
}
