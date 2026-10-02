/**
 * POST /api/pilot/actions/[id]/execute → { why, goal?, hqProject, confirmDouble? }
 * Sends the prepared changes to Meta, reads each one back, then writes the
 * entry in the client's HQ journal. Only the person who prepared it.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { executeAction } from "@/lib/pilot/service";

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => ({}));
  const result = await executeAction(guard.session, (await params).id, body ?? {});
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ action: result.action });
}
