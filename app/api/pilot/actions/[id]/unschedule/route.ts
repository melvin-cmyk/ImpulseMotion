/**
 * POST /api/pilot/actions/[id]/unschedule → cancels a programmed send, or the
 * automatic revert of a sent change. Only the person who prepared it.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { cancelSchedule } from "@/lib/pilot/service";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const result = await cancelSchedule(guard.session, (await params).id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ action: result.action });
}
