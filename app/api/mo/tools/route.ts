/**
 * POST /api/mo/tools — Mo's tools, called by the relay's "mo" MCP server
 * (server/mcp-mo.mjs) while a turn of Mo runs.
 *   Authorization: Bearer <RELAY_SHARED_SECRET>
 *   body { userId, boardId, tool, args } → { ok: true, result } | { ok: false, error }
 *
 * The relay pins userId / boardId in the server's environment from the chat
 * request the app itself sent (never from the model); here the pair is checked
 * again (board owned by a staff user) and the tool runs under that user's ACL
 * (lib/mo/tools.ts). No session: proxy.ts lists this path as public.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { isStaff } from "@/lib/auth-helpers";
import { loadBoard } from "@/lib/mo/thread";
import { MO_TOOL_NAMES, MoToolError, runMoTool } from "@/lib/mo/tools";

export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = process.env.RELAY_SHARED_SECRET || "";
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (secret.length < 16 || !m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { userId?: unknown; boardId?: unknown; tool?: unknown; args?: unknown } | null;
  const userId = typeof body?.userId === "string" ? body.userId : "";
  const boardId = typeof body?.boardId === "string" ? body.boardId : "";
  const tool = typeof body?.tool === "string" ? body.tool : "";
  if (!userId || !boardId || !(MO_TOOL_NAMES as readonly string[]).includes(tool)) return NextResponse.json({ ok: false, error: "userId, boardId et tool requis" }, { status: 400 });
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, email: true, name: true } });
  if (!user || !isStaff(user)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const board = await loadBoard(boardId, userId);
  if (!board) return NextResponse.json({ ok: false, error: "board not found" }, { status: 404 });
  const t0 = Date.now();
  try {
    const result = await runMoTool({ userId: user.id, boardId: board.id, role: user.role, email: user.email, name: user.name }, tool, body?.args);
    console.log(`[mo/tools] ${tool} ${Date.now() - t0} ms`);
    return NextResponse.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const status = e instanceof MoToolError ? e.status : 500;
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[mo/tools] ${tool} échec ${Date.now() - t0} ms :`, error);
    return NextResponse.json({ ok: false, error }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
