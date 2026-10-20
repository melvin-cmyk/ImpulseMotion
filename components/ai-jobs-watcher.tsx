"use client";

/**
 * Keeps an eye on the viewer's detached AI turns (lib/ai-jobs.ts) wherever
 * they are in the app: the counts shown next to the assistants in the nav,
 * and a small notice when a reply is ready while they are on another page.
 *
 * Polls GET /api/ai/jobs: often while something is running, rarely otherwise,
 * at once when the tab gets the focus back or a chat surface starts a turn
 * (AI_JOB_STARTED_EVENT). A surface that follows a job to its end tells the
 * watcher to keep quiet about it (`ignore`), so the consultant who watched
 * the reply arrive is not told again.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, X } from "lucide-react";
import { AI_JOB_FINISHED_EVENT, AI_JOB_STARTED_EVENT, listJobs, type PublicAiJob } from "@/lib/ai-job-client";

interface AiJobsContextValue {
  running: PublicAiJob[];
  /** Asks the server again now (a surface just started or stopped a turn). */
  refresh: () => void;
  /** No notice for this job: the caller shows its end itself. */
  ignore: (jobId: string) => void;
}

const AiJobsContext = createContext<AiJobsContextValue>({ running: [], refresh: () => {}, ignore: () => {} });

export function useAiJobs(): AiJobsContextValue {
  return useContext(AiJobsContext);
}

const BUSY_INTERVAL_MS = 8_000;
const IDLE_INTERVAL_MS = 60_000;
const NOTICE_MS = 25_000;

const SURFACE_LABEL: Record<PublicAiJob["surface"], string> = { console: "AI Assistant", bot: "Assistant IA" };

export function AiJobsWatcher({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const [running, setRunning] = useState<PublicAiJob[]>([]);
  const [notices, setNotices] = useState<PublicAiJob[]>([]);
  const pathname = usePathname();
  const knownRunning = useRef<Set<string>>(new Set());
  const announced = useRef<Set<string>>(new Set());
  const ignored = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    try {
      const { running: now, finished } = await listJobs();
      setRunning(now);
      const nowIds = new Set(now.map((j) => j.id));
      // A job seen running earlier that is now over: tell the viewer, unless a
      // surface followed it, or they are already on its conversation.
      for (const job of finished) {
        if (!knownRunning.current.has(job.id) || announced.current.has(job.id)) continue;
        announced.current.add(job.id);
        window.dispatchEvent(new CustomEvent(AI_JOB_FINISHED_EVENT, { detail: job }));
        if (ignored.current.has(job.id)) continue;
        const onIt = typeof window !== "undefined" && window.location.pathname + window.location.search === job.href;
        if (!onIt) setNotices((prev) => (prev.some((n) => n.id === job.id) ? prev : [...prev, job]));
      }
      knownRunning.current = nowIds;
    } catch {
      /* signed out, or the server is away: next tick */
    } finally {
      inFlight.current = false;
    }
  }, [enabled]);

  // Polling cadence: busy while something runs, idle otherwise.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        if (cancelled) return;
        await poll();
        if (!cancelled) schedule();
      }, knownRunning.current.size > 0 ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS);
    };
    void poll().then(schedule);
    const soon = () => { if (timer.current) clearTimeout(timer.current); void poll().then(schedule); };
    const onFocus = () => { if (document.visibilityState === "visible") soon(); };
    window.addEventListener("focus", soon);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener(AI_JOB_STARTED_EVENT, soon);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener("focus", soon);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener(AI_JOB_STARTED_EVENT, soon);
    };
  }, [enabled, poll]);

  // Notices fade by themselves; the one of the page just opened goes at once.
  useEffect(() => {
    if (!notices.length) return;
    const t = setTimeout(() => setNotices((prev) => prev.slice(1)), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notices]);
  useEffect(() => {
    setNotices((prev) => prev.filter((n) => !pathname || !n.href.startsWith(pathname + "?")));
  }, [pathname]);

  const value = useMemo<AiJobsContextValue>(() => ({
    running,
    refresh: () => { void poll(); },
    ignore: (jobId) => { ignored.current.add(jobId); },
  }), [running, poll]);

  return (
    <AiJobsContext.Provider value={value}>
      {children}
      {notices.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm" role="status" aria-live="polite">
          {notices.map((job) => (
            <div key={job.id} className="flex items-start gap-3 rounded-xl border border-violet-500/30 bg-gray-950/95 shadow-2xl px-4 py-3 text-sm text-gray-100 backdrop-blur">
              <div className="w-8 h-8 rounded-lg bg-violet-600/20 text-violet-300 flex items-center justify-center shrink-0">
                <Bot className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{job.status === "done" ? "Réponse prête" : job.status === "stopped" ? "Réponse arrêtée" : "L'assistant n'a pas pu répondre"}</div>
                <div className="text-xs text-gray-400 truncate" title={job.title}>{SURFACE_LABEL[job.surface]} · {job.title || "Conversation"}</div>
                <Link href={job.href} onClick={() => setNotices((prev) => prev.filter((n) => n.id !== job.id))} className="inline-block mt-1.5 text-xs font-medium text-violet-300 hover:text-white">
                  Ouvrir la conversation →
                </Link>
              </div>
              <button type="button" aria-label="Fermer" onClick={() => setNotices((prev) => prev.filter((n) => n.id !== job.id))} className="text-gray-500 hover:text-gray-200">
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </AiJobsContext.Provider>
  );
}
