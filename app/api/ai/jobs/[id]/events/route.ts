/**
 * GET /api/ai/jobs/[id]/events?after=N → SSE of a detached AI turn.
 *
 * Replays the job's events past sequence N, then follows it live: the same
 * events as the chat routes used to stream (delta, tool_call, usage, error,
 * done…), each with a `seq` the browser hands back when it reconnects. The
 * stream ends with the job, or with this function's time budget — the
 * browser then reconnects from its last `seq`. Closing it never stops the
 * turn (POST ../stop does).
 *
 * When the stream shows the job is over, the answer is written to the
 * conversation here too (first claimer wins, see lib/ai-jobs.ts), so the
 * consultant who watched the reply sees it stored without waiting for the
 * relay's webhook.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { finalizeAiJob, finalizeFromRelayState, loadJobFor, publicJob } from "@/lib/ai-jobs";
import { AiJobSummarizer } from "@/lib/ai-job-summary";
import { relayJobEvents, relayJobState } from "@/lib/relay-chat";

export const maxDuration = 300;

const encoder = new TextEncoder();

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const job = await loadJobFor(id, guard.session.userId);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  const after = Number(req.nextUrl.searchParams.get("after") || 0);
  if (job.status !== "running") {
    // Already stored: tell the browser to reload the conversation.
    const body = `data: ${JSON.stringify({ type: "job", status: job.status, stored: true })}\n\n`;
    return new Response(body, { status: 200, headers: sseHeaders() });
  }

  let upstream: Response | null;
  try {
    upstream = await relayJobEvents(job.id, Number.isFinite(after) ? after : 0);
  } catch (e) {
    return NextResponse.json({ error: `IA indisponible (${e instanceof Error ? e.message : String(e)})` }, { status: 502 });
  }
  if (!upstream?.body) {
    // The relay no longer knows the job (restart, TTL): the list's
    // reconciliation decides when it is given up; the browser retries later.
    const body = `data: ${JSON.stringify({ type: "job", status: "unknown" })}\n\n`;
    return new Response(body, { status: 200, headers: sseHeaders() });
  }

  const summarizer = new AiJobSummarizer();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  let finished = false;
  const finish = async () => {
    if (finished || !sawDone) return;
    finished = true;
    try {
      // The relay's own summary is authoritative (full text even when the
      // replayed log was trimmed, stop vs done); the stream's is the fallback.
      const st = await relayJobState(job.id);
      if ("state" in st && st.state.status !== "running") await finalizeFromRelayState(job.id, st.state);
      else await finalizeAiJob(job.id, summarizer.result());
    } catch (e) {
      console.error(`[ai-jobs] ${job.id} : fin non enregistrée depuis le flux`, e instanceof Error ? e.message : e);
    }
  };

  const stream = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "job", status: "running", job: publicJob(job) })}\n\n`));
      },
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          summarizer.line(line);
          if (/^data:\s*\{"type":"done"/.test(line.trim())) sawDone = true;
        }
      },
      async flush() {
        if (buffer) { summarizer.line(buffer); if (/^data:\s*\{"type":"done"/.test(buffer.trim())) sawDone = true; }
        await finish();
      },
      async cancel() {
        await finish();
      },
    } as Transformer<Uint8Array, Uint8Array>),
  );

  return new Response(stream, { status: 200, headers: sseHeaders() });
}

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  };
}
