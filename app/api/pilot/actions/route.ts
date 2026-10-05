/**
 * GET  /api/pilot/actions?clientId=…  → the journal of the client (every client in scope without it)
 * POST /api/pilot/actions             → { clientId, accountId, platform?, requests, why?, goal? }
 *        prepares the preview: each change checked against Meta now, saved
 *        as a draft. Nothing is sent to the platform here (lib/pilot/service.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { listActions, prepareAction } from "@/lib/pilot/service";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const clientId = new URL(req.url).searchParams.get("clientId");
  const actions = await listActions(guard.session, { alertClientId: clientId || null, take: 100 });
  return NextResponse.json({ actions }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Demande illisible." }, { status: 400 });
  const result = await prepareAction(guard.session, {
    alertClientId: typeof body.clientId === "string" ? body.clientId : "",
    accountId: typeof body.accountId === "string" ? body.accountId : "",
    platform: typeof body.platform === "string" ? body.platform : "meta",
    requests: body.requests, why: body.why, goal: body.goal,
  });
  if (!result.ok) return NextResponse.json({ error: result.error, errors: result.errors }, { status: result.status });
  return NextResponse.json({ action: result.action }, { status: 201 });
}
