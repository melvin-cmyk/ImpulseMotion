/**
 * POST /api/mo/[id]/warm → starts the persistent CLI of this board on the
 * relay before the first message (the person is opening the board or has
 * just pressed the microphone), so the first answer skips the cold start.
 * Idempotent and cheap (~0.5 s on the relay); never blocks the turn: the
 * browser fires it and forgets. → { warm: boolean, reason? }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { relayWarm } from "@/lib/relay-chat";
import { loadBoard } from "@/lib/mo/thread";
import { moBeltFor, moRelayBase, moTurnContext } from "@/lib/mo/turn";

export const maxDuration = 30;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const board = await loadBoard(id, guard.session.userId);
  if (!board) return NextResponse.json({ error: "not found" }, { status: 404 });
  const ctx = await moTurnContext(guard.session);
  const body = moRelayBase(ctx, guard.session, board.id, moBeltFor("", !!ctx.dataScope));
  const r = await relayWarm(body);
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}
