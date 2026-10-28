/**
 * One Mo page (owner only).
 *   GET    → { board, jobId } (jobId = a reply still running)
 *   PATCH  { cards: [{ id, x?, y?, w?, h?, minimized?, frame?, removed? }] } → { cards }  (geometry)
 *   PATCH  { title?, archived?, position? } → { board }  (the page itself; the home page is never archived)
 *   DELETE → { ok }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { runningJobOf } from "@/lib/ai-jobs";
import { loadBoard, toBoardData, updateMoBoardMeta, updateMoCards } from "@/lib/mo/thread";

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
  const body = (await req.json().catch(() => ({}))) as { cards?: unknown; title?: unknown; archived?: unknown; position?: unknown };
  if (Array.isArray(body.cards)) {
    const patch = body.cards.filter((c): c is { id: string } => !!c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string").slice(0, 200);
    const cards = await updateMoCards(row.id, patch);
    return NextResponse.json({ cards }, NO_STORE);
  }
  const meta = { ...(typeof body.title === "string" ? { title: body.title } : {}), ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}), ...(typeof body.position === "number" ? { position: body.position } : {}) };
  if (!Object.keys(meta).length) return NextResponse.json({ error: "rien à modifier" }, { status: 400, ...NO_STORE });
  const updated = await updateMoBoardMeta(row.id, meta);
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ board: toBoardData(updated) }, NO_STORE);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await loadBoard(id, guard.session.userId);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (row.kind === "home") return NextResponse.json({ error: "La page « Aujourd'hui » ne se supprime pas." }, { status: 400, ...NO_STORE });
  await prisma.moBoard.delete({ where: { id: row.id } });
  return NextResponse.json({ ok: true }, NO_STORE);
}
