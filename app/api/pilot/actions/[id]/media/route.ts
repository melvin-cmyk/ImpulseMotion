/**
 * POST /api/pilot/actions/[id]/media → the page waits for a video creation
 * (an operation « uploading »): asks Meta where the video is and, when it is
 * ready, creates the ad and closes the action (lib/pilot/service.ts
 * continueActionMedia). Answers the action as it is now.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { continueActionMedia } from "@/lib/pilot/service";

export const maxDuration = 60;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const result = await continueActionMedia(guard.session, (await params).id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ action: result.action }, { headers: { "Cache-Control": "no-store" } });
}
