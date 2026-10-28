/**
 * POST /api/mo/[id]/detach { frameId } → « Détacher en page » : the client
 * frame and its cards leave this page for the client's own page (created when
 * missing). → { pageId, moved: [card ids] }.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { findClient } from "@/lib/clients/registry";
import { detachFrameToPage, loadBoard, parseMoCards } from "@/lib/mo/thread";
import { isFrame } from "@/lib/mo/frames";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const board = await loadBoard(id, guard.session.userId);
  if (!board) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { frameId?: unknown };
  const frameId = typeof body.frameId === "string" && /^[a-z0-9]{3,24}$/i.test(body.frameId) ? body.frameId : "";
  const frame = parseMoCards(board.cardsJson).find((c) => isFrame(c) && c.id === frameId);
  if (!frame || !isFrame(frame)) return NextResponse.json({ error: "Cadre introuvable." }, { status: 404, ...NO_STORE });
  const client = await findClient(await getAccountScope(guard.session), frame.clientId);
  const target = client ? { id: client.id, name: client.name } : { id: frame.clientId, name: frame.clientName };
  const done = await detachFrameToPage(guard.session.userId, board.id, frameId, target);
  if (!done) return NextResponse.json({ error: "Cadre introuvable." }, { status: 404, ...NO_STORE });
  return NextResponse.json(done, NO_STORE);
}
