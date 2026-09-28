"use client";

/**
 * Live status line of a running AI turn: what it is doing, how many steps it
 * has done and for how long — so a long task (deck, multi-account analysis)
 * never looks frozen.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { activityLabel, formatElapsed, type ActivityState } from "@/lib/ai-activity";

const LONG_TASK_MS = 45_000;

export function AiActivity({ state, startedAt, className }: { state: ActivityState; startedAt: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = now - startedAt;

  return (
    <div className={className} role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-violet-300">
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        <span className="truncate">{activityLabel(state)}…</span>
        <span className="text-gray-500 shrink-0 tabular-nums">
          {state.steps > 0 ? `étape ${state.steps} · ` : ""}{formatElapsed(elapsed)}
        </span>
      </div>
      {elapsed > LONG_TASK_MS && (
        <div className="text-[11px] text-gray-500 mt-1">
          L&apos;IA travaille toujours. Un deck ou une analyse complète peut prendre plusieurs minutes — laissez cette page ouverte.
        </div>
      )}
    </div>
  );
}
