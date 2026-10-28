"use client";

/**
 * /mo — Mo's screen. Full-screen board over the app chrome: the violet wave
 * behind, the cards in front, the composer at the bottom (text + microphone,
 * always there). Hold SPACE (or the orb) to talk; release to send. The moment
 * a message leaves, a ghost card marks where the answer will land; Mo answers
 * out loud and its cards replace the ghost. A session = a board, reopened
 * from the list. The « Mo » intro plays once (localStorage).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronDown, LayoutGrid, Maximize2, Plus, Trash2, Volume2, VolumeX } from "lucide-react";
import { Board, type BoardHandle } from "@/components/mo/board";
import { MoCardView, MoGhostCard, MoUploadCard, type CardBusy, type Ghost, type PublishEdits, type Upload } from "@/components/mo/card";
import type { CreativeAction } from "@/components/mo/card-actions";
import { Composer, type ComposerAsk, type ComposerHandle } from "@/components/mo/composer";
import { warmMoBoard } from "@/components/mo/warm";
import { WaveCanvas, type WaveMood } from "@/components/mo/wave-canvas";
import { useVoice } from "@/components/mo/use-voice";
import { CARD_SIZES, COL_GAP, layoutNewCards, type MoBoardData, type MoCard, type MoCardPatch, type MoCardSpec } from "@/lib/mo/model";
import { MAX_UPLOAD_BYTES, fileKindOf } from "@/lib/mo/act";
import { GRID, SNAP_SCREEN_PX, arrangeCards, linkAnchors, linkPath, rectOf, resizeRect, snapMove, topZ, type Guide, type HandleDir, type Rect } from "@/lib/mo/geometry";

const sameGuides = (a: Guide[], b: Guide[]) => a.length === b.length && a.every((g, i) => g.axis === b[i].axis && g.pos === b[i].pos && g.from === b[i].from && g.to === b[i].to);
import { PERIOD_OPTIONS, completeQuickAsk, ghostTitle, orderClientCandidates, parseFollowUpIntent, parseNavIntent, parseQuickIntent, type IntentClient, type QuickAsk, type QuickResult } from "@/lib/mo/intents";
import { actStatusLabel, moStatusLabel } from "@/lib/mo/status";
import { AI_JOB_STARTED_EVENT, followJob, stopJob, type JobEvent } from "@/lib/ai-job-client";
import { INITIAL_ACTIVITY, reduceActivity, type ActivityState } from "@/lib/ai-activity";

interface BoardSummary { id: string; title: string; updatedAt: string; cards: number }
interface Run { jobId: string; startedAt: number; activity: ActivityState }
/** An action of the board running (POST /api/mo/[id]/act): which card, which button, since when. */
interface Acting { cardId: string | null; key: CardBusy; action: string; startedAt: number }
interface ActResponse { say?: string; cardIds?: string[]; card?: MoCard; open?: string; needs?: { adset: Array<{ adsetId: string; adset: string; campaign: string; spend_30d: number; status: string | null }> }; error?: string }
const MAX_DROP_FILES = 10;
const readDataUrl = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f); });

/** The « Mo » wordmark plays on the first visit only. */
const INTRO_KEY = "mo:intro-seen";
/** Chips offered when Mo asks for the client (the rest behind « autre… »). */
const MAX_CHIPS = 6;

/** Said when the answer takes more than a moment to start (one of them, at random). */
const ACKS = ["Je regarde.", "Un instant.", "Je m'en occupe."];
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
  const [intro, setIntro] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  /** The placeholder card drawn where the answer will land, from the send to the first real card. */
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const ghostRef = useRef<Ghost | null>(null);
  useEffect(() => { ghostRef.current = ghost; }, [ghost]);
  /** Mo is missing one thing (the client, the period): chips in the composer. */
  const [ask, setAsk] = useState<QuickAsk | null>(null);
  /** Chips of an action in progress (which ad set, which visual, which client for a dropped file). */
  const [choice, setChoice] = useState<ComposerAsk | null>(null);
  /** The action of the board running now (verdict, publication, file…), shown in the composer's state line. */
  const [acting, setActing] = useState<Acting | null>(null);
  /** Files dropped on the board, being sent (their local preview sits where the card will land). */
  const [uploads, setUploads] = useState<Upload[]>([]);
  /** The visual the pointer or the focus is on (« garde celle-là »). */
  const hotItem = useRef<{ cardId: string; index: number } | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const [muted, setMuted] = useState(false);
  const follower = useRef<AbortController | null>(null);
  const seenTurns = useRef<number>(-1);
  const pending = useRef<Map<string, MoCardPatch>>(new Map());
  const flushTimer = useRef<number | null>(null);
  /** Mo's voice (set once the voice hook is up; it is used by the reply handler above it). */
  const speakRef = useRef<(text: string) => void>(() => undefined);
  /** The sentence spoken as soon as it appeared in the stream (finishTurn then does not say it twice). */
  const earlySaid = useRef<string | null>(null);
  /** Streamed answer of the running turn, to catch « say » before the JSON is complete. */
  const streamText = useRef("");
  /** Ids of the cards the person already has (new ones found by the live refresh get the spotlight). */
  const knownIds = useRef<Set<string>>(new Set());
  const ackTimer = useRef<number | null>(null);
  const boardStateRef = useRef<MoBoardData | null>(null);
  useEffect(() => { boardStateRef.current = board; }, [board]);

  // ── Loading ───────────────────────────────────────────────────────────
  const loadBoard = useCallback(async (id: string) => {
    const r = await fetch(`/api/mo/${id}`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status === 404 ? "Session introuvable" : `Erreur ${r.status}`);
    const j = (await r.json()) as { board: MoBoardData; jobId: string | null };
    setBoard(j.board);
    knownIds.current = new Set(j.board.cards.map((c) => c.id));
    warmMoBoard(j.board.id);
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
    warmMoBoard(j.board.id);
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
    knownIds.current = new Set(j.board.cards.map((c) => c.id));
    // The answer is in: the ghost has done its job (a card replaced it, or Mo only spoke).
    setGhost((g) => (g && g.state === "pending" ? null : g));
    setLastSaid((s) => ({ you: s?.you ?? "", mo: last?.say ?? null }));
    if (last?.say && !muted && earlySaid.current !== last.say) speakRef.current(last.say);
    earlySaid.current = null;
    const rects = j.board.cards.filter((c) => ids.has(c.id)).map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h ?? CARD_SIZES[c.type].h }));
    if (rects.length) window.setTimeout(() => boardRef.current?.fit(rects, 90, { kMin: 0.5, kMax: 1 }), 60);
    // Mo was asked to open a page: the board stays (reopened from the menu), the page comes up once the sentence is said.
    if (last?.open && !last.cardIds?.length) window.setTimeout(() => router.push(last.open!), 900);
  }, [loadBoard, muted, router]);

  const follow = useCallback((jobId: string, boardId: string) => {
    follower.current?.abort();
    const ctl = new AbortController();
    follower.current = ctl;
    setRun({ jobId, startedAt: Date.now(), activity: INITIAL_ACTIVITY });
    streamText.current = "";
    earlySaid.current = null;
    // A short word if Mo has not started answering after a moment (the voice assistants people know do this).
    if (ackTimer.current) window.clearTimeout(ackTimer.current);
    ackTimer.current = window.setTimeout(() => { ackTimer.current = null; if (!muted && !streamText.current) speakRef.current(ACKS[Math.floor(Math.random() * ACKS.length)]); }, 2500);
    // The cards a tool posts land on the board while the turn still runs: look every 2 s, light the new ones up.
    const live = window.setInterval(() => {
      if (ctl.signal.aborted) { window.clearInterval(live); return; }
      fetch(`/api/mo/${boardId}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j: { board: MoBoardData } | null) => {
        if (!j || ctl.signal.aborted) return;
        const added = j.board.cards.filter((c) => !knownIds.current.has(c.id));
        if (!added.length) return;
        for (const c of added) knownIds.current.add(c.id);
        setBoard(j.board);
        setGhost(null);
        setFresh((f) => new Set([...f, ...added.map((c) => c.id)]));
        const rects = added.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h ?? CARD_SIZES[c.type].h }));
        window.setTimeout(() => boardRef.current?.fit(rects, 90, { kMin: 0.5, kMax: 1 }), 60);
      }).catch(() => undefined);
    }, 2000);
    const onEvent = (e: JobEvent) => {
      if (e.type === "job") return;
      // « say » is the first field of the answer: spoken the moment it is complete, cards or not.
      if ((e.type === "delta" || e.type === "content") && typeof e.text === "string") {
        streamText.current = e.type === "content" && !streamText.current ? e.text : streamText.current + (e.type === "delta" ? e.text : "");
        if (!earlySaid.current) {
          const m = streamText.current.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (m) {
            let sentence = "";
            try { sentence = String(JSON.parse(`"${m[1]}"`)); } catch { sentence = m[1]; }
            if (sentence.trim()) {
              earlySaid.current = sentence;
              if (ackTimer.current) { window.clearTimeout(ackTimer.current); ackTimer.current = null; }
              setLastSaid((s) => ({ you: s?.you ?? "", mo: sentence }));
              if (!muted) speakRef.current(sentence);
            }
          }
        }
      }
      setRun((r) => (r && r.jobId === jobId ? { ...r, activity: reduceActivity(r.activity, e) } : r));
      if (e.type === "error" && e.message) { setError(e.message); setGhost((g) => (g && g.state === "pending" ? { ...g, state: "error", message: e.message } : g)); }
    };
    void followJob(jobId, onEvent, ctl.signal).then(async (outcome) => {
      window.clearInterval(live);
      if (ackTimer.current) { window.clearTimeout(ackTimer.current); ackTimer.current = null; }
      if (outcome === "aborted") return;
      follower.current = null;
      setRun(null);
      if (outcome === "failed" || outcome === "stopped") setGhost((g) => (g && g.state === "pending" ? { ...g, state: "error", message: outcome === "stopped" ? "Arrêté." : "La réponse a échoué." } : g));
      await finishTurn(boardId);
    }).catch((e) => { window.clearInterval(live); follower.current = null; setRun(null); const msg = e instanceof Error ? e.message : "Suivi interrompu"; setError(msg); setGhost((g) => (g && g.state === "pending" ? { ...g, state: "error", message: msg } : g)); });
  }, [finishTurn, muted]);

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
    return () => { cancelled = true; follower.current?.abort(); follower.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The wordmark plays once; afterwards the board is usable the moment it loads.
  useEffect(() => {
    let seen = true;
    try { seen = !!localStorage.getItem(INTRO_KEY); if (!seen) localStorage.setItem(INTRO_KEY, "1"); } catch { seen = true; }
    if (seen) return;
    queueMicrotask(() => setIntro(true));
    const t = window.setTimeout(() => setIntro(false), 3400);
    return () => window.clearTimeout(t);
  }, []);

  // ── Sending ───────────────────────────────────────────────────────────
  // Clients of the viewer (names → ids) for the instant navigation path (lib/mo/intents.ts).
  const clientsRef = useRef<IntentClient[]>([]);
  useEffect(() => {
    fetch("/api/clients").then((r) => (r.ok ? r.json() : { clients: [] })).then((j: { clients: Array<{ id: string; name: string; dashboardId: string | null; aliasIds?: string[] }> }) => {
      clientsRef.current = (j.clients ?? []).map((c) => ({ id: c.id, name: c.name, dashboardId: c.dashboardId }));
    }).catch(() => undefined);
  }, []);

  /** Draws the ghost where the next card will land (same rule as the server: a new row under everything), and brings it into view. */
  const placeGhost = useCallback((text: string, quick: QuickResult | null) => {
    const b = boardStateRef.current;
    if (!b) return;
    const type: MoCard["type"] = quick?.kind === "creatives" ? "creatives" : "kpis";
    const title = ghostTitle(text, quick);
    const [placed] = layoutNewCards(b.cards, { cards: [{ type, title } as unknown as MoCardSpec] }, b.messages.filter((m) => m.role === "assistant").length, new Date().toISOString());
    if (!placed) return;
    const g: Ghost = { id: placed.id, text, title, x: placed.x, y: placed.y, w: placed.w, h: placed.h ?? CARD_SIZES[type].h, z: placed.z ?? 0, state: "pending", startedAt: Date.now() };
    setGhost(g);
    window.setTimeout(() => boardRef.current?.fit([{ x: g.x, y: g.y, w: g.w, h: g.h }], 90, { kMin: 0.5, kMax: 1 }), 30);
  }, []);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || !board || run || acting) return;
    setGhost((g) => (g && g.state === "error" ? null : g));
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
    // « Mets les chiffres dessous », « garde celle-là » over the creatives card at hand: an action, no model.
    const followUp = parseFollowUpIntent(t);
    if (followUp) {
      const target = targetCreativesCard();
      if (target) {
        setLastSaid({ you: t, mo: followUp.say });
        if (followUp.kind === "creative_metrics") { void act({ action: "creative_metrics", cardId: target.id, ...(followUp.period ? { period: followUp.period } : {}), said: t }, { cardId: target.id, key: null }); return; }
        const verdict = followUp.verdict;
        const runVerdict = (i: number) => act({ action: "verdict", cardId: target.id, item: i, verdict, said: t }, { cardId: target.id, key: `item:${i}:${verdict === "keep" ? "keep" : "cut"}` });
        if (followUp.target.which === "all") { (async () => { for (let i = 0; i < target.items.length; i++) await runVerdict(i); })(); return; }
        const idx = followUp.target.which === "index" ? followUp.target.index : hotItem.current?.cardId === target.id ? hotItem.current.index : target.items.length === 1 ? 0 : null;
        if (idx !== null && target.items[idx]) { void runVerdict(idx); return; }
        setChoice({ question: verdict === "keep" ? "Laquelle je garde ?" : "Laquelle je coupe ?", chips: target.items.slice(0, 8).map((it, i) => ({ label: `${i + 1}. ${it.name.length > 28 ? it.name.slice(0, 27) + "…" : it.name}`, onPick: () => { setChoice(null); void runVerdict(i); } })) });
        if (!muted) speakRef.current(verdict === "keep" ? "Laquelle je garde ?" : "Laquelle je coupe ?");
        return;
      }
    }
    const quick: QuickResult | null = parseQuickIntent(t, clientsRef.current);
    // « Créas cette semaine » without a client: Mo asks with chips, nothing leaves the browser.
    if (quick?.kind === "ask") {
      setAsk(quick);
      setLastSaid({ you: t, mo: quick.question });
      if (!muted) speakRef.current(quick.question);
      return;
    }
    setAsk(null);
    setBoard((b) => (b ? { ...b, messages: [...b.messages, { role: "user", content: t, at: new Date().toISOString() }] } : b));
    placeGhost(t, quick);
    // « Les créas de Cours Legendre cette semaine », « le CPA de Naturalia ce mois-ci » : the app runs the tool itself, no model, 3 seconds.
    if (quick) {
      setRun({ jobId: "quick", startedAt: Date.now(), activity: INITIAL_ACTIVITY });
      try {
        const res = await fetch(`/api/mo/${board.id}/quick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: t }) });
        if (res.status === 200) {
          const j = (await res.json()) as { say: string; cardIds: string[] };
          setRun(null);
          setLastSaid({ you: t, mo: j.say });
          if (!muted) speakRef.current(j.say);
          const loaded = await loadBoard(board.id);
          seenTurns.current = loaded.board.messages.filter((m) => m.role === "assistant").length;
          const ids = new Set(j.cardIds);
          setFresh(ids);
          // No card came back: the ghost says why, with a retry.
          setGhost((g) => (g && g.state === "pending" ? (ids.size ? null : { ...g, state: "error", message: j.say }) : g));
          const rects = loaded.board.cards.filter((c) => ids.has(c.id)).map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h ?? CARD_SIZES[c.type].h }));
          if (rects.length) window.setTimeout(() => boardRef.current?.fit(rects, 90, { kMin: 0.5, kMax: 1 }), 60);
          void listBoards();
          return;
        }
        if (res.status !== 204) { const j = (await res.json().catch(() => ({}))) as { error?: string }; if (res.status === 409) { setRun(null); setError(j.error ?? "Mo répond déjà."); setGhost(null); return; } }
      } catch { /* the normal way below */ }
      setRun(null);
    }
    try {
      // The state line says « je réfléchis » from the first instant: the turn is being posted (follow() takes over once the job exists).
      setRun({ jobId: "pending", startedAt: Date.now(), activity: INITIAL_ACTIVITY });
      const res = await fetch(`/api/mo/${board.id}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: t }) });
      const j = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (res.status === 409 && j.jobId) { follow(j.jobId, board.id); return; }
      if (!res.ok || !j.jobId) { setRun(null); throw new Error(j.error ?? `Erreur ${res.status}`); }
      window.dispatchEvent(new Event(AI_JOB_STARTED_EVENT));
      seenTurns.current = board.messages.filter((m) => m.role === "assistant").length;
      follow(j.jobId, board.id);
      void listBoards();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Mo n'a pas répondu";
      setError(msg);
      setGhost((g) => (g && g.state === "pending" ? { ...g, state: "error", message: msg } : g));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- act and targetCreativesCard are defined below (stable callbacks)
  }, [board, run, acting, follow, listBoards, loadBoard, muted, router, placeGhost]);

  const voice = useVoice(send);
  useEffect(() => { speakRef.current = voice.speak; }, [voice.speak]);
  // A dictation starts, the composer takes the focus: Mo's process is warmed on the relay meanwhile (fire and forget).
  const boardIdRef = useRef<string | null>(null);
  useEffect(() => { boardIdRef.current = board?.id ?? null; }, [board]);
  const warm = useCallback(() => warmMoBoard(boardIdRef.current), []);

  // SPACE held = talk (outside text fields); Escape = quiet.
  useEffect(() => {
    const isTyping = () => { const el = document.activeElement as HTMLElement | null; return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable); };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isTyping() && !run) { e.preventDefault(); warm(); voice.begin(); }
      if (e.key === "Escape") { voice.hush(); voice.cancel(); setSessionsOpen(false); setChoice(null); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space" && !isTyping()) { e.preventDefault(); voice.end(); } };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [voice, run, warm]);

  // ── Cards geometry ────────────────────────────────────────────────────
  // Snapped drag / resize with alignment guides, z-order, selection, keyboard,
  // « Ranger »; geometry in lib/mo/geometry.ts, persisted by PATCH (debounced).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [guides, setGuides] = useState<Guide[]>([]);
  const [hoverLink, setHoverLink] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ cards: MoCard[]; timer: number } | null>(null);
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

  // ── Actions on the cards (no model): verdicts, figures, editors, Drive, publication, files ──
  const selectedRef = useRef(selected); useEffect(() => { selectedRef.current = selected; }, [selected]);
  const freshRef = useRef(fresh); useEffect(() => { freshRef.current = fresh; }, [fresh]);
  /** The creatives card a follow-up is about: the one selected, else the freshest, else the latest on the board. */
  const targetCreativesCard = useCallback((): Extract<MoCard, { type: "creatives" }> | null => {
    const b = boardStateRef.current; if (!b) return null;
    const creatives = b.cards.filter((c): c is Extract<MoCard, { type: "creatives" }> => c.type === "creatives");
    const sel = creatives.filter((c) => selectedRef.current.has(c.id));
    if (sel.length === 1) return sel[0];
    const latest = (list: typeof creatives) => [...list].sort((a, c) => (c.at > a.at ? 1 : c.at < a.at ? -1 : 0))[0] ?? null;
    return latest(creatives.filter((c) => freshRef.current.has(c.id))) ?? latest(creatives);
  }, []);

  /** Runs one action on the board; the answer's card replaces (or joins) the board's, Mo says its sentence. Returns the response (null on failure). */
  const act = useCallback(async (body: Record<string, unknown>, opts: { cardId: string | null; key: CardBusy }): Promise<ActResponse | null> => {
    const b = boardStateRef.current; if (!b) return null;
    setError(null); setChoice(null);
    setActing({ cardId: opts.cardId, key: opts.key, action: String(body.action), startedAt: Date.now() });
    try {
      const res = await fetch(`/api/mo/${b.id}/act`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as ActResponse;
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      if (j.card) {
        const card = j.card;
        setBoard((bb) => (bb ? { ...bb, cards: bb.cards.some((c) => c.id === card.id) ? bb.cards.map((c) => (c.id === card.id ? card : c)) : [...bb.cards, card] } : bb));
        if (!knownIds.current.has(card.id)) { knownIds.current.add(card.id); setFresh(new Set([card.id])); window.setTimeout(() => boardRef.current?.fit([{ x: card.x, y: card.y, w: card.w, h: card.h ?? CARD_SIZES[card.type].h }], 90, { kMin: 0.5, kMax: 1 }), 60); }
      } else if (j.cardIds?.length) {
        // Cards rewritten or posted by a tool (figures under the visuals, a competitor card): reloaded.
        const loaded = await loadBoard(b.id).catch(() => null);
        if (loaded) { const ids = new Set(j.cardIds); setFresh(ids); const rects = loaded.board.cards.filter((c) => ids.has(c.id)).map(rectOf); if (rects.length && !b.cards.some((c) => ids.has(c.id))) window.setTimeout(() => boardRef.current?.fit(rects, 90, { kMin: 0.5, kMax: 1 }), 60); }
      }
      if (j.needs?.adset) {
        const base = { ...body };
        setChoice({ question: "Dans quel ensemble ?", chips: j.needs.adset.map((t) => ({ label: `${t.adset}${t.spend_30d ? ` · ${t.spend_30d} € / 30 j` : ""}`, onPick: () => { setChoice(null); void act({ ...base, adsetId: t.adsetId }, opts); } })) });
      }
      if (j.say) { setLastSaid((s) => ({ you: s?.you ?? "", mo: j.say! })); if (!muted) speakRef.current(j.say); }
      if (j.open) window.setTimeout(() => router.push(j.open!), 500);
      return j;
    } catch (e) {
      setError(e instanceof Error ? e.message : "L'action a échoué.");
      return null;
    } finally {
      setActing(null);
    }
  }, [loadBoard, muted, router]);

  const onItemAction = useCallback((cardId: string, index: number, action: CreativeAction) => {
    const body: Record<string, unknown> = action === "keep" || action === "cut" ? { action: "verdict", verdict: action } : action === "metrics" ? { action: "creative_metrics" } : action === "figcraft" || action === "photocraft" ? { action: "open_editor", editor: action } : action === "drive" ? { action: "drive" } : { action: "publish_prepare" };
    void act({ ...body, cardId, item: index }, { cardId, key: `item:${index}:${action}` });
  }, [act]);
  const onConfirmPublish = useCallback((cardId: string, edits: PublishEdits) => { void act({ action: "publish_confirm", cardId, ...edits }, { cardId, key: "confirm" }); }, [act]);
  const onItemHover = useCallback((cardId: string, index: number | null) => { hotItem.current = index === null ? (hotItem.current?.cardId === cardId ? null : hotItem.current) : { cardId, index }; }, []);

  /** One dropped file sent to the board (POST act upload); 428 = Mo asks which client with chips, then sends again. */
  const uploadOne = useCallback(async (file: File, up: Upload, clientId?: string) => {
    const b = boardStateRef.current; if (!b) return;
    try {
      const data = await readDataUrl(file);
      const res = await fetch(`/api/mo/${b.id}/act`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "upload", name: file.name, mime: file.type, bytes: file.size, data, x: up.x, y: up.y, ...(clientId ? { clientId } : {}) }) });
      const j = (await res.json().catch(() => ({}))) as ActResponse;
      if (res.status === 428) {
        const ordered = orderClientCandidates(clientsRef.current, boardStateRef.current?.cards ?? []);
        setChoice({ question: `${file.name} : pour quel client ?`, chips: ordered.slice(0, MAX_CHIPS + 2).map((c) => ({ label: c.name, onPick: () => { setChoice(null); void uploadOne(file, up, c.id); } })) });
        if (!muted) speakRef.current("Pour quel client ?");
        return;
      }
      if (!res.ok || !j.card) throw new Error(j.error ?? `Erreur ${res.status}`);
      const card = j.card;
      knownIds.current.add(card.id);
      setBoard((bb) => (bb ? { ...bb, cards: [...bb.cards.filter((c) => c.id !== card.id), card] } : bb));
      setUploads((u) => u.filter((x) => x.id !== up.id));
      if (up.preview) URL.revokeObjectURL(up.preview);
      setFresh((f) => new Set([...f, card.id]));
      if (j.say) { setLastSaid((s) => ({ you: s?.you ?? "", mo: j.say! })); if (!muted) speakRef.current(j.say); }
    } catch (e) {
      setUploads((u) => u.map((x) => (x.id === up.id ? { ...x, state: "error", message: e instanceof Error ? e.message : "Le fichier n'a pas pu être rangé." } : x)));
    }
  }, [muted]);

  /** Files dropped or pasted: a local preview at once where they land, then each one is sent. */
  const dropFiles = useCallback((files: File[], world: { x: number; y: number }) => {
    const b = boardStateRef.current; if (!b) return;
    let dx = 0;
    const z = topZ(b.cards) + 1;
    files.slice(0, MAX_DROP_FILES).forEach((f, i) => {
      const kind = fileKindOf(f.type, f.name);
      const up: Upload = { id: `up_${Math.random().toString(36).slice(2, 8)}`, name: f.name, mime: f.type, bytes: f.size, x: Math.round(world.x + dx), y: Math.round(world.y), z: z + i, preview: kind === "image" ? URL.createObjectURL(f) : null, state: "pending" };
      dx += CARD_SIZES.file.w + COL_GAP;
      if (!kind) { setUploads((u) => [...u, { ...up, state: "error", message: "Format non pris en charge : PNG, JPG, WebP (visuel) ou PDF, DOCX (brief)." }]); return; }
      if (f.size > MAX_UPLOAD_BYTES) { setUploads((u) => [...u, { ...up, state: "error", message: "Fichier trop lourd : 20 Mo au plus." }]); return; }
      setUploads((u) => [...u, up]);
      void uploadOne(f, up);
    });
    if (files.length > MAX_DROP_FILES) setError(`${MAX_DROP_FILES} fichiers à la fois au plus : les suivants n'ont pas été pris.`);
  }, [uploadOne]);

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

  const mood: WaveMood = intro ? "intro" : voice.listening ? "listening" : run || acting ? "thinking" : voice.speaking ? "speaking" : "idle";
  const running = useMemo(() => (run ? { label: moStatusLabel(run.activity, run.jobId === "quick" ? "quick" : "model"), startedAt: run.startedAt, onStop: () => { if (run.jobId !== "quick" && run.jobId !== "pending") void stopJob(run.jobId).catch(() => undefined); } }
    : acting ? { label: actStatusLabel(acting.action), startedAt: acting.startedAt, onStop: () => undefined } : null), [run, acting]);

  /** An « ask » card answered: the option is the next message, the card leaves quietly. */
  const onAnswer = useCallback((id: string, option: string) => {
    setBoard((b) => (b ? { ...b, cards: b.cards.filter((c) => c.id !== id) } : b));
    queue(id, { removed: true });
    void send(option);
  }, [queue, send]);

  /** « autre… » : the sentence goes back to the input, ready for the client's name. */
  const typeOther = useCallback((draft: string) => { setAsk(null); composerRef.current?.setText(`${draft.trim().replace(/[\s?.!…]+$/, "")} pour `); }, []);
  // Chips of the composer: clients of the day first (those named on the board), then the rest; « autre… » lets one type the name.
  const composerAsk = useMemo<ComposerAsk | null>(() => {
    if (!ask) return null;
    const pick = (text: string) => { setAsk(null); void send(text); };
    if (ask.missing === "client") {
      const ordered = orderClientCandidates(ask.candidates, board?.cards ?? []);
      const chips = ordered.slice(0, MAX_CHIPS).map((c) => ({ label: c.name, onPick: () => pick(completeQuickAsk(ask, c)) }));
      const other = ordered.length > MAX_CHIPS ? [{ label: "autre…", muted: true, onPick: () => typeOther(ask.draft.text) }] : [];
      return { question: ask.question, chips: [...chips, ...other] };
    }
    return { question: ask.question, chips: PERIOD_OPTIONS.map((p) => ({ label: p.label, onPick: () => pick(completeQuickAsk(ask, p)) })) };
  }, [ask, board, send, typeOther]);

  return (
    <div className="fixed inset-0 z-[70] bg-[#07050f] text-gray-100 overflow-hidden" data-mo-ready={board ? "1" : undefined}>
      <WaveCanvas mood={mood} level={voice.level} levelRef={voice.levelRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(7,5,15,0)_0%,rgba(7,5,15,0.55)_70%,rgba(7,5,15,0.85)_100%)] pointer-events-none" />

      {/* Intro wordmark */}
      <div className={`absolute inset-0 flex flex-col items-center justify-center pointer-events-none transition-opacity duration-700 ${intro ? "opacity-100" : "opacity-0"}`}>
        <div className="text-[96px] font-semibold tracking-tight bg-gradient-to-r from-violet-200 via-fuchsia-200 to-violet-300 bg-clip-text text-transparent mo-intro-title">Mo</div>
        <div className="text-sm text-violet-200/70 mo-intro-sub">Maintiens <kbd className="px-1.5 py-0.5 rounded border border-white/15 bg-white/5 text-[11px]">espace</kbd> et parle-moi</div>
      </div>

      {/* Board */}
      <Board ref={boardRef} className="absolute inset-0" onViewChange={(v) => { kRef.current = v.k; }} onBackgroundClick={clearSelection} onDropFiles={dropFiles} onPasteFiles={dropFiles}
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
            onFront={onFront} onSelect={onSelect} onToggle={onToggle} onClose={onClose} onFocusRef={onFocusRef} onHoverRef={onHoverRef} onAnswer={onAnswer}
            onItemAction={onItemAction} onItemHover={onItemHover} onConfirmPublish={onConfirmPublish} busy={acting?.cardId === c.id ? acting.key : null} />
        ))}
        {ghost && <MoGhostCard ghost={ghost} onRetry={() => { setGhost(null); void send(ghost.text); }} onClose={() => setGhost(null)} />}
        {uploads.map((up) => <MoUploadCard key={up.id} up={up} onClose={() => { if (up.preview) URL.revokeObjectURL(up.preview); setUploads((u) => u.filter((x) => x.id !== up.id)); }} />)}
      </Board>

      {/* Board toolbar: ranger · fit · shortcuts — and the undo toast after a removal */}
      <div className="absolute bottom-5 left-5 flex items-center gap-1.5 pointer-events-auto">
        <button type="button" onClick={arrange} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-white/10" title="Ranger les cartes (R)"><LayoutGrid className="w-3.5 h-3.5" /> Ranger</button>
        <span className="hidden md:inline text-[10px] text-gray-600 ml-1">⌘0 tout voir · F nouvelles cartes · R ranger · Suppr retirer · G garder · X couper · P publier · glisse un fichier</span>
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
      {board && !board.cards.length && !run && !intro && !ghost && (
        <div className="absolute inset-x-0 top-[28%] flex flex-col items-center pointer-events-none">
          <div className="text-lg text-gray-300">Qu&apos;est-ce qu&apos;on regarde ?</div>
          <div className="mt-3 flex flex-col gap-1.5 items-center pointer-events-auto">
            {SUGGESTIONS.map((s) => <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-white/10 bg-black/40 backdrop-blur px-3.5 py-1.5 text-xs text-gray-300 hover:text-white hover:border-violet-400/50">{s}</button>)}
          </div>
        </div>
      )}

      {/* Bottom: the composer (always there) */}
      <Composer ref={composerRef} voice={voice} running={running} lastSaid={lastSaid} error={error} ask={composerAsk ?? choice} onSend={(t) => void send(t)} onEscape={() => { clearSelection(); setChoice(null); }} onFocus={warm} onBegin={warm} className="absolute inset-x-0 bottom-0 pb-5" />
    </div>
  );
}
