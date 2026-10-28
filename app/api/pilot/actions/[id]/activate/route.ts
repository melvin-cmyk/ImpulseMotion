/**
 * POST /api/pilot/actions/[id]/activate { operationId? } → « Mettre en ligne »:
 * prepares (does not send) the activation of the ad(s) this action created
 * paused. The preview asks for the second confirmation (money starts to
 * spend) and is sent, read back and journalled like any change.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { prepareActivation } from "@/lib/pilot/service";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => ({}));
  const operationId = body && typeof body.operationId === "string" ? body.operationId : null;
  const result = await prepareActivation(guard.session, (await params).id, operationId);
  if (!result.ok) return NextResponse.json({ error: result.error, errors: result.errors }, { status: result.status });
  return NextResponse.json({ action: result.action }, { status: 201 });
}
