/**
 * Browser side of the detached AI turns (lib/ai-jobs.ts).
 *
 * `followJob` reads GET /api/ai/jobs/[id]/events and hands each event to the
 * caller; when the stream ends before the job does (the function's time
 * budget, a network blip), it reconnects from the last sequence number seen.
 * Aborting the signal stops the reading only — the turn goes on in the relay;
 * `stopJob` is what ends it.
 */

export interface JobEvent {
  type: string;
  seq?: number;
  text?: string;
  name?: string;
  id?: string;
  message?: string;
  phase?: string;
  content?: string;
  is_error?: boolean;
  resumable?: boolean;
  partial?: boolean;
  cost?: number;
  turns?: number;
  duration?: number;
  /** `job` events of the app route: running | done | stopped | failed | unknown. */
  status?: string;
  stored?: boolean;
  input?: Record<string, unknown>;
}

export type JobOutcome = "done" | "stopped" | "failed" | "unknown" | "aborted";

export interface PublicAiJob {
  id: string;
  surface: "bot" | "console" | "design" | "analyse";
  conversationId: string;
  botId: string | null;
  status: "running" | "done" | "stopped" | "failed";
  title: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  href: string;
}

const MAX_RECONNECTS = 40;

async function readSse(res: Response, onLine: (payload: string) => void, signal?: AbortSignal): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) onLine(trimmed.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith("data:")) onLine(buffer.trim().slice(5).trim());
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Follows a job until it is over. Resolves with how it ended; `aborted` when
 * the caller's signal fired (the job itself is untouched).
 */
export async function followJob(
  jobId: string,
  onEvent: (event: JobEvent) => void,
  signal?: AbortSignal,
): Promise<JobOutcome> {
  let after = 0;
  let outcome: JobOutcome | null = null;
  let attempts = 0;
  while (!outcome) {
    if (signal?.aborted) return "aborted";
    let res: Response;
    try {
      res = await fetch(`/api/ai/jobs/${jobId}/events?after=${after}`, { signal, cache: "no-store" });
    } catch (e) {
      if (signal?.aborted || (e as Error).name === "AbortError") return "aborted";
      if (++attempts > MAX_RECONNECTS) throw e;
      await pause(backoff(attempts), signal);
      continue;
    }
    if (res.status === 404) return "unknown";
    if (!res.ok) {
      if (++attempts > MAX_RECONNECTS) throw new Error(`Suivi impossible (${res.status})`);
      await pause(backoff(attempts), signal);
      continue;
    }
    attempts = 0;
    let sawEvent = false;
    try {
      await readSse(res, (payload) => {
        let event: JobEvent;
        try { event = JSON.parse(payload) as JobEvent; } catch { return; }
        if (typeof event.seq === "number" && event.seq > after) after = event.seq;
        sawEvent = true;
        if (event.type === "job") {
          if (event.status === "done" || event.status === "stopped" || event.status === "failed") outcome = event.status;
          else if (event.status === "unknown") outcome = "unknown";
          onEvent(event);
          return;
        }
        onEvent(event);
        if (event.type === "done") outcome = "done";
      }, signal);
    } catch (e) {
      if (signal?.aborted || (e as Error).name === "AbortError") return "aborted";
    }
    if (signal?.aborted) return "aborted";
    if (outcome) break;
    // The stream ended before the job did (function budget, blip): reconnect
    // from the last sequence number; a stream that gave nothing waits a bit.
    if (++attempts > MAX_RECONNECTS) return "unknown";
    await pause(sawEvent ? 250 : backoff(attempts), signal);
  }
  return outcome;
}

export async function stopJob(jobId: string): Promise<string> {
  const res = await fetch(`/api/ai/jobs/${jobId}/stop`, { method: "POST" });
  const json = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
  if (!res.ok) throw new Error(json.error ?? `Erreur ${res.status}`);
  return json.status ?? "stopped";
}

export async function listJobs(): Promise<{ running: PublicAiJob[]; finished: PublicAiJob[] }> {
  const res = await fetch("/api/ai/jobs", { cache: "no-store" });
  if (!res.ok) throw new Error(`Erreur ${res.status}`);
  return (await res.json()) as { running: PublicAiJob[]; finished: PublicAiJob[] };
}

/** Browser event fired when a job of the viewer ends (components/ai-jobs-watcher.tsx). */
export const AI_JOB_FINISHED_EVENT = "impulse:ai-job-finished";
/** Browser event fired by a chat surface when it starts a job (the watcher polls sooner). */
export const AI_JOB_STARTED_EVENT = "impulse:ai-job-started";

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** Math.min(attempt, 5), 20000);
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { signal?.removeEventListener("abort", done); clearTimeout(t); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}
