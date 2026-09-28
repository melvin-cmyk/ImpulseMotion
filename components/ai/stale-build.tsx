"use client";

/**
 * Tells a consultant that the tab runs an older build than the server (a tab
 * left open across a deployment keeps its old chat code: no automatic
 * relaunch, raw errors). Checked on mount, on focus and every few minutes.
 */

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

const LOADED_BUILD = process.env.NEXT_PUBLIC_APP_BUILD ?? "dev";
const CHECK_EVERY_MS = 5 * 60_000;

export function useStaleBuild(): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (LOADED_BUILD === "dev") return;
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { build } = (await res.json()) as { build?: string };
        if (!stopped && build && build !== "dev" && build !== LOADED_BUILD) setStale(true);
      } catch { /* offline: try again later */ }
    };
    void check();
    const timer = setInterval(check, CHECK_EVERY_MS);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, []);
  return stale;
}

export function StaleBuildBanner({ className }: { className?: string }) {
  const stale = useStaleBuild();
  if (!stale) return null;
  return (
    <div className={`flex items-center gap-2 text-xs text-amber-200 bg-amber-950/40 border border-amber-900/50 rounded-lg px-3 py-2 ${className ?? ""}`}>
      <span className="flex-1">Une nouvelle version de l&apos;assistant est en ligne. Rechargez la page pour en profiter — vos conversations sont conservées.</span>
      <button type="button" onClick={() => window.location.reload()} className="inline-flex items-center gap-1 text-amber-100 hover:text-white border border-amber-800 rounded-md px-2 py-0.5 shrink-0">
        <RefreshCw className="w-3 h-3" /> Recharger
      </button>
    </div>
  );
}
