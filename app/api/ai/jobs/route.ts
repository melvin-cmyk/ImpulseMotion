/**
 * GET /api/ai/jobs → { running: PublicAiJob[], finished: PublicAiJob[] }
 *
 * The caller's detached AI turns: the ones still running (reconciled with the
 * relay first) and the ones that ended in the last minutes, so the browser
 * can show « n réponses en cours » and announce a reply that came while the
 * consultant was on another page.
 */

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { listJobs, publicJob } from "@/lib/ai-jobs";

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { running, finished } = await listJobs(guard.session.userId);
  return NextResponse.json({ running: running.map(publicJob), finished: finished.map(publicJob) }, { headers: { "Cache-Control": "no-store" } });
}
