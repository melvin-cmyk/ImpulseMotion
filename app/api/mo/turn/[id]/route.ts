/**
 * PATCH /api/mo/turn/[id] { firstCardMs?, misunderstood?, clarified?, retried? } → { ok }
 * The browser completes a turn it was given the id of: when the first card
 * landed, a 👎 on Mo's sentence, a reformulation, a chip clicked on an ask.
 * Staff only, the caller's own turns.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { parseTurnPatch, patchMoTurn } from "@/lib/mo/turns";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const patch = parseTurnPatch(await req.json().catch(() => null));
  if ("error" in patch) return NextResponse.json({ error: patch.error }, { status: 400 });
  const ok = await patchMoTurn(id, guard.session.userId, patch);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404, headers: { "Cache-Control": "no-store" } });
}
