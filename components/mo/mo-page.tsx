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
import { ArrowLeft, ChevronDown, Keyboard, LayoutGrid, Loader2, Maximize2, Mic, Plus, Square, Trash2, Volume2, VolumeX } from "lucide-react";
import { Board, type BoardHandle } from "@/components/mo/board";
import { MoCardView } from "@/components/mo/card";
import { WaveCanvas, type WaveMood } from "@/components/mo/wave-canvas";
import { useVoice } from "@/components/mo/use-voice";
import { CARD_SIZES, type MoBoardData, type MoCard, type MoCardPatch } from "@/lib/mo/model";
import { GRID, SNAP_SCREEN_PX, arrangeCards, linkAnchors, linkPath, rectOf, resizeRect, snapMove, topZ, type Guide, type HandleDir, type Rect } from "@/lib/mo/geometry";

const sameGuides = (a: Guide[], b: Guide[]) => a.length === b.length && a.every((g, i) => g.axis === b[i].axis && g.pos === b[i].pos && g.from === b[i].from && g.to === b[i].to);
import { parseNavIntent, type IntentClient } from "@/lib/mo/intents";
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
    // The "done" event is released after the answer is stored; a short retry covers a slow write anyway.
    let j: Awaited<ReturnType<typeof loadBoard>> | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      j = await loadBoard(id).catch(() => null);
      const count = j?.board.messages.filter((m) => m.role === "assistant").length ?? 0;
      if (j && count > seenTurns.current) { seenTurns.current = count; break; }
      await new Promise((r) => window.setTimeout(r, 500 * (attempt + 1)));
    }
    if (!j) return;
    const last = [...j.board.messages].reverse().find((m) => m.role === "assistant");
    const ids = new Set(last?.cardIds ?? []);
    setFresh(ids);
    setLastSaid((s) => ({ you: s?.you ?? "", mo: last?.say ?? null }));
    if (last?.say && !muted) speakRef.current(last.say);
    const rects = j.board.cards.filter((c) => ids.has(c.id)).map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h ?? CARD_SIZES[c.type].h }));
    if (rects.length) window.setTimeout(() => boardRef.current?.fit(rects, 90, { kMin: 0.5, kMax: 1 }), 60);
    // Mo was asked to open a page: the board stays (reopened from the menu), the page comes up once the sentence is said.
    if (last?.open && !last.cardIds?.length) window.setTimeout(() => router.push(last.open!), 900);
  }, [loadBoard, muted, router]);

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
  // Clients of the viewer (names → ids) for the instant navigation path (lib/mo/intents.ts).
  const clientsRef = useRef<IntentClient[]>([]);
  useEffect(() => {
    fetch("/api/clients").then((r) => (r.ok ? r.json() : { clients: [] })).then((j: { clients: Array<{ id: string; name: string; dashboardId: string | null; aliasIds?: string[] }> }) => {
      clientsRef.current = (j.clients ?? []).map((c) => ({ id: c.id, name: c.name, dashboardId: c.dashboardId }));
    }).catch(() => undefined);
  }, []);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || !board || run) return;
    setError(null);
    setLastSaid({ you: t, mo: null });
    // "Ouvre le cockpit de Naturalia": understood here, executed at once, no model call.
    const nav = parseNavIntent(t, clientsRef.current);
    if (nav) {
      setLastSaid({ you: t, mo: nav.say });
      if (!muted) speakRef.current(nav.say);
      window.setTimeout(() => router.push(nav.path), 600);
      return;
    }
    setBoard((b) => (b ? { ...b, messages: [...b.messages, { role: "user", content: t, at: new Date().toISOString() }] } : b));
    try {
      const res = await fetch(`/api/mo/${board.id}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: t }) });
      const j = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (res.status === 409 && j.jobId) { follow(j.jobId, board.id); return; }
      if (!res.ok || !j.jobId) throw new Error(j.error ?? `Erreur ${res.status}`);
      window.dispatchEvent(new Event(AI_JOB_STARTED_EVENT));
      seenTurns.current = board.messages.filter((m) => m.role === "assistant").length;
      follow(j.jobId, board.id);
      void listBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mo n'a pas démarré");
    }
  }, [board, run, follow, listBoards, muted, router]);

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
  // Snapped drag / resize with alignment guides, z-order, selection, keyboard,
  // « Ranger »; geometry in lib/mo/geometry.ts, persisted by PATCH (debounced).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [guides, setGuides] = useState<Guide[]>([]);
  const [hoverLink, setHoverLink] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ cards: MoCard[]; timer: number } | null>(null);
  const boardStateRef = useRef<MoBoardData | null>(null);
  useEffect(() => { boardStateRef.current = board; }, [board]);
  /** Live position of the card being dragged / resized (world), before the state commit. */
  const live = useRef<{ id: string; x: number; y: number; w: number; h: number } | null>(null);
  const resizeStart = useRef<Rect | null>(null);
  /** Unsnapped position of the dragged card: the pointer's truth, so the card does not stick to a guide. */
  const rawPos = useRef({ x: 0, y: 0 });
  const commitRaf = useRef<number>(0);
  const getK = useCallback(() => kRef.current, []);

  const flush = useCallback(() => {
    const b = boardStateRef.current;
    if (!b || !pending.current.size) return;
    const cards = Array.from(pending.current.entries()).map(([id, p]) => ({ id, ...p }));
    pending.current = new Map();
    void fetch(`/api/mo/${b.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cards }) }).catch(() => undefined);
  }, []);
  const queue = useCallback((id: string, p: MoCardPatch) => {
    pending.current.set(id, { ...(pending.current.get(id) ?? {}), ...p });
    if (flushTimer.current) window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(flush, 500);
  }, [flush]);

  /** Applies the live rect of the dragged card to the state, at most once a frame. */
  const commitLive = useCallback(() => {
    if (commitRaf.current) return;
    commitRaf.current = requestAnimationFrame(() => {
      commitRaf.current = 0;
      const l = live.current; if (!l) return;
      setBoard((b) => (b ? { ...b, cards: b.cards.map((c): MoCard => (c.id === l.id ? { ...c, x: l.x, y: l.y, w: l.w, h: l.h } as MoCard : c)) } : b));
    });
  }, []);

  const onMove = useCallback((id: string, dx: number, dy: number, alt: boolean) => {
    const b = boardStateRef.current;
    const c = b?.cards.find((x) => x.id === id);
    if (!b || !c) return { x: 0, y: 0 };
    const cur = live.current?.id === id ? live.current : { id, x: c.x, y: c.y, w: c.w, h: c.h ?? CARD_SIZES[c.type].h };
    // Raw target from the accumulated deltas (kept apart from the snapped one so the card does not "stick").
    const raw = { x: (live.current?.id === id ? rawPos.current.x : c.x) + dx, y: (live.current?.id === id ? rawPos.current.y : c.y) + dy };
    rawPos.current = raw;
    const others = b.cards.filter((x) => x.id !== id).map(rectOf);
    const snapped = snapMove({ x: raw.x, y: raw.y, w: cur.w, h: cur.h }, others, SNAP_SCREEN_PX / (kRef.current || 1), alt ? null : GRID);
    live.current = { ...cur, x: snapped.x, y: snapped.y };
    setGuides((g) => (sameGuides(g, snapped.guides) ? g : snapped.guides));
    commitLive();
    return { x: snapped.x, y: snapped.y };
  }, [commitLive]);
  const onMoveEnd = useCallback((id: string, moved: boolean) => {
    const l = live.current;
    live.current = null;
    setGuides([]);
    if (!moved || !l || l.id !== id) return;
    cancelAnimationFrame(commitRaf.current); commitRaf.current = 0;
    setBoard((b) => (b ? { ...b, cards: b.cards.map((c): MoCard => (c.id === id ? { ...c, x: l.x, y: l.y } as MoCard : c)) } : b));
    queue(id, { x: l.x, y: l.y });
  }, [queue]);

  const onResizeStart = useCallback((id: string) => {
    const c = boardStateRef.current?.cards.find((x) => x.id === id);
    if (c) { resizeStart.current = { x: c.x, y: c.y, w: c.w, h: c.h ?? CARD_SIZES[c.type].h }; live.current = { id, ...resizeStart.current }; }
  }, []);
  const onResize = useCallback((id: string, dir: HandleDir, dx: number, dy: number, alt: boolean) => {
    const c = boardStateRef.current?.cards.find((x) => x.id === id);
    const start = resizeStart.current;
    if (!c || !start) return { x: c?.x ?? 0, y: c?.y ?? 0, w: c?.w ?? 300, h: c?.h ?? 200 };
    const r = resizeRect(start, dir, dx, dy, c.type, alt ? null : GRID);
    live.current = { id, ...r };
    commitLive();
    return r;
  }, [commitLive]);
  const onResizeEnd = useCallback((id: string) => {
    const l = live.current;
    live.current = null; resizeStart.current = null;
    if (!l || l.id !== id) return;
    cancelAnimationFrame(commitRaf.current); commitRaf.current = 0;
    setBoard((b) => (b ? { ...b, cards: b.cards.map((c): MoCard => (c.id === id ? { ...c, x: l.x, y: l.y, w: l.w, h: l.h } as MoCard : c)) } : b));
    queue(id, { x: l.x, y: l.y, w: l.w, h: l.h });
  }, [queue]);

  const onFront = useCallback((id: string) => {
    const b = boardStateRef.current; if (!b) return;
    const top = topZ(b.cards);
    const c = b.cards.find((x) => x.id === id);
    if (!c || (c.z ?? 0) === top && b.cards.filter((x) => (x.z ?? 0) === top).length === 1) return;
    const z = top + 1;
    setBoard((bb) => (bb ? { ...bb, cards: bb.cards.map((x): MoCard => (x.id === id ? { ...x, z } as MoCard : x)) } : bb));
    queue(id, { z });
  }, [queue]);
  const onSelect = useCallback((id: string, additive: boolean) => {
    setSelected((s) => { if (additive) { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; } return s.size === 1 && s.has(id) ? s : new Set([id]); });
  }, []);
  const clearSelection = useCallback(() => setSelected((s) => (s.size ? new Set() : s)), []);
  const onToggle = useCallback((id: string) => {
    const c = boardStateRef.current?.cards.find((x) => x.id === id);
    if (!c) return;
    queue(id, { minimized: !c.minimized });
    setBoard((b) => (b ? { ...b, cards: b.cards.map((x): MoCard => (x.id === id ? { ...x, minimized: !x.minimized } as MoCard : x)) } : b));
  }, [queue]);
  /** Removes cards with a 5 s « Annuler »; the PATCH leaves when the toast expires. */
  const removeCards = useCallback((ids: string[]) => {
    const b = boardStateRef.current; if (!b || !ids.length) return;
    const removed = b.cards.filter((c) => ids.includes(c.id));
    if (!removed.length) return;
    setBoard((bb) => (bb ? { ...bb, cards: bb.cards.filter((c) => !ids.includes(c.id)) } : bb));
    setSelected((s) => { const n = new Set(s); ids.forEach((i) => n.delete(i)); return n; });
    setUndo((u) => {
      if (u) { window.clearTimeout(u.timer); u.cards.forEach((c) => queue(c.id, { removed: true })); }
      const timer = window.setTimeout(() => { removed.forEach((c) => queue(c.id, { removed: true })); setUndo(null); }, 5000);
      return { cards: removed, timer };
    });
  }, [queue]);
  const undoRemove = useCallback(() => {
    setUndo((u) => {
      if (!u) return null;
      window.clearTimeout(u.timer);
      setBoard((b) => (b ? { ...b, cards: [...b.cards, ...u.cards.filter((c) => !b.cards.some((x) => x.id === c.id))] } : b));
      return null;
    });
  }, []);
  const onClose = useCallback((id: string) => removeCards([id]), [removeCards]);
  const onFocusRef = useCallback((id: string) => {
    const c = boardStateRef.current?.cards.find((x) => x.id === id);
    if (c) { boardRef.current?.focus(rectOf(c)); onFront(id); }
  }, [onFront]);
  const onHoverRef = useCallback((id: string | null) => setHoverLink(id), []);

  /** « Ranger » : masonry by turn, every card moved and saved, then fit. */
  const arrange = useCallback(() => {
    const b = boardStateRef.current; if (!b || !b.cards.length) return;
    const pos = arrangeCards(b.cards);
    const cards = b.cards.map((c): MoCard => { const p = pos.get(c.id); return p && (p.x !== c.x || p.y !== c.y) ? ({ ...c, x: p.x, y: p.y } as MoCard) : c; });
    cards.forEach((c, i) => { if (c !== b.cards[i]) queue(c.id, { x: c.x, y: c.y }); });
    setBoard({ ...b, cards });
    window.setTimeout(() => boardRef.current?.fit(cards.map(rectOf), 90), 30);
  }, [queue]);
  const fitAll = useCallback(() => { const b = boardStateRef.current; if (b?.cards.length) boardRef.current?.fit(b.cards.map(rectOf), 90); }, []);
  const fitFresh = useCallback(() => { const b = boardStateRef.current; const rects = (b?.cards ?? []).filter((c) => fresh.has(c.id)).map(rectOf); if (rects.length) boardRef.current?.fit(rects, 90, { kMin: 0.5, kMax: 1 }); else fitAll(); }, [fresh, fitAll]);

  // Keyboard: Esc deselect · Delete/Backspace remove · arrows nudge (Shift = 20) · ⌘/Ctrl+0 fit all · F fit new cards · R ranger · ⌘/Ctrl +/− zoom.
  useEffect(() => {
    const isTyping = () => { const el = document.activeElement as HTMLElement | null; return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable); };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping()) return;
      const meta = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") { clearSelection(); return; }
      if (meta && e.key === "0") { e.preventDefault(); fitAll(); return; }
      if (meta && (e.key === "=" || e.key === "+")) { e.preventDefault(); boardRef.current?.zoomBy(1.25); return; }
      if (meta && e.key === "-") { e.preventDefault(); boardRef.current?.zoomBy(1 / 1.25); return; }
      if (meta) return;
      if (e.key === "f" || e.key === "F") { fitFresh(); return; }
      if (e.key === "r" || e.key === "R") { arrange(); return; }
      if (!selected.size) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeCards([...selected]); return; }
      const step = e.shiftKey ? 20 : 1;
      const d = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : null;
      if (!d) return;
      e.preventDefault();
      setBoard((b) => (b ? { ...b, cards: b.cards.map((c): MoCard => (selected.has(c.id) ? { ...c, x: c.x + d[0], y: c.y + d[1] } as MoCard : c)) } : b));
      for (const id of selected) { const c = boardStateRef.current?.cards.find((x) => x.id === id); if (c) queue(id, { x: c.x + d[0], y: c.y + d[1] }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, clearSelection, fitAll, fitFresh, arrange, removeCards, queue]);
  useEffect(() => () => { cancelAnimationFrame(commitRaf.current); if (undo) window.clearTimeout(undo.timer); }, [undo]);

  const sortedCards = useMemo(() => [...(board?.cards ?? [])].sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || a.turn - b.turn), [board]);
  const freshOrder = useMemo(() => { const m = new Map<string, number>(); let i = 0; for (const c of board?.cards ?? []) if (fresh.has(c.id)) m.set(c.id, i++); return m; }, [board, fresh]);
  const titles = useMemo(() => new Map((board?.cards ?? []).map((c) => [c.id, c.title])), [board]);
  const links = useMemo(() => (board?.cards ?? []).flatMap((c) => {
    const r = c.ref ? board?.cards.find((x) => x.id === c.ref) : null;
    if (!r) return [];
    const anchors = linkAnchors(rectOf(r), rectOf(c));
    return [{ id: c.id, d: linkPath(anchors), mid: { x: (anchors.a.x + anchors.b.x) / 2, y: (anchors.a.y + anchors.b.y) / 2 } }];
  }), [board]);

  const mood: WaveMood = intro ? "intro" : voice.listening ? "listening" : run ? "thinking" : voice.speaking ? "speaking" : "idle";
  const status = run ? activityLabel(run.activity) : voice.listening ? (voice.interim || "Je t'écoute…") : voice.speaking ? "Mo parle" : null;

  return (
    <div className="fixed inset-0 z-[70] bg-[#07050f] text-gray-100 overflow-hidden">
      <WaveCanvas mood={mood} level={voice.level} levelRef={voice.levelRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(7,5,15,0)_0%,rgba(7,5,15,0.55)_70%,rgba(7,5,15,0.85)_100%)] pointer-events-none" />

      {/* Intro wordmark */}
      <div className={`absolute inset-0 flex flex-col items-center justify-center pointer-events-none transition-opacity duration-700 ${intro ? "opacity-100" : "opacity-0"}`}>
        <div className="text-[96px] font-semibold tracking-tight bg-gradient-to-r from-violet-200 via-fuchsia-200 to-violet-300 bg-clip-text text-transparent mo-intro-title">Mo</div>
        <div className="text-sm text-violet-200/70 mo-intro-sub">Maintiens <kbd className="px-1.5 py-0.5 rounded border border-white/15 bg-white/5 text-[11px]">espace</kbd> et parle-moi</div>
      </div>

      {/* Board */}
      <Board ref={boardRef} className="absolute inset-0" onViewChange={(v) => { kRef.current = v.k; }} onBackgroundClick={clearSelection}
        underlay={links.length ? (
          <svg className="absolute left-0 top-0 overflow-visible pointer-events-none" width={1} height={1}>
            <defs>
              <marker id="mo-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(167,139,250,0.7)" /></marker>
              <marker id="mo-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#f0abfc" /></marker>
            </defs>
            {links.map((l) => {
              const hot = hoverLink === l.id;
              return (
                <g key={l.id}>
                  <path d={l.d} stroke={hot ? "#f0abfc" : "rgba(167,139,250,0.45)"} strokeWidth={hot ? 3 : 2} strokeDasharray={hot ? undefined : "6 6"} fill="none" markerEnd={`url(#${hot ? "mo-arrow-hot" : "mo-arrow"})`} />
                  <circle cx={l.mid.x} cy={l.mid.y} r={11} fill="#100c1f" stroke={hot ? "#f0abfc" : "rgba(167,139,250,0.6)"} strokeWidth={1.5} />
                  <text x={l.mid.x} y={l.mid.y + 4} textAnchor="middle" fontSize={12} fill={hot ? "#f0abfc" : "#c4b5fd"}>Δ</text>
                </g>
              );
            })}
          </svg>
        ) : null}
        overlay={guides.length ? (
          <svg className="absolute left-0 top-0 overflow-visible pointer-events-none" width={1} height={1}>
            {guides.map((g, i) => g.axis === "x"
              ? <line key={i} x1={g.pos} x2={g.pos} y1={g.from} y2={g.to} stroke="rgba(167,139,250,0.6)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              : <line key={i} y1={g.pos} y2={g.pos} x1={g.from} x2={g.to} stroke="rgba(167,139,250,0.6)" strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
          </svg>
        ) : null}
      >
        {sortedCards.map((c) => (
          <MoCardView key={c.id} card={c} fresh={fresh.has(c.id)} delayMs={(freshOrder.get(c.id) ?? 0) * 60} selected={selected.has(c.id)} refTitle={c.ref ? titles.get(c.ref) ?? null : null} getK={getK}
            onMove={onMove} onMoveEnd={onMoveEnd} onResizeStart={onResizeStart} onResize={onResize} onResizeEnd={onResizeEnd}
            onFront={onFront} onSelect={onSelect} onToggle={onToggle} onClose={onClose} onFocusRef={onFocusRef} onHoverRef={onHoverRef} />
        ))}
      </Board>

      {/* Board toolbar: ranger · fit · shortcuts — and the undo toast after a removal */}
      <div className="absolute bottom-5 left-5 flex items-center gap-1.5 pointer-events-auto">
        <button type="button" onClick={arrange} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-white/10" title="Ranger les cartes (R)"><LayoutGrid className="w-3.5 h-3.5" /> Ranger</button>
        <span className="hidden md:inline text-[10px] text-gray-600 ml-1">⌘0 tout voir · F nouvelles cartes · R ranger · Suppr retirer · Alt = sans aimant</span>
      </div>
      {undo && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 inline-flex items-center gap-3 rounded-full border border-white/10 bg-[#0d0a1a]/95 backdrop-blur px-4 py-2 text-xs text-gray-200 shadow-xl pointer-events-auto">
          {undo.cards.length > 1 ? `${undo.cards.length} cartes retirées` : "Carte retirée"}
          <button type="button" onClick={undoRemove} className="font-semibold text-violet-300 hover:text-white">Annuler</button>
        </div>
      )}

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
