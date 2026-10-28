/**
 * POST /api/mo/turn { boardId, path: nav | ask | quick | act, kind?, totalMs?, firstCardMs?, clarified?, retried?, misunderstood? }
 *   → { id } — a turn the browser resolved by itself (a navigation said out loud, an ask settled with chips), for the measures of spec §6.
 * Staff only, on a board of the caller.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { loadBoard } from "@/lib/mo/thread";
import { parseTurnCreate, recordMoTurn } from "@/lib/mo/turns";

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const parsed = parseTurnCreate(await req.json().catch(() => null));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const board = await loadBoard(parsed.boardId, guard.session.userId);
  if (!board) return NextResponse.json({ error: "not found" }, { status: 404 });
  const id = await recordMoTurn({ ...parsed, userId: guard.session.userId });
  return NextResponse.json({ id }, { headers: { "Cache-Control": "no-store" } });
}
