/**
 * POST /api/pilot/changes/[id]/note → { note } — why a change made outside
 * Pilotage was done, written by a consultant (then in the client's HQ journal).
 * An empty note removes it.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { noteChange } from "@/lib/pilot/history";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => ({}));
  const result = await noteChange(guard.session, (await params).id, body?.note);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ change: result.change });
}
