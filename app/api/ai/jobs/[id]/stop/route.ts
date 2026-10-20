/**
 * POST /api/ai/jobs/[id]/stop → { status }
 * Stops the caller's detached AI turn; what it had written so far is kept
 * in the conversation, marked « réponse arrêtée ».
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { loadJobFor, stopAiJob } from "@/lib/ai-jobs";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const job = await loadJobFor(id, guard.session.userId);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (job.status !== "running") return NextResponse.json({ status: job.status });
  try {
    const { status } = await stopAiJob(job);
    return NextResponse.json({ status });
  } catch (e) {
    return NextResponse.json({ error: `Arrêt impossible (${e instanceof Error ? e.message : String(e)})` }, { status: 502 });
  }
}
