"use client";

/**
 * Mo everywhere: a small orb at the bottom right of every staff page (left of
 * the Guide bubble). Hold it (or Alt+M) and speak; release: Mo transcribes,
 * understands navigation at once ("ouvre le cockpit de Naturalia" → the page
 * opens in under a second, no model call), and asks the model for anything
 * else — spoken answer + cards on the consultant's home page « Aujourd'hui »
 * (/mo). States: idle → listening → transcribing → thinking → speaking →
 * done | error (retry). Hidden on /mo itself, which has the full experience.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AudioLines, Loader2, Mic, RotateCcw, Square, Volume2, X } from "lucide-react";
import { useVoice } from "@/components/mo/use-voice";
import { warmMoBoard } from "@/components/mo/warm";
import type { MoBoardData } from "@/lib/mo/model";
import { PERIOD_OPTIONS, completeQuickAsk, orderClientCandidates, parseNavIntent, parseQuickIntent, type IntentClient } from "@/lib/mo/intents";
import { moStatusLabel } from "@/lib/mo/status";
import { nextSentences, sayProgress } from "@/lib/mo/voice";
import { AI_JOB_STARTED_EVENT, followJob, stopJob, type JobEvent } from "@/lib/ai-job-client";
import { INITIAL_ACTIVITY, reduceActivity, type ActivityState } from "@/lib/ai-activity";

interface Bubble { you: string; mo: string | null; cards: number; open: string | null; error?: string; retry?: string; /** Mo is missing one thing: the chips complete the sentence. */ chips?: Array<{ label: string; text: string }> }

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
  const spokenCount = useRef(0);
  const sayRef = useRef<(text: string) => void>(() => undefined);
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
    warmMoBoard(j.board.id);
    return j.board.id;
  }, [boardId]);
  // The orb is pressed: the board is fetched if needed and Mo's process warmed meanwhile (fire and forget).
  const warmOnSpeak = useCallback(() => { if (boardId) warmMoBoard(boardId); else void ensureBoard().catch(() => undefined); }, [boardId, ensureBoard]);

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
    // What the stream did not say yet is said now (the rest of the sentence, or everything when nothing streamed).
    if (say) { const left = earlySaid.current && say.startsWith(earlySaid.current) ? say.slice(earlySaid.current.length).trim() : earlySaid.current ? "" : say; if (left) sayRef.current(left); }
    earlySaid.current = null;
    spokenCount.current = 0;
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
    // « Créas cette semaine » without a client: Mo asks, the chips complete the sentence (no model, no server).
    const quick = parseQuickIntent(t, clientsRef.current);
    if (quick?.kind === "ask") {
      const chips = quick.missing === "client"
        ? orderClientCandidates(quick.candidates, []).slice(0, 6).map((c) => ({ label: c.name, text: completeQuickAsk(quick, c) }))
        : PERIOD_OPTIONS.map((p) => ({ label: p.label, text: completeQuickAsk(quick, p) }));
      showBubble({ you: t, mo: quick.question, cards: 0, open: null, chips }, 0);
      speakRef.current(quick.question);
      return;
    }
    const id = await ensureBoard();
    if (!id) { showBubble({ you: t, mo: null, cards: 0, open: null, error: "Mo est indisponible.", retry: t }); return; }
    // Créas or figures of a named client over a period: run by the app at once, no model.
    if (quick) {
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
      spokenCount.current = 0;
      const onEvent = (e: JobEvent) => {
        if (e.type === "job") return;
        // « say » comes first in the answer: spoken sentence by sentence as it streams (lib/mo/voice.ts).
        if ((e.type === "delta" || e.type === "content") && typeof e.text === "string") {
          streamText.current = e.type === "content" && !streamText.current ? e.text : streamText.current + (e.type === "delta" ? e.text : "");
          const progress = sayProgress(streamText.current);
          if (progress && progress.text.trim()) {
            const { sentences, spoken } = nextSentences(progress, spokenCount.current);
            spokenCount.current = spoken;
            if (sentences.length) {
              earlySaid.current = `${earlySaid.current ? `${earlySaid.current} ` : ""}${sentences.join(" ")}`;
              showBubble({ you: t, mo: earlySaid.current, cards: 0, open: null }, 0);
              for (const sentence of sentences) sayRef.current(sentence);
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
  useEffect(() => { speakRef.current = voice.speak; sayRef.current = voice.say; }, [voice.speak, voice.say]);

  // Alt+M held = talk (anywhere, even in a text field); Escape = quiet.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.altKey && e.code === "KeyM" && !e.repeat && !run) { e.preventDefault(); dismissHint(); warmOnSpeak(); voice.begin(); }
      if (e.key === "Escape" && (voice.listening || voice.speaking)) { voice.hush(); voice.cancel(); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === "KeyM" && voice.listening) { e.preventDefault(); voice.end(); } };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [voice, run, dismissHint, warmOnSpeak]);

  useEffect(() => () => { follower.current?.abort(); }, []);

  if (hidden || HIDE_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;

  const status = run
    ? `${moStatusLabel(run.activity, run.jobId === "quick" ? "quick" : "model")}${elapsed >= 3 ? ` · ${elapsed} s` : ""}`
    : voice.listening ? (voice.interim || "Je t'écoute…")
    : voice.transcribing ? "Je note ce que tu as dit…"
    : null;
  const listening = voice.listening;

  return (
    <div className="fixed bottom-5 right-[11.5rem] z-40 flex flex-col items-end gap-2 print:hidden pointer-events-none">
      {hint && !bubble && !status && (
        <div className="pointer-events-auto max-w-[18rem] rounded-xl border border-ui-accent bg-ui-bg/95 backdrop-blur px-3 py-2 text-[12px] text-ui-fg shadow-xl">
          <div className="flex items-start gap-2">
            <AudioLines className="w-4 h-4 text-ui-accent-ink shrink-0 mt-0.5" />
            <div>Je suis Mo. Maintiens l&apos;orbe ou <kbd className="px-1 rounded border border-ui-line bg-ui-raised text-[10px]">Alt+M</kbd> et parle : « ouvre le cockpit de Naturalia », « CPA de LPEV cette semaine »…</div>
            <button type="button" onClick={dismissHint} className="text-ui-muted hover:text-ui-fg" aria-label="Fermer"><X className="w-3.5 h-3.5" /></button>
          </div>
        </div>
      )}
      {(bubble || status || voice.error) && (
        <div className={`pointer-events-auto w-[min(90vw,22rem)] rounded-xl border bg-ui-bg/95 backdrop-blur-xl shadow-2xl px-3.5 py-2.5 text-[13px] text-ui-fg space-y-1 ${bubble?.error || voice.error ? "border-rose-400/40" : "border-ui-accent"}`}>
          {bubble?.you && !listening && <div className="text-ui-fg2 line-clamp-2"><span className="text-ui-muted">Toi ·</span> {bubble.you}</div>}
          {status ? (
            <div className="flex items-center gap-2 text-ui-accent-ink">{(run || voice.transcribing) && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />}<span className="truncate">{status}{run ? "…" : ""}</span></div>
          ) : bubble?.mo ? (
            <div className="leading-snug flex items-start gap-2"><span>{voice.speaking ? <Volume2 className="w-3.5 h-3.5 text-ui-accent-ink inline" /> : <span className="text-ui-accent-ink">Mo ·</span>} {bubble.mo}</span>{voice.speaking && <button type="button" onClick={() => voice.hush()} className="ml-auto text-[11px] text-ui-fg2 hover:text-ui-fg shrink-0">stop</button>}</div>
          ) : null}
          {bubble?.chips && !status && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {bubble.chips.map((c) => <button key={c.label} type="button" onClick={() => void send(c.text)} className="rounded-full border border-ui-accent bg-ui-accent-soft px-2.5 py-0.5 text-[12px] text-ui-accent-ink hover:bg-ui-accent-soft">{c.label}</button>)}
            </div>
          )}
          {bubble?.cards ? <Link href="/mo" className="inline-flex items-center gap-1 text-[12px] text-ui-accent-ink hover:text-ui-fg"><AudioLines className="w-3.5 h-3.5" /> {bubble.cards} carte{bubble.cards > 1 ? "s" : ""} · voir sur mon espace →</Link> : null}
          {(bubble?.error || voice.error) && (
            <div className="flex items-center gap-2 text-[12px] text-rose-300">
              <span className="flex-1">{bubble?.error ?? voice.error}</span>
              {bubble?.retry && <button type="button" onClick={() => void send(bubble.retry!)} className="inline-flex items-center gap-1 text-ui-fg2 hover:text-ui-fg"><RotateCcw className="w-3 h-3" /> réessayer</button>}
            </div>
          )}
          {(bubble?.cards || bubble?.error || bubble?.chips) ? <button type="button" onClick={() => showBubble(null)} className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-ui-raised border border-ui-line text-ui-fg2 hover:text-ui-fg inline-flex items-center justify-center" aria-label="Fermer"><X className="w-3 h-3" /></button> : null}
        </div>
      )}
      <div className="pointer-events-auto flex items-center gap-1.5">
        {run ? (
          <button type="button" onClick={() => void stopJob(run.jobId).catch(() => undefined)} className="w-11 h-11 rounded-full inline-flex items-center justify-center text-ui-on-accent mo-orb-think bg-ui-accent" title="Arrêter Mo" aria-label="Arrêter Mo"><Square className="w-4 h-4" /></button>
        ) : (
          <button
            type="button"
            onPointerDown={(e) => { e.preventDefault(); dismissHint(); warmOnSpeak(); voice.begin(); }}
            onPointerUp={() => voice.end()}
            onPointerLeave={() => { if (voice.listening) voice.end(); }}
            onContextMenu={(e) => { e.preventDefault(); setHidden(true); }}
            className={`rounded-full inline-flex items-center justify-center text-white transition-colors ${listening ? "w-14 h-14 bg-ui-accent" : voice.transcribing ? "w-11 h-11 mo-orb-think bg-ui-accent" : "w-11 h-11 opacity-80 hover:opacity-100 hover:scale-105 bg-ui-accent"}`}
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
