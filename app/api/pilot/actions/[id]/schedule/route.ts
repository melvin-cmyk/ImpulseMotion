/**
 * POST /api/pilot/actions/[id]/schedule → { why, goal?, hqProject, confirmDouble?, scheduledAt, revertAt? }
 * Keeps the prepared changes and sends them at `scheduledAt` (cron, as the
 * person who prepared them); `revertAt` puts them back automatically then.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { scheduleAction } from "@/lib/pilot/service";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => ({}));
  const result = await scheduleAction(guard.session, (await params).id, body ?? {});
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ action: result.action });
}
