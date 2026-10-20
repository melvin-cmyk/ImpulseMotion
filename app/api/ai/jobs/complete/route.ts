/**
 * POST /api/ai/jobs/complete — the relay says a detached AI turn is over.
 *   Authorization: Bearer <RELAY_SHARED_SECRET>   body { job: <relay job state> }
 *
 * Writes the answer and the ledger line (once: lib/ai-jobs.ts). A job the app
 * does not know answers 404 so the relay stops retrying. No session: the
 * relay is the caller (proxy.ts lists this path as public).
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { finalizeFromRelayState, loadJob } from "@/lib/ai-jobs";
import type { RelayJobState } from "@/lib/relay-chat";

function authorized(req: NextRequest): boolean {
  const secret = process.env.RELAY_SHARED_SECRET || "";
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!secret || !m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { job?: Partial<RelayJobState> } | null;
  const state = body?.job;
  if (!state || typeof state.id !== "string") return NextResponse.json({ error: "job required" }, { status: 400 });
  const job = await loadJob(state.id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (job.status !== "running") return NextResponse.json({ ok: true, status: job.status, finalized: false });
  if (state.status === "running") return NextResponse.json({ error: "job still running" }, { status: 409 });
  const r = await finalizeFromRelayState(job.id, state as RelayJobState);
  return NextResponse.json({ ok: true, status: r.status, finalized: r.finalized });
}
