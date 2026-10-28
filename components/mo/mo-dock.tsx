"use client";

/**
 * Mo everywhere: a small orb at the bottom right of every staff page (left of
 * the Guide bubble). Hold it (or Alt+M) and speak; release: Mo transcribes,
 * understands navigation at once ("ouvre le cockpit de Naturalia" → the page
 * opens in under a second, no model call), and asks the model for anything
 * else — spoken answer + cards on the consultant's « Mo partout » board
 * (/mo?b=…). States: idle → listening → transcribing → thinking → speaking →
 * done | error (retry). Hidden on /mo itself, which has the full experience.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AudioLines, Loader2, Mic, RotateCcw, Square, Volume2, X } from "lucide-react";
import { useVoice } from "@/components/mo/use-voice";
import type { MoBoardData } from "@/lib/mo/model";
import { parseNavIntent, parseQuickIntent, type IntentClient } from "@/lib/mo/intents";
import { AI_JOB_STARTED_EVENT, followJob, stopJob, type JobEvent } from "@/lib/ai-job-client";
import { INITIAL_ACTIVITY, activityLabel, reduceActivity, type ActivityState } from "@/lib/ai-activity";

interface Bubble { you: string; mo: string | null; cards: number; open: string | null; error?: string; retry?: string }

const HIDE_ON = ["/mo", "/login"];
const BUBBLE_MS = 12_000;
const HINT_KEY = "mo:hint-seen";

export function MoDock() {
  const pathname = usePathname();
  const router = useRouter();
  const [boardId, setBoardId] = useState<string | null>(null);
  const [run, setRun] = useState<{ jobId: string; activity: ActivityState; startedAt: number } | null>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [hidden, setHidden] = useState(false);
  const [hint, setHint] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const follower = useRef<AbortController | null>(null);
  const bubbleTimer = useRef<number | null>(null);
  const speakRef = useRef<(text: string) => void>(() => undefined);
  /** Sentence already spoken from the stream (not said twice at the end). */
  const earlySaid = useRef<string | null>(null);
  const streamText = useRef("");
  const pathRef = useRef(pathname);
  const clientsRef = useRef<IntentClient[]>([]);
  const seenTurns = useRef(0);
  useEffect(() => { pathRef.current = pathname; }, [pathname]);

  // First use: a one-time hint; the clients for the instant navigation.
  useEffect(() => {
    queueMicrotask(() => { try { if (!localStorage.getItem(HINT_KEY)) setHint(true); } catch { /* fine */ } });
    fetch("/api/clients").then((r) => (r.ok ? r.json() : { clients: [] })).then((j: { clients: Array<{ id: string; name: string; dashboardId: string | null }> }) => {
      clientsRef.current = (j.clients ?? []).map((c) => ({ id: c.id, name: c.name, dashboardId: c.dashboardId }));
    }).catch(() => undefined);
  }, []);
  const dismissHint = useCallback(() => { setHint(false); try { localStorage.setItem(HINT_KEY, "1"); } catch { /* fine */ } }, []);

  useEffect(() => {
    if (!run) return;
    const started = run.startedAt;
    const t = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => { window.clearInterval(t); queueMicrotask(() => setElapsed(0)); };
  }, [run]);

  const showBubble = useCallback((b: Bubble | null, ms = BUBBLE_MS) => {
    setBubble(b);
    if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current);
    if (b && ms > 0) bubbleTimer.current = window.setTimeout(() => setBubble(null), ms);
  }, []);

  const ensureBoard = useCallback(async (): Promise<string | null> => {
    if (boardId) return boardId;
    const r = await fetch("/api/mo?dock=1", { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { board: MoBoardData };
    setBoardId(j.board.id);
    seenTurns.current = j.board.messages.filter((m) => m.role === "assistant").length;
    return j.board.id;
  }, [boardId]);

  const finish = useCallback(async (id: string, you: string) => {
    // The "done" event is released once the answer is stored; a short retry covers a slow write anyway.
    let board: MoBoardData | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(`/api/mo/${id}`, { cache: "no-store" }).catch(() => null);
      if (r?.ok) {
        board = ((await r.json()) as { board: MoBoardData }).board;
        const count = board.messages.filter((m) => m.role === "assistant").length;
        if (count > seenTurns.current) { seenTurns.current = count; break; }
      }
      await new Promise((res) => window.setTimeout(res, 500 * (attempt + 1)));
    }
    if (!board) { showBubble({ you, mo: null, cards: 0, open: null, error: "Mo n'a pas répondu.", retry: you }); return; }
    const last = [...board.messages].reverse().find((m) => m.role === "assistant");
    const say = last?.say ?? null;
    const open = last?.open ?? null;
    const cards = last?.cardIds?.length ?? 0;
    // A result with cards stays until dismissed.
    showBubble({ you, mo: say, cards, open }, cards ? 0 : open ? 6_000 : BUBBLE_MS);
    if (say && earlySaid.current !== say) speakRef.current(say);
    earlySaid.current = null;
    if (open) window.setTimeout(() => router.push(open), 700);
  }, [router, showBubble]);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || run) return;
    // Navigation understood here: no model, no wait.
    const nav = parseNavIntent(t, clientsRef.current);
    if (nav) {
      showBubble({ you: t, mo: nav.say, cards: 0, open: nav.path }, 5_000);
      speakRef.current(nav.say);
      window.setTimeout(() => router.push(nav.path), 500);
      return;
    }
    showBubble({ you: t, mo: null, cards: 0, open: null }, 0);
    const id = await ensureBoard();
    if (!id) { showBubble({ you: t, mo: null, cards: 0, open: null, error: "Mo est indisponible.", retry: t }); return; }
    // Créas or figures of a named client over a period: run by the app at once, no model.
    if (parseQuickIntent(t, clientsRef.current)) {
      setRun({ jobId: "quick", activity: INITIAL_ACTIVITY, startedAt: Date.now() });
      try {
        const res = await fetch(`/api/mo/${id}/quick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: t }) });
        if (res.status === 200) {
          const j = (await res.json()) as { say: string; cardIds: string[] };
          setRun(null);
          showBubble({ you: t, mo: j.say, cards: j.cardIds.length, open: null }, j.cardIds.length ? 0 : BUBBLE_MS);
          speakRef.current(j.say);
          return;
        }
      } catch { /* the normal way below */ }
      setRun(null);
    }
    try {
      const res = await fetch(`/api/mo/${id}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: t, page: pathRef.current }) });
      const j = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!res.ok || !j.jobId) throw new Error(j.error ?? `Erreur ${res.status}`);
      window.dispatchEvent(new Event(AI_JOB_STARTED_EVENT));
      follower.current?.abort();
      const ctl = new AbortController();
      follower.current = ctl;
      const jobId = j.jobId;
      setRun({ jobId, activity: INITIAL_ACTIVITY, startedAt: Date.now() });
      streamText.current = "";
      earlySaid.current = null;
      const onEvent = (e: JobEvent) => {
        if (e.type === "job") return;
        // « say » comes first in the answer: spoken as soon as it is complete.
        if ((e.type === "delta" || e.type === "content") && typeof e.text === "string") {
          streamText.current = e.type === "content" && !streamText.current ? e.text : streamText.current + (e.type === "delta" ? e.text : "");
          if (!earlySaid.current) {
            const m = streamText.current.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (m) {
              let sentence = "";
              try { sentence = String(JSON.parse(`"${m[1]}"`)); } catch { sentence = m[1]; }
              if (sentence.trim()) { earlySaid.current = sentence; showBubble({ you: t, mo: sentence, cards: 0, open: null }, 0); speakRef.current(sentence); }
            }
          }
        }
        setRun((r) => (r && r.jobId === jobId ? { ...r, activity: reduceActivity(r.activity, e) } : r));
      };
      void followJob(jobId, onEvent, ctl.signal).then(async (outcome) => {
        if (outcome === "aborted") return;
        follower.current = null;
        setRun(null);
        if (outcome === "failed") { showBubble({ you: t, mo: null, cards: 0, open: null, error: "La réponse a échoué.", retry: t }); return; }
        await finish(id, t);
      }).catch(() => { follower.current = null; setRun(null); showBubble({ you: t, mo: null, cards: 0, open: null, error: "Suivi interrompu.", retry: t }); });
    } catch (e) {
      showBubble({ you: t, mo: null, cards: 0, open: null, error: e instanceof Error ? e.message : "Mo n'a pas démarré.", retry: t });
    }
  }, [run, ensureBoard, finish, showBubble, router]);

  const voice = useVoice(send);
  useEffect(() => { speakRef.current = voice.speak; }, [voice.speak]);

  // Alt+M held = talk (anywhere, even in a text field); Escape = quiet.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.altKey && e.code === "KeyM" && !e.repeat && !run) { e.preventDefault(); dismissHint(); voice.begin(); }
      if (e.key === "Escape" && (voice.listening || voice.speaking)) { voice.hush(); voice.cancel(); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === "KeyM" && voice.listening) { e.preventDefault(); voice.end(); } };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [voice, run, dismissHint]);

  useEffect(() => () => { follower.current?.abort(); }, []);

  if (hidden || HIDE_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;

  const status = run
    ? `${activityLabel(run.activity)}${elapsed >= 3 ? ` · ${elapsed} s` : ""}`
    : voice.listening ? (voice.interim || "Je t'écoute…")
    : voice.transcribing ? "Je note ce que tu as dit…"
    : null;
  const listening = voice.listening;

  return (
    <div className="fixed bottom-5 right-[11.5rem] z-40 flex flex-col items-end gap-2 print:hidden pointer-events-none">
      {hint && !bubble && !status && (
        <div className="pointer-events-auto max-w-[18rem] rounded-xl border border-violet-400/30 bg-[#0d0a1a]/95 backdrop-blur px-3 py-2 text-[12px] text-gray-200 shadow-xl">
          <div className="flex items-start gap-2">
            <AudioLines className="w-4 h-4 text-violet-300 shrink-0 mt-0.5" />
            <div>Je suis Mo. Maintiens l&apos;orbe ou <kbd className="px-1 rounded border border-white/15 bg-white/5 text-[10px]">Alt+M</kbd> et parle : « ouvre le cockpit de Naturalia », « CPA de LPEV cette semaine »…</div>
            <button type="button" onClick={dismissHint} className="text-gray-500 hover:text-white" aria-label="Fermer"><X className="w-3.5 h-3.5" /></button>
          </div>
        </div>
      )}
      {(bubble || status || voice.error) && (
        <div className={`pointer-events-auto w-[min(90vw,22rem)] rounded-2xl border bg-[#0d0a1a]/95 backdrop-blur-xl shadow-2xl px-3.5 py-2.5 text-[13px] text-gray-100 space-y-1 ${bubble?.error || voice.error ? "border-rose-400/40" : "border-violet-400/25"}`}>
          {bubble?.you && !listening && <div className="text-gray-400 line-clamp-2"><span className="text-gray-600">Toi ·</span> {bubble.you}</div>}
          {status ? (
            <div className="flex items-center gap-2 text-violet-100">{(run || voice.transcribing) && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />}<span className="truncate">{status}{run ? "…" : ""}</span></div>
          ) : bubble?.mo ? (
            <div className="leading-snug flex items-start gap-2"><span>{voice.speaking ? <Volume2 className="w-3.5 h-3.5 text-violet-300 inline" /> : <span className="text-violet-300">Mo ·</span>} {bubble.mo}</span>{voice.speaking && <button type="button" onClick={() => voice.hush()} className="ml-auto text-[11px] text-gray-400 hover:text-white shrink-0">stop</button>}</div>
          ) : null}
          {bubble?.cards ? <Link href={`/mo?b=${boardId}`} className="inline-flex items-center gap-1 text-[12px] text-violet-300 hover:text-white"><AudioLines className="w-3.5 h-3.5" /> {bubble.cards} carte{bubble.cards > 1 ? "s" : ""} sur ton tableau Mo →</Link> : null}
          {(bubble?.error || voice.error) && (
            <div className="flex items-center gap-2 text-[12px] text-rose-300">
              <span className="flex-1">{bubble?.error ?? voice.error}</span>
              {bubble?.retry && <button type="button" onClick={() => void send(bubble.retry!)} className="inline-flex items-center gap-1 text-gray-300 hover:text-white"><RotateCcw className="w-3 h-3" /> réessayer</button>}
            </div>
          )}
          {(bubble?.cards || bubble?.error) ? <button type="button" onClick={() => showBubble(null)} className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-gray-800 border border-white/10 text-gray-400 hover:text-white inline-flex items-center justify-center" aria-label="Fermer"><X className="w-3 h-3" /></button> : null}
        </div>
      )}
      <div className="pointer-events-auto flex items-center gap-1.5">
        {run ? (
          <button type="button" onClick={() => void stopJob(run.jobId).catch(() => undefined)} className="w-11 h-11 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 shadow-[0_0_30px_rgba(139,92,246,0.5)] inline-flex items-center justify-center text-white mo-orb-think" title="Arrêter Mo" aria-label="Arrêter Mo"><Square className="w-4 h-4" /></button>
        ) : (
          <button
            type="button"
            onPointerDown={(e) => { e.preventDefault(); dismissHint(); voice.begin(); }}
            onPointerUp={() => voice.end()}
            onPointerLeave={() => { if (voice.listening) voice.end(); }}
            onContextMenu={(e) => { e.preventDefault(); setHidden(true); }}
            className={`rounded-full inline-flex items-center justify-center text-white transition-all ${listening ? "w-14 h-14 bg-gradient-to-br from-fuchsia-500 to-violet-600 shadow-[0_0_50px_rgba(217,70,239,0.7)]" : voice.transcribing ? "w-11 h-11 bg-gradient-to-br from-violet-500 to-purple-700 mo-orb-think" : "w-11 h-11 bg-gradient-to-br from-violet-500/90 to-purple-700/90 shadow-[0_0_24px_rgba(139,92,246,0.4)] opacity-80 hover:opacity-100 hover:scale-105"}`}
            style={listening ? { transform: `scale(${1 + voice.level * 0.25})` } : undefined}
            title={voice.supported ? "Mo — maintiens pour parler (ou Alt+M) · clic droit pour masquer" : "Mo — maintiens pour parler (enregistrement, transcription sur le serveur)"}
            aria-label="Parler à Mo"
          >
            {voice.transcribing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Mic className="w-5 h-5" />}
          </button>
        )}
      </div>
    </div>
  );
}
