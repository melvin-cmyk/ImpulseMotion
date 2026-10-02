/**
 * POST /api/pilot/actions/[id]/hq → writes again in HQ the entry of a sent
 * change whose first writing failed (relay or HQ unreachable).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { retryHq } from "@/lib/pilot/service";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const result = await retryHq(guard.session, (await params).id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ action: result.action });
}
