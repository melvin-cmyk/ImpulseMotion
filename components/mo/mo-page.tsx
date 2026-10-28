"use client";

/**
 * /mo — Mo's screen. Full-screen board over the app chrome: the violet wave
 * behind, the cards in front, the microphone at the bottom. Hold SPACE (or the
 * orb) to talk; release to send. Mo answers out loud and lays its cards on a
 * new row of the board. A session = a board, reopened from the list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronDown, Keyboard, Loader2, Maximize2, Mic, Plus, Square, Trash2, Volume2, VolumeX } from "lucide-react";
import { Board, type BoardHandle } from "@/components/mo/board";
import { MoCardView } from "@/components/mo/card";
import { WaveCanvas, type WaveMood } from "@/components/mo/wave-canvas";
import { useVoice } from "@/components/mo/use-voice";
import { CARD_SIZES, type MoBoardData, type MoCard, type MoCardPatch } from "@/lib/mo/model";
import { AI_JOB_STARTED_EVENT, followJob, stopJob, type JobEvent } from "@/lib/ai-job-client";
import { INITIAL_ACTIVITY, activityLabel, formatToolName, reduceActivity, type ActivityState } from "@/lib/ai-activity";

interface BoardSummary { id: string; title: string; updatedAt: string; cards: number }
interface Run { jobId: string; startedAt: number; activity: ActivityState; tools: string[] }

const SUGGESTIONS = [
  "Hello Mo, montre-moi les créas Meta de Naturalia postées vendredi avec CPA, CPL et leads.",
  "Compare ça avec les créas de la semaine d'avant.",
  "Quel client a le CPL le plus bas sur Meta cette semaine ?",
];

export function MoPage() {
  const router = useRouter();
  const params = useSearchParams();
  const wanted = params.get("b");
  const boardRef = useRef<BoardHandle>(null);
  const kRef = useRef(1);
  const [board, setBoard] = useState<MoBoardData | null>(null);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [lastSaid, setLastSaid] = useState<{ you: string; mo: string | null } | null>(null);
  const [intro, setIntro] = useState(true);
  const [typing, setTyping] = useState(false);
  const [input, setInput] = useState("");
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const follower = useRef<AbortController | null>(null);
  const seenTurns = useRef<number>(-1);
  const pending = useRef<Map<string, MoCardPatch>>(new Map());
  const flushTimer = useRef<number | null>(null);
  /** Mo's voice (set once the voice hook is up; it is used by the reply handler above it). */
  const speakRef = useRef<(text: string) => void>(() => undefined);

  // ── Loading ───────────────────────────────────────────────────────────
  const loadBoard = useCallback(async (id: string) => {
    const r = await fetch(`/api/mo/${id}`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status === 404 ? "Session introuvable" : `Erreur ${r.status}`);
    const j = (await r.json()) as { board: MoBoardData; jobId: string | null };
    setBoard(j.board);
    return j;
  }, []);

  const listBoards = useCallback(async () => {
    const r = await fetch("/api/mo", { cache: "no-store" });
    if (!r.ok) return [];
    const j = (await r.json()) as { boards: BoardSummary[] };
    setBoards(j.boards ?? []);
    return j.boards ?? [];
  }, []);

  const createBoard = useCallback(async () => {
    const r = await fetch("/api/mo", { method: "POST" });
    if (!r.ok) throw new Error("Impossible de créer la session");
    const j = (await r.json()) as { board: MoBoardData };
    setBoard(j.board);
    setFresh(new Set());
    setLastSaid(null);
    router.replace(`/mo?b=${j.board.id}`);
    void listBoards();
    return j.board;
  }, [router, listBoards]);

  // ── Following a reply ─────────────────────────────────────────────────
  const finishTurn = useCallback(async (id: string) => {
    const j = await loadBoard(id).catch(() => null);
    if (!j) return;
    const last = [...j.board.messages].reverse().find((m) => m.role === "assistant");
    const ids = new Set(last?.cardIds ?? []);
    setFresh(ids);
    setLastSaid((s) => ({ you: s?.you ?? "", mo: last?.say ?? null }));
    if (last?.say && !muted) speakRef.current(last.say);
    const rects = j.board.cards.filter((c) => ids.has(c.id)).map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h ?? CARD_SIZES[c.type].h }));
    if (rects.length) window.setTimeout(() => boardRef.current?.fit(rects, 90), 60);
  }, [loadBoard, muted]);

  const follow = useCallback((jobId: string, boardId: string) => {
    follower.current?.abort();
    const ctl = new AbortController();
    follower.current = ctl;
    setRun({ jobId, startedAt: Date.now(), activity: INITIAL_ACTIVITY, tools: [] });
    const onEvent = (e: JobEvent) => {
      if (e.type === "job") return;
      setRun((r) => {
        if (!r || r.jobId !== jobId) return r;
        const activity = reduceActivity(r.activity, e);
        const tools = e.type === "tool_call" && typeof e.name === "string" ? [...r.tools, formatToolName(e.name)].slice(-6) : r.tools;
        return { ...r, activity, tools };
      });
      if (e.type === "error" && e.message) setError(e.message);
    };
    void followJob(jobId, onEvent, ctl.signal).then(async (outcome) => {
      if (outcome === "aborted") return;
      follower.current = null;
      setRun(null);
      await finishTurn(boardId);
    }).catch((e) => { follower.current = null; setRun(null); setError(e instanceof Error ? e.message : "Suivi interrompu"); });
  }, [finishTurn]);

  // First load: the wanted board, else the latest, else a new one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listBoards();
        const id = wanted && list.some((b) => b.id === wanted) ? wanted : wanted ?? list[0]?.id ?? null;
        if (!id) { if (!cancelled) await createBoard(); return; }
        const j = await loadBoard(id).catch(async () => { if (!wanted) return null; router.replace("/mo"); return null; });
        if (cancelled) return;
        if (!j) { await createBoard(); return; }
        if (!wanted) router.replace(`/mo?b=${id}`);
        if (j.jobId) follow(j.jobId, id);
        seenTurns.current = j.board.messages.filter((m) => m.role === "assistant").length;
        const last = [...j.board.messages].reverse();
        const you = last.find((m) => m.role === "user")?.content ?? "";
        const mo = last.find((m) => m.role === "assistant")?.say ?? null;
        if (you) setLastSaid({ you, mo });
        window.setTimeout(() => { const rects = j.board.cards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h ?? CARD_SIZES[c.type].h })); if (rects.length) boardRef.current?.fit(rects, 90); }, 120);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Chargement impossible");
      }
    })();
    const t = window.setTimeout(() => setIntro(false), 3400);
    return () => { cancelled = true; window.clearTimeout(t); follower.current?.abort(); follower.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sending ───────────────────────────────────────────────────────────
  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || !board || run) return;
    setError(null);
    setLastSaid({ you: t, mo: null });
    setBoard((b) => (b ? { ...b, messages: [...b.messages, { role: "user", content: t, at: new Date().toISOString() }] } : b));
    try {
      const res = await fetch(`/api/mo/${board.id}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: t }) });
      const j = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (res.status === 409 && j.jobId) { follow(j.jobId, board.id); return; }
      if (!res.ok || !j.jobId) throw new Error(j.error ?? `Erreur ${res.status}`);
      window.dispatchEvent(new Event(AI_JOB_STARTED_EVENT));
      follow(j.jobId, board.id);
      void listBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mo n'a pas démarré");
    }
  }, [board, run, follow, listBoards]);

  const voice = useVoice(send);
  useEffect(() => { speakRef.current = voice.speak; }, [voice.speak]);

  // SPACE held = talk (outside text fields); Escape = quiet.
  useEffect(() => {
    const isTyping = () => { const el = document.activeElement as HTMLElement | null; return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable); };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isTyping() && !run) { e.preventDefault(); voice.begin(); }
      if (e.key === "Escape") { voice.hush(); voice.cancel(); setSessionsOpen(false); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space" && !isTyping()) { e.preventDefault(); voice.end(); } };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [voice, run]);

  // ── Cards geometry ────────────────────────────────────────────────────
  const flush = useCallback(() => {
    if (!board || !pending.current.size) return;
    const cards = Array.from(pending.current.entries()).map(([id, p]) => ({ id, ...p }));
    pending.current = new Map();
    void fetch(`/api/mo/${board.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cards }) }).catch(() => undefined);
  }, [board]);
  const queue = useCallback((id: string, p: MoCardPatch) => {
    pending.current.set(id, { ...(pending.current.get(id) ?? {}), ...p });
    if (flushTimer.current) window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(flush, 500);
  }, [flush]);

  const onMove = useCallback((id: string, dx: number, dy: number) => {
    setBoard((b) => b ? { ...b, cards: b.cards.map((c): MoCard => (c.id === id ? { ...c, x: c.x + dx, y: c.y + dy } as MoCard : c)) } : b);
  }, []);
  const onMoveEnd = useCallback((id: string) => {
    setBoard((b) => { const c = b?.cards.find((x) => x.id === id); if (c) queue(id, { x: Math.round(c.x), y: Math.round(c.y) }); return b; });
  }, [queue]);
  const onToggle = useCallback((id: string) => {
    setBoard((b) => { if (!b) return b; const c = b.cards.find((x) => x.id === id); if (c) queue(id, { minimized: !c.minimized }); return { ...b, cards: b.cards.map((x): MoCard => (x.id === id ? { ...x, minimized: !x.minimized } as MoCard : x)) }; });
  }, [queue]);
  const onClose = useCallback((id: string) => {
    setBoard((b) => (b ? { ...b, cards: b.cards.filter((x) => x.id !== id) } : b));
    queue(id, { removed: true });
  }, [queue]);
  const onFocusRef = useCallback((id: string) => {
    const c = board?.cards.find((x) => x.id === id);
    if (c) boardRef.current?.focus({ x: c.x, y: c.y, w: c.w, h: c.h ?? CARD_SIZES[c.type].h });
  }, [board]);

  const titles = useMemo(() => new Map((board?.cards ?? []).map((c) => [c.id, c.title])), [board]);
  const links = useMemo(() => (board?.cards ?? []).flatMap((c) => {
    const r = c.ref ? board?.cards.find((x) => x.id === c.ref) : null;
    if (!r) return [];
    const a = { x: r.x + r.w / 2, y: r.y + (r.minimized ? 28 : (r.h ?? CARD_SIZES[r.type].h) / 2) };
    const b = { x: c.x + c.w / 2, y: c.y + (c.minimized ? 28 : (c.h ?? CARD_SIZES[c.type].h) / 2) };
    return [{ id: c.id, a, b }];
  }), [board]);

  const mood: WaveMood = intro ? "intro" : voice.listening ? "listening" : run ? "thinking" : voice.speaking ? "speaking" : "idle";
  const status = run ? activityLabel(run.activity) : voice.listening ? (voice.interim || "Je t'écoute…") : voice.speaking ? "Mo parle" : null;

  return (
    <div className="fixed inset-0 z-[70] bg-[#07050f] text-gray-100 overflow-hidden">
      <WaveCanvas mood={mood} level={voice.level} className="absolute inset-0 w-full h-full pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(7,5,15,0)_0%,rgba(7,5,15,0.55)_70%,rgba(7,5,15,0.85)_100%)] pointer-events-none" />

      {/* Intro wordmark */}
      <div className={`absolute inset-0 flex flex-col items-center justify-center pointer-events-none transition-opacity duration-700 ${intro ? "opacity-100" : "opacity-0"}`}>
        <div className="text-[96px] font-semibold tracking-tight bg-gradient-to-r from-violet-200 via-fuchsia-200 to-violet-300 bg-clip-text text-transparent mo-intro-title">Mo</div>
        <div className="text-sm text-violet-200/70 mo-intro-sub">Maintiens <kbd className="px-1.5 py-0.5 rounded border border-white/15 bg-white/5 text-[11px]">espace</kbd> et parle-moi</div>
      </div>

      {/* Board */}
      <Board ref={boardRef} className="absolute inset-0" onViewChange={(v) => { kRef.current = v.k; }}
        underlay={links.length ? (
          <svg className="absolute left-0 top-0 overflow-visible pointer-events-none" width={1} height={1}>
            {links.map((l) => <path key={l.id} d={`M ${l.a.x} ${l.a.y} C ${(l.a.x + l.b.x) / 2} ${l.a.y}, ${(l.a.x + l.b.x) / 2} ${l.b.y}, ${l.b.x} ${l.b.y}`} stroke="rgba(167,139,250,0.45)" strokeWidth={2} strokeDasharray="6 6" fill="none" />)}
          </svg>
        ) : null}
      >
        {(board?.cards ?? []).map((c) => (
          <MoCardView key={c.id} card={c} fresh={fresh.has(c.id)} refTitle={c.ref ? titles.get(c.ref) ?? null : null} getK={() => kRef.current} onMove={onMove} onMoveEnd={onMoveEnd} onToggle={onToggle} onClose={onClose} onFocusRef={onFocusRef} />
        ))}
      </Board>

      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 pointer-events-none">
        <div className="flex items-center gap-2 pointer-events-auto">
          <Link href="/cockpit" className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-white/10"><ArrowLeft className="w-3.5 h-3.5" /> Quitter</Link>
          <div className="relative">
            <button type="button" onClick={() => { setSessionsOpen((o) => !o); void listBoards(); }} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10 max-w-[320px]">
              <span className="w-2 h-2 rounded-full bg-violet-400 shrink-0" /><span className="truncate">{board?.title || "Nouvelle session"}</span><ChevronDown className="w-3.5 h-3.5 shrink-0 text-gray-500" />
            </button>
            {sessionsOpen && (
              <div className="absolute left-0 mt-2 w-80 rounded-xl border border-white/10 bg-[#0d0a1a]/95 backdrop-blur-xl shadow-2xl p-1.5 text-xs">
                <button type="button" onClick={() => { setSessionsOpen(false); void createBoard().catch((e) => setError(e.message)); }} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-violet-200 hover:bg-white/10"><Plus className="w-3.5 h-3.5" /> Nouvelle session</button>
                <div className="max-h-72 overflow-auto mo-scroll mt-1 border-t border-white/5 pt-1">
                  {boards.map((b) => (
                    <div key={b.id} className={`flex items-center gap-1 rounded-lg ${b.id === board?.id ? "bg-white/10" : "hover:bg-white/5"}`}>
                      <button type="button" onClick={() => { setSessionsOpen(false); setFresh(new Set()); router.replace(`/mo?b=${b.id}`); void loadBoard(b.id).then((j) => { if (j.jobId) follow(j.jobId, b.id); const rects = j.board.cards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h ?? CARD_SIZES[c.type].h })); window.setTimeout(() => { if (rects.length) boardRef.current?.fit(rects, 90); }, 60); const last = [...j.board.messages].reverse(); setLastSaid(last.find((m) => m.role === "user") ? { you: last.find((m) => m.role === "user")!.content, mo: last.find((m) => m.role === "assistant")?.say ?? null } : null); }).catch((e) => setError(e.message)); }} className="flex-1 min-w-0 text-left px-2.5 py-2">
                        <div className="truncate text-gray-100">{b.title}</div>
                        <div className="text-[10px] text-gray-500">{new Date(b.updatedAt).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · {b.cards} carte{b.cards > 1 ? "s" : ""}</div>
                      </button>
                      <button type="button" aria-label="Supprimer" onClick={async () => { if (!confirm("Supprimer cette session et ses cartes ?")) return; await fetch(`/api/mo/${b.id}`, { method: "DELETE" }); const list = await listBoards(); if (b.id === board?.id) { if (list[0]) { router.replace(`/mo?b=${list[0].id}`); void loadBoard(list[0].id); } else void createBoard(); } }} className="p-1.5 mr-1 rounded-md text-gray-600 hover:text-rose-300 hover:bg-white/10"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                  {!boards.length && <div className="px-2.5 py-2 text-gray-500">Aucune session</div>}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 pointer-events-auto">
          <button type="button" onClick={() => { const rects = (board?.cards ?? []).map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h ?? CARD_SIZES[c.type].h })); if (rects.length) boardRef.current?.fit(rects, 90); }} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-white/10" title="Tout voir"><Maximize2 className="w-3.5 h-3.5" /> Tout voir</button>
          <button type="button" onClick={() => { setMuted((m) => { if (!m) voice.hush(); return !m; }); }} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur px-2.5 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-white/10" title={muted ? "Réactiver la voix de Mo" : "Couper la voix de Mo"}>{muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}</button>
        </div>
      </div>

      {/* Empty state */}
      {board && !board.cards.length && !run && !intro && (
        <div className="absolute inset-x-0 top-[28%] flex flex-col items-center pointer-events-none">
          <div className="text-lg text-gray-300">Qu&apos;est-ce qu&apos;on regarde ?</div>
          <div className="mt-3 flex flex-col gap-1.5 items-center pointer-events-auto">
            {SUGGESTIONS.map((s) => <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-white/10 bg-black/40 backdrop-blur px-3.5 py-1.5 text-xs text-gray-300 hover:text-white hover:border-violet-400/50">{s}</button>)}
          </div>
        </div>
      )}

      {/* Bottom: transcript + microphone */}
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center pb-6 pointer-events-none">
        {(lastSaid || status || error) && (
          <div className="max-w-2xl w-[min(92vw,42rem)] mb-4 space-y-1.5 text-center">
            {lastSaid?.you && !voice.listening && <div className="text-[13px] text-gray-400 line-clamp-2"><span className="text-gray-600">Toi ·</span> {lastSaid.you}</div>}
            {status ? (
              <div className="inline-flex items-center gap-2 rounded-full border border-violet-400/20 bg-violet-500/10 backdrop-blur px-3.5 py-1.5 text-[13px] text-violet-100 max-w-full">
                {run && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />}
                <span className="truncate">{status}{run ? "…" : ""}</span>
                {run && run.tools.length > 0 && <span className="text-[11px] text-violet-300/70 truncate hidden sm:inline">· {run.tools[run.tools.length - 1]}</span>}
              </div>
            ) : lastSaid?.mo ? (
              <div className="text-[15px] text-gray-100 leading-snug"><span className="text-violet-300">Mo ·</span> {lastSaid.mo}</div>
            ) : null}
            {error && <div className="text-[12px] text-rose-300">{error}</div>}
          </div>
        )}
        <div className="flex items-center gap-3 pointer-events-auto">
          <button type="button" onClick={() => setTyping((t) => !t)} className="w-10 h-10 rounded-full border border-white/10 bg-black/40 backdrop-blur text-gray-400 hover:text-white hover:bg-white/10 inline-flex items-center justify-center" title="Écrire à la place" aria-label="Écrire"><Keyboard className="w-4 h-4" /></button>
          {run ? (
            <button type="button" onClick={() => void stopJob(run.jobId).catch(() => undefined)} className="w-16 h-16 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 shadow-[0_0_60px_rgba(139,92,246,0.55)] inline-flex items-center justify-center text-white mo-orb-think" aria-label="Arrêter" title="Arrêter Mo"><Square className="w-5 h-5" /></button>
          ) : (
            <button
              type="button"
              onPointerDown={(e) => { e.preventDefault(); voice.begin(); }}
              onPointerUp={() => voice.end()}
              onPointerLeave={() => { if (voice.listening) voice.end(); }}
              onContextMenu={(e) => e.preventDefault()}
              className={`w-16 h-16 rounded-full inline-flex items-center justify-center text-white transition-transform ${voice.listening ? "bg-gradient-to-br from-fuchsia-500 to-violet-600 scale-110 shadow-[0_0_80px_rgba(217,70,239,0.7)]" : "bg-gradient-to-br from-violet-500 to-purple-700 shadow-[0_0_50px_rgba(139,92,246,0.45)] hover:scale-105"}`}
              style={voice.listening ? { transform: `scale(${1.1 + voice.level * 0.25})` } : undefined}
              aria-label="Maintenir pour parler"
              title="Maintenir pour parler (ou la barre espace)"
            >
              <Mic className="w-6 h-6" />
            </button>
          )}
          <div className="w-10 h-10" />
        </div>
        <div className="mt-2 text-[11px] text-gray-500 pointer-events-none">{voice.supported ? "Maintiens espace ou l'orbe pour parler" : "Reconnaissance vocale indisponible ici : utilise Chrome, ou écris à Mo"}</div>
        {typing && (
          <form className="mt-3 w-[min(92vw,36rem)] pointer-events-auto flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void send(input); setInput(""); }}>
            <input autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder="Écris à Mo…" className="flex-1 rounded-full border border-white/10 bg-black/50 backdrop-blur px-4 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-violet-400/60" />
            <button type="submit" disabled={!input.trim() || !!run} className="rounded-full bg-violet-600 hover:bg-violet-500 disabled:opacity-40 px-4 py-2 text-sm text-white">Envoyer</button>
          </form>
        )}
      </div>
    </div>
  );
}
