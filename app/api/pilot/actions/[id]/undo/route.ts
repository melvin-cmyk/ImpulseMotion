/**
 * POST /api/pilot/actions/[id]/undo → prepares (does not send) the change that
 * puts back what this action applied. Confirmed like any other change.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { prepareUndo } from "@/lib/pilot/service";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const result = await prepareUndo(guard.session, (await params).id);
  if (!result.ok) return NextResponse.json({ error: result.error, errors: result.errors }, { status: result.status });
  return NextResponse.json({ action: result.action }, { status: 201 });
}
