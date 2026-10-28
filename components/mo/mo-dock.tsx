"use client";

/**
 * Mo everywhere: a small orb at the bottom of every staff page. Hold it (or
 * Alt+M) and speak; Mo answers out loud, opens the page asked for ("ouvre le
 * cockpit de Naturalia") and lays any card on the consultant's « Mo partout »
 * board (/mo?b=…), where a link takes them. Hidden on /mo itself, which has
 * the full experience.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AudioLines, Loader2, Mic, Square, X } from "lucide-react";
import { useVoice } from "@/components/mo/use-voice";
import type { MoBoardData } from "@/lib/mo/model";
import { AI_JOB_STARTED_EVENT, followJob, stopJob, type JobEvent } from "@/lib/ai-job-client";
import { INITIAL_ACTIVITY, activityLabel, reduceActivity, type ActivityState } from "@/lib/ai-activity";

interface Bubble { you: string; mo: string | null; cards: number; open: string | null; error?: string }

const HIDE_ON = ["/mo", "/login"];
const BUBBLE_MS = 12_000;

export function MoDock() {
  const pathname = usePathname();
  const router = useRouter();
  const [boardId, setBoardId] = useState<string | null>(null);
  const [run, setRun] = useState<{ jobId: string; activity: ActivityState } | null>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [hidden, setHidden] = useState(false);
  const follower = useRef<AbortController | null>(null);
  const bubbleTimer = useRef<number | null>(null);
  const speakRef = useRef<(text: string) => void>(() => undefined);
  const pathRef = useRef(pathname);
  useEffect(() => { pathRef.current = pathname; }, [pathname]);

  const showBubble = useCallback((b: Bubble | null, ms = BUBBLE_MS) => {
    setBubble(b);
    if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current);
    if (b) bubbleTimer.current = window.setTimeout(() => setBubble(null), ms);
  }, []);

  const ensureBoard = useCallback(async (): Promise<string | null> => {
    if (boardId) return boardId;
    const r = await fetch("/api/mo?dock=1", { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { board: MoBoardData };
    setBoardId(j.board.id);
    return j.board.id;
  }, [boardId]);

  const finish = useCallback(async (id: string, you: string) => {
    const r = await fetch(`/api/mo/${id}`, { cache: "no-store" }).catch(() => null);
    if (!r?.ok) { showBubble({ you, mo: null, cards: 0, open: null, error: "Mo n'a pas répondu." }); return; }
    const j = (await r.json()) as { board: MoBoardData };
    const last = [...j.board.messages].reverse().find((m) => m.role === "assistant");
    const say = last?.say ?? null;
    const open = last?.open ?? null;
    showBubble({ you, mo: say, cards: last?.cardIds?.length ?? 0, open }, open ? 6_000 : BUBBLE_MS);
    if (say) speakRef.current(say);
    if (open) window.setTimeout(() => router.push(open), 700);
  }, [router, showBubble]);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || run) return;
    showBubble({ you: t, mo: null, cards: 0, open: null }, 120_000);
    const id = await ensureBoard();
    if (!id) { showBubble({ you: t, mo: null, cards: 0, open: null, error: "Mo est indisponible." }); return; }
    try {
      const res = await fetch(`/api/mo/${id}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: t, page: pathRef.current }) });
      const j = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!res.ok || !j.jobId) throw new Error(j.error ?? `Erreur ${res.status}`);
      window.dispatchEvent(new Event(AI_JOB_STARTED_EVENT));
      follower.current?.abort();
      const ctl = new AbortController();
      follower.current = ctl;
      const jobId = j.jobId;
      setRun({ jobId, activity: INITIAL_ACTIVITY });
      const onEvent = (e: JobEvent) => { if (e.type !== "job") setRun((r) => (r && r.jobId === jobId ? { ...r, activity: reduceActivity(r.activity, e) } : r)); };
      void followJob(jobId, onEvent, ctl.signal).then(async (outcome) => {
        if (outcome === "aborted") return;
        follower.current = null;
        setRun(null);
        await finish(id, t);
      }).catch(() => { follower.current = null; setRun(null); showBubble({ you: t, mo: null, cards: 0, open: null, error: "Suivi interrompu." }); });
    } catch (e) {
      showBubble({ you: t, mo: null, cards: 0, open: null, error: e instanceof Error ? e.message : "Mo n'a pas démarré." });
    }
  }, [run, ensureBoard, finish, showBubble]);

  const voice = useVoice(send);
  useEffect(() => { speakRef.current = voice.speak; }, [voice.speak]);

  // Alt+M held = talk (anywhere, even in a text field); Escape = quiet.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.altKey && (e.code === "KeyM") && !e.repeat && !run) { e.preventDefault(); voice.begin(); }
      if (e.key === "Escape" && (voice.listening || voice.speaking)) { voice.hush(); voice.cancel(); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === "KeyM" && voice.listening) { e.preventDefault(); voice.end(); } };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [voice, run]);

  useEffect(() => () => { follower.current?.abort(); }, []);

  if (hidden || HIDE_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;

  const status = run ? activityLabel(run.activity) : voice.listening ? (voice.interim || "Je t'écoute…") : null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-2 print:hidden pointer-events-none">
      {(bubble || status || voice.error) && (
        <div className="pointer-events-auto max-w-[min(90vw,30rem)] rounded-2xl border border-violet-400/20 bg-[#0d0a1a]/95 backdrop-blur-xl shadow-2xl px-4 py-2.5 text-[13px] text-gray-100 space-y-1">
          {bubble?.you && !voice.listening && <div className="text-gray-400 line-clamp-2"><span className="text-gray-600">Toi ·</span> {bubble.you}</div>}
          {status ? (
            <div className="flex items-center gap-2 text-violet-100">{run && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />}<span className="truncate">{status}{run ? "…" : ""}</span></div>
          ) : bubble?.mo ? (
            <div className="leading-snug"><span className="text-violet-300">Mo ·</span> {bubble.mo}</div>
          ) : null}
          {bubble?.cards ? <Link href={`/mo?b=${boardId}`} className="inline-flex items-center gap-1 text-[12px] text-violet-300 hover:text-white"><AudioLines className="w-3.5 h-3.5" /> {bubble.cards} carte{bubble.cards > 1 ? "s" : ""} sur ton tableau Mo →</Link> : null}
          {(bubble?.error || voice.error) && <div className="text-[12px] text-rose-300">{bubble?.error ?? voice.error}</div>}
        </div>
      )}
      <div className="pointer-events-auto flex items-center gap-1.5">
        {run ? (
          <button type="button" onClick={() => void stopJob(run.jobId).catch(() => undefined)} className="w-11 h-11 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 shadow-[0_0_30px_rgba(139,92,246,0.5)] inline-flex items-center justify-center text-white mo-orb-think" title="Arrêter Mo" aria-label="Arrêter Mo"><Square className="w-4 h-4" /></button>
        ) : (
          <button
            type="button"
            onPointerDown={(e) => { e.preventDefault(); voice.begin(); }}
            onPointerUp={() => voice.end()}
            onPointerLeave={() => { if (voice.listening) voice.end(); }}
            onContextMenu={(e) => e.preventDefault()}
            className={`rounded-full inline-flex items-center justify-center text-white transition-all ${voice.listening ? "w-14 h-14 bg-gradient-to-br from-fuchsia-500 to-violet-600 shadow-[0_0_50px_rgba(217,70,239,0.7)]" : "w-11 h-11 bg-gradient-to-br from-violet-500/90 to-purple-700/90 shadow-[0_0_24px_rgba(139,92,246,0.4)] opacity-80 hover:opacity-100 hover:scale-105"}`}
            style={voice.listening ? { transform: `scale(${1 + voice.level * 0.25})` } : undefined}
            title={voice.supported ? "Mo — maintiens pour parler (ou Alt+M)" : "Mo — reconnaissance vocale indisponible ici (utilise Chrome)"}
            aria-label="Parler à Mo"
          >
            <Mic className="w-5 h-5" />
          </button>
        )}
        {!voice.listening && !run && (
          <button type="button" onClick={() => setHidden(true)} className="w-6 h-6 rounded-full bg-black/40 text-gray-500 hover:text-white inline-flex items-center justify-center opacity-0 hover:opacity-100 focus:opacity-100 transition-opacity -ml-3 -mt-8" title="Masquer Mo jusqu'au prochain chargement" aria-label="Masquer Mo"><X className="w-3 h-3" /></button>
        )}
      </div>
    </div>
  );
}
