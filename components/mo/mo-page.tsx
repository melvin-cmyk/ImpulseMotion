"use client";

/**
 * /mo — the consultant's Mo workspace. Full-screen board over the app chrome:
 * the violet wave behind, the client frames and the cards in front, the
 * composer at the bottom (text + microphone, always there), the pages rail on
 * the left (« Aujourd'hui », client pages, free pages), the journal of the day
 * on the right, ⌘K for clients / actions / pages. Hold SPACE (or the orb) to
 * talk; release to send. The moment a message leaves, a ghost card marks where
 * the answer will land (inside the client's frame); Mo answers out loud and
 * its cards replace the ghost. /mo opens « Aujourd'hui », /mo?b= a page. The
 * « Mo » intro plays once (localStorage).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Briefcase, ChevronDown, ChevronUp, FileOutput, Frame as FrameIcon, LayoutGrid, Maximize2, PanelLeft, PanelRight, Search, Volume2, VolumeX, X } from "lucide-react";
import { Board, type BoardHandle } from "@/components/mo/board";
import { MoCardView, MoGhostCard, MoUploadCard, type CardBusy, type Ghost, type PublishEdits, type Upload, type WholeCardAction } from "@/components/mo/card";
import { MoFrameView, MoGhostFrame } from "@/components/mo/frame";
import { PagesRail } from "@/components/mo/pages-rail";
import { JournalRail } from "@/components/mo/journal-rail";
import { MoPalette, type PaletteMode } from "@/components/mo/mo-palette";
import type { ClientRow } from "@/components/client-palette";
import { frameChildren, frameForMovedCard, frames as framesOf, isFrame, layoutWithFrames, moveFrameChildren, type MoFrame } from "@/lib/mo/frames";
import { pageTitle, type MoPages } from "@/lib/mo/pages";
import { localDay, type JournalEntry } from "@/lib/mo/journal";
import type { CreativeAction } from "@/components/mo/card-actions";
import { Composer, type ComposerAsk, type ComposerHandle } from "@/components/mo/composer";
import { warmMoBoard } from "@/components/mo/warm";
import { WaveCanvas, type WaveMood } from "@/components/mo/wave-canvas";
import { useVoice } from "@/components/mo/use-voice";
import { CARD_SIZES, COL_GAP, type MoBoardData, type MoCard, type MoCardPatch, type MoCardSpec } from "@/lib/mo/model";
import { MAX_UPLOAD_BYTES, cardClientOf, fileKindOf, isSheetCard, type SheetCard } from "@/lib/mo/act";
import { GRID, SNAP_SCREEN_PX, arrangeCards, linkAnchors, linkPath, rectOf, resizeRect, snapMove, topZ, type Guide, type HandleDir, type Rect } from "@/lib/mo/geometry";

const sameGuides = (a: Guide[], b: Guide[]) => a.length === b.length && a.every((g, i) => g.axis === b[i].axis && g.pos === b[i].pos && g.from === b[i].from && g.to === b[i].to);
import { PERIOD_OPTIONS, completeQuickAsk, ghostTitle, orderClientCandidates, parseFollowUpIntent, parseFollowUpQuick, parseNavIntent, parseQuickIntent, targetIndexes, withClientAliases, type IntentClient, type QuickAsk, type QuickFollowUp, type QuickResult } from "@/lib/mo/intents";
import { cardRemovedTooSoon, misunderstoodBy } from "@/lib/mo/measure";
import { nextSentences, sayProgress } from "@/lib/mo/voice";
import { actStatusLabel, moStatusLabel } from "@/lib/mo/status";
import { AI_JOB_STARTED_EVENT, followJob, stopJob, type JobEvent } from "@/lib/ai-job-client";
import { INITIAL_ACTIVITY, reduceActivity, type ActivityState } from "@/lib/ai-activity";

interface Run { jobId: string; startedAt: number; activity: ActivityState }
/** The last turn measured (spec §6): its MoTurn id, what was said, when, the cards it produced — to detect a reformulation, a 👎, a card removed at once. */
interface LastTurn { id: string | null; text: string; at: number; cardIds: string[]; path: "nav" | "quick" | "act" | "model" | "ask"; firstCardSent: boolean }
interface QuickResponse { say: string; cardIds: string[]; cards?: MoCard[]; messages?: MoBoardData["messages"]; turnId?: string | null; needs?: "client" | "brands" | "card"; question?: string; options?: string[]; error?: string }
/** An action of the board running (POST /api/mo/[id]/act): which card, which button, since when. */
interface Acting { cardId: string | null; key: CardBusy; action: string; startedAt: number }
interface ActResponse { say?: string; cardIds?: string[]; card?: MoCard; open?: string; needs?: { adset: Array<{ adsetId: string; adset: string; campaign: string; spend_30d: number; status: string | null }> }; turnId?: string; error?: string }
const MAX_DROP_FILES = 10;
const readDataUrl = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f); });

/** The « Mo » wordmark plays on the first visit only. */
const INTRO_KEY = "mo:intro-seen";
/** The rails stay as the person left them. */
const RAIL_LEFT_KEY = "mo:rail-left";
const RAIL_RIGHT_KEY = "mo:rail-right";
const railPref = (key: string, fallback: boolean) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === "1"; } catch { return fallback; } };
const rectOfCard = (c: MoCard) => ({ x: c.x, y: c.y, w: c.w, h: c.h ?? CARD_SIZES[c.type].h });
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
  const [pages, setPages] = useState<MoPages | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [lastSaid, setLastSaid] = useState<{ you: string; mo: string | null } | null>(null);
  const [intro, setIntro] = useState(false);
  const [railLeft, setRailLeft] = useState(true);
  const [railRight, setRailRight] = useState(true);
  const [palette, setPalette] = useState<{ open: boolean; mode: PaletteMode }>({ open: false, mode: "all" });
  /** The menu of a frame (right-click / ⋯): screen point and frame id. */
  const [menu, setMenu] = useState<{ frameId: string; x: number; y: number } | null>(null);
  const [journal, setJournal] = useState<{ day: string; entries: JournalEntry[]; loading: boolean }>({ day: localDay(), entries: [], loading: false });
  /** Bumped after anything Mo did, so the journal refreshes. */
  const [journalTick, setJournalTick] = useState(0);
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
  /** Mo's voice, queued: a sentence said after the one being said (the answer streams sentence by sentence). */
  const sayRef = useRef<(text: string) => void>(() => undefined);
  /** The sentence spoken as soon as it appeared in the stream (finishTurn then does not say it twice). */
  const earlySaid = useRef<string | null>(null);
  /** Sentences of the streaming « say » already handed to the voice (spoken one by one, lib/mo/voice.ts). */
  const spokenCount = useRef(0);
  /** The last turn, for the measures (reformulation within 60 s, 👎, card removed within 30 s). */
  const lastTurn = useRef<LastTurn | null>(null);
  /** Fire-and-forget writes of the measures (never block a turn). */
  const patchTurn = useCallback((id: string | null, patch: Record<string, unknown>) => { if (!id) return; void fetch(`/api/mo/turn/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).catch(() => undefined); }, []);
  const createTurn = useCallback(async (body: Record<string, unknown>): Promise<string | null> => { try { const r = await fetch("/api/mo/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const j = (await r.json().catch(() => ({}))) as { id?: string | null }; return j.id ?? null; } catch { return null; } }, []);
  /** The first card of the running turn landed: its delay goes on the turn (once). */
  const firstCardLanded = useCallback(() => { const t = lastTurn.current; if (!t || t.firstCardSent) return; t.firstCardSent = true; patchTurn(t.id, { firstCardMs: Date.now() - t.at }); }, [patchTurn]);
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

  /** The pages of the workspace (rail): home, client pages, free pages. */
  const loadPages = useCallback(async (): Promise<MoPages | null> => {
    const r = await fetch("/api/mo", { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { home: MoPages["home"]; pages: { client: MoPages["client"]; free: MoPages["free"] } };
    const p: MoPages = { home: j.home, client: j.pages?.client ?? [], free: j.pages?.free ?? [] };
    pagesRef.current = p;
    setPages(p);
    return p;
  }, []);
  const listBoards = loadPages;
  /** The pages as last loaded (set at once, before React renders them: openPage needs the home id right after the first load). */
  const pagesRef = useRef<MoPages | null>(null);

  /** Shows a page: URL, board, running reply, view on its cards, last exchange. */
  const openPage = useCallback(async (id: string, focusIds?: string[]) => {
    setFresh(new Set()); setSelected(new Set()); setGhost(null); setMenu(null);
    const home = pagesRef.current?.home.id;
    router.replace(id === home ? "/mo" : `/mo?b=${id}`);
    const j = await loadBoard(id);
    seenTurns.current = j.board.messages.filter((m) => m.role === "assistant").length;
    if (j.jobId) followRef.current?.(j.jobId, id);
    const last = [...j.board.messages].reverse();
    const you = last.find((m) => m.role === "user");
    setLastSaid(you ? { you: you.content, mo: last.find((m) => m.role === "assistant")?.say ?? null } : null);
    window.setTimeout(() => {
      const wanted = focusIds?.length ? j.board.cards.filter((c) => focusIds.includes(c.id)) : [];
      if (wanted.length) { setSelected(new Set(wanted.map((c) => c.id))); boardRef.current?.fit(wanted.map(rectOfCard), 90, { kMin: 0.5, kMax: 1 }); return; }
      const rects = j.board.cards.map(rectOfCard);
      if (rects.length) boardRef.current?.fit(rects, 90);
    }, 60);
    return j.board;
  }, [loadBoard, router]);
  const followRef = useRef<((jobId: string, boardId: string) => void) | null>(null);

  /** A new page: free, or the client's (created when missing). Opens it. */
  const createPage = useCallback(async (body: { kind: "free"; title?: string } | { kind: "client"; clientId: string }) => {
    const r = await fetch("/api/mo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { board?: MoBoardData; error?: string };
    if (!r.ok || !j.board) throw new Error(j.error ?? "Impossible de créer la page");
    await loadPages();
    await openPage(j.board.id);
    warmMoBoard(j.board.id);
    return j.board;
  }, [loadPages, openPage]);
  const createBoard = useCallback(() => createPage({ kind: "free" }), [createPage]);

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
    if (ids.size) firstCardLanded();
    if (lastTurn.current && lastTurn.current.path === "model") lastTurn.current.cardIds = [...ids];
    // The answer is in: the ghost has done its job (a card replaced it, or Mo only spoke).
    setGhost((g) => (g && g.state === "pending" ? null : g));
    setLastSaid((s) => ({ you: s?.you ?? "", mo: last?.say ?? null }));
    // What the stream did not say yet (the sentences were spoken one by one as they arrived) is said now.
    if (last?.say && !muted) {
      const left = earlySaid.current && last.say.startsWith(earlySaid.current) ? last.say.slice(earlySaid.current.length).trim() : earlySaid.current ? "" : last.say;
      if (left) sayRef.current(left);
    }
    earlySaid.current = null;
    spokenCount.current = 0;
    const rects = j.board.cards.filter((c) => ids.has(c.id)).map(rectOfCard);
    if (rects.length) window.setTimeout(() => boardRef.current?.fit(rects, 90, { kMin: 0.5, kMax: 1 }), 60);
    setJournalTick((t) => t + 1);
    // Mo was asked to open a page: the board stays (reopened from the rail), the page comes up once the sentence is said.
    if (last?.open && !last.cardIds?.length) window.setTimeout(() => router.push(last.open!), 900);
  }, [loadBoard, muted, router, firstCardLanded]);

  const follow = useCallback((jobId: string, boardId: string) => {
    follower.current?.abort();
    const ctl = new AbortController();
    follower.current = ctl;
    setRun({ jobId, startedAt: Date.now(), activity: INITIAL_ACTIVITY });
    streamText.current = "";
    earlySaid.current = null;
    spokenCount.current = 0;
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
        firstCardLanded();
        setFresh((f) => new Set([...f, ...added.map((c) => c.id)]));
        const rects = added.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h ?? CARD_SIZES[c.type].h }));
        window.setTimeout(() => boardRef.current?.fit(rects, 90, { kMin: 0.5, kMax: 1 }), 60);
      }).catch(() => undefined);
    }, 2000);
    const onEvent = (e: JobEvent) => {
      if (e.type === "job") return;
      // « say » is the first field of the answer: spoken sentence by sentence as it streams, cards or not (lib/mo/voice.ts).
      if ((e.type === "delta" || e.type === "content") && typeof e.text === "string") {
        streamText.current = e.type === "content" && !streamText.current ? e.text : streamText.current + (e.type === "delta" ? e.text : "");
        const progress = sayProgress(streamText.current);
        if (progress && progress.text.trim()) {
          const { sentences, spoken } = nextSentences(progress, spokenCount.current);
          spokenCount.current = spoken;
          if (sentences.length) {
            if (ackTimer.current) { window.clearTimeout(ackTimer.current); ackTimer.current = null; }
            earlySaid.current = `${earlySaid.current ? `${earlySaid.current} ` : ""}${sentences.join(" ")}`;
            setLastSaid((s) => ({ you: s?.you ?? "", mo: earlySaid.current }));
            if (!muted) for (const sentence of sentences) sayRef.current(sentence);
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
  }, [finishTurn, muted, firstCardLanded]);
  useEffect(() => { followRef.current = follow; }, [follow]);

  // First load: the wanted page (deep link), else « Aujourd'hui » (always there).
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { setRailLeft(railPref(RAIL_LEFT_KEY, true)); setRailRight(railPref(RAIL_RIGHT_KEY, true)); });
    (async () => {
      try {
        const p = await loadPages();
        if (cancelled) return;
        if (!p) throw new Error("Espace indisponible");
        const id = wanted ?? p.home.id;
        try { await openPage(id); } catch { if (cancelled) return; if (id !== p.home.id) await openPage(p.home.id); else throw new Error("Page introuvable"); }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Chargement impossible");
      }
    })();
    return () => { cancelled = true; follower.current?.abort(); follower.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The journal of the day, across pages: refreshed after each thing Mo does, and every minute.
  useEffect(() => {
    let cancelled = false;
    setJournal((j) => ({ ...j, loading: true }));
    const load = () => fetch(`/api/mo/journal?day=${journal.day}&tz=${new Date().getTimezoneOffset()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j: { entries: JournalEntry[] } | null) => { if (!cancelled && j) setJournal((s) => ({ ...s, entries: j.entries, loading: false })); }).catch(() => { if (!cancelled) setJournal((s) => ({ ...s, loading: false })); });
    void load();
    const t = window.setInterval(load, 60_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [journal.day, journalTick]);
  const toggleRail = useCallback((side: "left" | "right") => {
    if (side === "left") setRailLeft((v) => { try { localStorage.setItem(RAIL_LEFT_KEY, v ? "0" : "1"); } catch { /* fine */ } return !v; });
    else setRailRight((v) => { try { localStorage.setItem(RAIL_RIGHT_KEY, v ? "0" : "1"); } catch { /* fine */ } return !v; });
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
      clientsRef.current = withClientAliases((j.clients ?? []).map((c) => ({ id: c.id, name: c.name, dashboardId: c.dashboardId, aliasIds: c.aliasIds ?? [] })));
    }).catch(() => undefined);
  }, []);

  /** The frame a ghost would open (dashed outline) while the quick answer runs. */
  const [ghostFrame, setGhostFrame] = useState<{ rect: Rect; name: string; color: string } | null>(null);
  useEffect(() => { if (!ghost) setGhostFrame(null); }, [ghost]);
  /** Draws the ghost where the next card will land (same rule as the server: inside the client's frame, else a new row under everything), and brings it into view. */
  const placeGhost = useCallback((text: string, quick: QuickResult | QuickFollowUp | null, clientHint?: IntentClient | null) => {
    const b = boardStateRef.current;
    if (!b) return;
    const type: MoCard["type"] = quick?.kind === "creatives" || quick?.kind === "more_like_this" || quick?.kind === "competitor_ads" ? "creatives" : "kpis";
    const title = ghostTitle(text, quick);
    const client = quick && (quick.kind === "creatives" || quick.kind === "metrics") ? quick.client : quick && (quick.kind === "compare" || quick.kind === "competitor_ads") ? quick.client ?? clientHint ?? null : clientHint ?? null;
    const spec = { type, title, ...(client ? { clientId: client.id, clientName: client.name } : {}) } as unknown as MoCardSpec;
    const laid = layoutWithFrames(b.cards, [spec], b.messages.filter((m) => m.role === "assistant").length, new Date().toISOString());
    const placed = laid.placed[0];
    if (!placed) return;
    const g: Ghost = { id: placed.id, text, title, x: placed.x, y: placed.y, w: placed.w, h: placed.h ?? CARD_SIZES[type].h, z: placed.z ?? 0, state: "pending", startedAt: Date.now() };
    const nf = laid.newFrames[0];
    setGhostFrame(nf ? { rect: { x: nf.x, y: nf.y, w: nf.w, h: nf.h ?? CARD_SIZES.frame.h }, name: nf.clientName, color: nf.color } : null);
    setGhost(g);
    const rects = [{ x: g.x, y: g.y, w: g.w, h: g.h }, ...(nf ? [{ x: nf.x, y: nf.y, w: nf.w, h: nf.h ?? CARD_SIZES.frame.h }] : [])];
    window.setTimeout(() => boardRef.current?.fit(rects, 90, { kMin: 0.5, kMax: 1 }), 30);
  }, []);

  /** `send` is called from the chips it offers (428 answers): through this ref, so the callback does not depend on itself. */
  const sendRef = useRef<(text: string, opts?: { fromChip?: boolean }) => Promise<void>>(async () => undefined);
  const send = useCallback(async (text: string, opts: { fromChip?: boolean } = {}) => {
    const t = text.trim();
    if (!t || !board || run || acting) return;
    setGhost((g) => (g && g.state === "error" ? null : g));
    setError(null);
    setLastSaid({ you: t, mo: null });
    const now = Date.now();
    // Measures (spec §6): « non / pas ça » or the same thing said again within 60 s = the previous turn was not understood; an ask left without a chip too.
    const prev = lastTurn.current;
    const why = misunderstoodBy(prev ? { text: prev.text, at: prev.at } : null, { text: t, at: now });
    if (prev && !opts.fromChip && (why || prev.path === "ask")) patchTurn(prev.id, { misunderstood: true });
    if (prev && opts.fromChip && prev.path === "ask") patchTurn(prev.id, { clarified: true });
    const retried = why === "reformulation";
    const startTurn = (path: LastTurn["path"], id: string | null = null): LastTurn => { const lt: LastTurn = { id, text: t, at: now, cardIds: [], path, firstCardSent: false }; lastTurn.current = lt; return lt; };
    const withTurn = (turn: LastTurn) => (j: ActResponse | null) => { if (j?.turnId) { turn.id = j.turnId; turn.cardIds = j.cardIds ?? []; if (turn.cardIds.length) turn.firstCardSent = true; } };

    // "Ouvre le cockpit de Naturalia": understood here, executed at once, no model call.
    const nav = parseNavIntent(t, clientsRef.current);
    if (nav) {
      setLastSaid({ you: t, mo: nav.say });
      if (!muted) speakRef.current(nav.say);
      const turn = startTurn("nav");
      void createTurn({ boardId: board.id, path: "nav", totalMs: 0, firstCardMs: 0, retried }).then((id) => { turn.id = id; });
      window.setTimeout(() => router.push(nav.path), 600);
      return;
    }
    // « Mets ça dans un Google Sheet » over the table / KPI / creatives card at hand: an export, no model.
    const followUp = parseFollowUpIntent(t);
    if (followUp?.kind === "sheet") {
      const target = targetSheetCard();
      if (!target) { setLastSaid({ you: t, mo: "Je ne vois pas de tableau à exporter." }); if (!muted) speakRef.current("Je ne vois pas de tableau à exporter."); return; }
      setLastSaid({ you: t, mo: followUp.say });
      const turn = startTurn("act");
      void act({ action: "sheet", cardId: target.id, said: t }, { cardId: target.id, key: "sheet" }).then(withTurn(turn));
      return;
    }
    // « Mets les chiffres dessous », « garde celle-là », « coupe les deux dernières », « publie la première » over the creatives card at hand: an action, no model.
    if (followUp) {
      const target = targetCreativesCard();
      if (target) {
        setLastSaid({ you: t, mo: followUp.say });
        const turn = startTurn("act");
        const hot = hotItem.current?.cardId === target.id ? hotItem.current.index : null;
        if (followUp.kind === "creative_metrics") { void act({ action: "creative_metrics", cardId: target.id, ...(followUp.period ? { period: followUp.period } : {}), said: t }, { cardId: target.id, key: null }).then(withTurn(turn)); return; }
        if (followUp.kind === "publish") {
          const idx = targetIndexes(followUp.target, target.items.length, hot)[0];
          if (idx !== undefined) { void act({ action: "publish_prepare", cardId: target.id, item: idx, said: t }, { cardId: target.id, key: `item:${idx}:publish` }).then(withTurn(turn)); return; }
          setChoice({ question: "Laquelle je publie ?", chips: target.items.slice(0, 8).map((it, i) => ({ label: `${i + 1}. ${it.name.length > 28 ? it.name.slice(0, 27) + "…" : it.name}`, onPick: () => { setChoice(null); void act({ action: "publish_prepare", cardId: target.id, item: i, said: t }, { cardId: target.id, key: `item:${i}:publish` }).then(withTurn(turn)); } })) });
          if (!muted) speakRef.current("Laquelle je publie ?");
          return;
        }
        const verdict = followUp.verdict;
        const runVerdict = (i: number) => act({ action: "verdict", cardId: target.id, item: i, verdict, said: t }, { cardId: target.id, key: `item:${i}:${verdict === "keep" ? "keep" : "cut"}` }).then(withTurn(turn));
        const idxs = targetIndexes(followUp.target, target.items.length, hot);
        if (idxs.length) { (async () => { for (const i of idxs) await runVerdict(i); })(); return; }
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
      const turn = startTurn("ask");
      void createTurn({ boardId: board.id, path: "ask", kind: quick.draft.what, retried }).then((id) => { turn.id = id; });
      return;
    }
    setAsk(null);
    // « Deux autres comme ça », « compare avec la semaine d'avant », « montre les pubs de La Fourche » : the server resolves them against the card at hand, without the model.
    const fu: QuickFollowUp | null = quick ? null : parseFollowUpQuick(t, clientsRef.current);
    const plan: QuickResult | QuickFollowUp | null = quick ?? fu;
    const hint = fu?.kind === "more_like_this" ? targetCreativesCard() : fu?.kind === "compare" ? targetKpiCard() : null;
    const hintClient = hint ? cardClientOf(hint, clientsRef.current) : null;
    setBoard((b) => (b ? { ...b, messages: [...b.messages, { role: "user", content: t, at: new Date().toISOString() }] } : b));
    placeGhost(t, plan, hintClient);
    // « Les créas de Cours Legendre cette semaine », « le CPA de Naturalia ce mois-ci » : the app runs the tool itself, no model, 3 seconds.
    if (plan) {
      const turn = startTurn("quick");
      // A follow-up takes longer (a generation, the Ad Library): Mo announces it at once.
      if (fu) { setLastSaid({ you: t, mo: fu.say }); if (!muted) speakRef.current(fu.say); }
      setRun({ jobId: `quick:${plan.kind}`, startedAt: now, activity: INITIAL_ACTIVITY });
      try {
        const res = await fetch(`/api/mo/${board.id}/quick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: t, ...(hint ? { cardId: hint.id } : {}), retried }) });
        if (res.status === 200) {
          const j = (await res.json()) as QuickResponse;
          setRun(null);
          turn.id = j.turnId ?? null; turn.cardIds = j.cardIds;
          if (j.cardIds.length) { turn.firstCardSent = true; patchTurn(turn.id, { firstCardMs: Date.now() - now }); }
          setLastSaid({ you: t, mo: j.say });
          if (!muted) speakRef.current(j.say);
          const ids = new Set(j.cardIds);
          let cards: MoCard[];
          if (j.cards && j.messages) {
            // The answer carries the board: the cards show at once, no second round trip.
            const next = { cards: j.cards, messages: j.messages };
            setBoard((b) => (b ? { ...b, ...next } : b));
            cards = next.cards;
            seenTurns.current = next.messages.filter((m) => m.role === "assistant").length;
          } else {
            const loaded = await loadBoard(board.id);
            seenTurns.current = loaded.board.messages.filter((m) => m.role === "assistant").length;
            cards = loaded.board.cards;
          }
          knownIds.current = new Set(cards.map((c) => c.id));
          setFresh(ids);
          // No card came back: the ghost says why, with a retry.
          setGhost((g) => (g && g.state === "pending" ? (ids.size ? null : { ...g, state: "error", message: j.say }) : g));
          const rects = cards.filter((c) => ids.has(c.id)).map(rectOfCard);
          if (rects.length) window.setTimeout(() => boardRef.current?.fit(rects, 90, { kMin: 0.5, kMax: 1 }), 60);
          void listBoards();
          setJournalTick((k) => k + 1);
          return;
        }
        if (res.status === 428) {
          // One thing missing: Mo asks with chips (the client), or puts the sentence back for the brands.
          const j = (await res.json().catch(() => ({}))) as QuickResponse;
          setRun(null); setGhost(null);
          const question = j.question ?? "Il me manque une précision.";
          setLastSaid({ you: t, mo: question });
          if (!muted) speakRef.current(question);
          if (j.needs === "client" && j.options?.length) {
            const ordered = orderClientCandidates(clientsRef.current.filter((c) => j.options!.includes(c.name)), boardStateRef.current?.cards ?? []);
            setChoice({ question, chips: ordered.slice(0, MAX_CHIPS).map((c) => ({ label: c.name, onPick: () => { setChoice(null); void sendRef.current(`${t.replace(/[\s?.!…]+$/, "")} pour ${c.name}`, { fromChip: true }); } })) });
          } else if (j.needs === "brands") composerRef.current?.setText("montre les pubs de ");
          return;
        }
        if (res.status !== 204) { const j = (await res.json().catch(() => ({}))) as { error?: string }; if (res.status === 409) { setRun(null); setError(j.error ?? "Mo répond déjà."); setGhost(null); return; } }
      } catch { /* the normal way below */ }
      setRun(null);
    }
    try {
      // The state line says « je réfléchis » from the first instant: the turn is being posted (follow() takes over once the job exists).
      setRun({ jobId: "pending", startedAt: Date.now(), activity: INITIAL_ACTIVITY });
      const res = await fetch(`/api/mo/${board.id}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: t, retried }) });
      const j = (await res.json().catch(() => ({}))) as { jobId?: string; turnId?: string; error?: string };
      if (res.status === 409 && j.jobId) { follow(j.jobId, board.id); return; }
      if (!res.ok || !j.jobId) { setRun(null); throw new Error(j.error ?? `Erreur ${res.status}`); }
      startTurn("model", j.turnId ?? null);
      window.dispatchEvent(new Event(AI_JOB_STARTED_EVENT));
      seenTurns.current = board.messages.filter((m) => m.role === "assistant").length;
      follow(j.jobId, board.id);
      void listBoards();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Mo n'a pas répondu";
      setError(msg);
      setGhost((g) => (g && g.state === "pending" ? { ...g, state: "error", message: msg } : g));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- act, targetCreativesCard and targetKpiCard are defined below (stable callbacks)
  }, [board, run, acting, follow, listBoards, loadBoard, muted, router, placeGhost, patchTurn, createTurn]);
  useEffect(() => { sendRef.current = send; }, [send]);

  const voice = useVoice(send);
  useEffect(() => { speakRef.current = voice.speak; sayRef.current = voice.say; }, [voice.speak, voice.say]);
  // A dictation starts, the composer takes the focus: Mo's process is warmed on the relay meanwhile (fire and forget).
  const boardIdRef = useRef<string | null>(null);
  useEffect(() => { boardIdRef.current = board?.id ?? null; }, [board]);
  const warm = useCallback(() => warmMoBoard(boardIdRef.current), []);

  // SPACE held = talk (outside text fields); Escape = quiet.
  useEffect(() => {
    const isTyping = () => { const el = document.activeElement as HTMLElement | null; return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable); };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isTyping() && !run) { e.preventDefault(); warm(); voice.begin(); }
      if (e.key === "Escape") { voice.hush(); if (voice.handsFree) voice.setHandsFree(false); else voice.cancel(); setMenu(null); setChoice(null); }
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
  /** A frame being dragged: where it and its cards started (the cards follow by the same delta). */
  const frameDrag = useRef<{ id: string; x: number; y: number; kids: MoCard[] } | null>(null);
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
      const fd = frameDrag.current;
      const kids = fd && fd.id === l.id ? moveFrameChildren(fd.kids, fd.id, l.x - fd.x, l.y - fd.y) : null;
      setBoard((b) => (b ? { ...b, cards: b.cards.map((c): MoCard => (c.id === l.id ? { ...c, x: l.x, y: l.y, w: l.w, h: l.h } as MoCard : kids?.has(c.id) ? { ...c, ...kids.get(c.id)! } as MoCard : c)) } : b));
    });
  }, []);

  const onMove = useCallback((id: string, dx: number, dy: number, alt: boolean) => {
    const b = boardStateRef.current;
    const c = b?.cards.find((x) => x.id === id);
    if (!b || !c) return { x: 0, y: 0 };
    const cur = live.current?.id === id ? live.current : { id, x: c.x, y: c.y, w: c.w, h: c.h ?? CARD_SIZES[c.type].h };
    if (live.current?.id !== id) frameDrag.current = isFrame(c) ? { id, x: c.x, y: c.y, kids: frameChildren(b.cards, id) } : null;
    // Raw target from the accumulated deltas (kept apart from the snapped one so the card does not "stick").
    const raw = { x: (live.current?.id === id ? rawPos.current.x : c.x) + dx, y: (live.current?.id === id ? rawPos.current.y : c.y) + dy };
    rawPos.current = raw;
    // A frame snaps to the other frames and the free cards, not to its own cards; a card does not snap to the frame it moves in.
    const kidIds = new Set(frameDrag.current?.kids.map((k) => k.id) ?? []);
    const others = b.cards.filter((x) => x.id !== id && !kidIds.has(x.id) && !(c.frame && x.id === c.frame)).map(rectOf);
    const snapped = snapMove({ x: raw.x, y: raw.y, w: cur.w, h: cur.h }, others, SNAP_SCREEN_PX / (kRef.current || 1), alt ? null : GRID);
    live.current = { ...cur, x: snapped.x, y: snapped.y };
    setGuides((g) => (sameGuides(g, snapped.guides) ? g : snapped.guides));
    commitLive();
    return { x: snapped.x, y: snapped.y };
  }, [commitLive]);
  const onMoveEnd = useCallback((id: string, moved: boolean) => {
    const l = live.current;
    const fd = frameDrag.current;
    live.current = null; frameDrag.current = null;
    setGuides([]);
    if (!moved || !l || l.id !== id) return;
    cancelAnimationFrame(commitRaf.current); commitRaf.current = 0;
    const b = boardStateRef.current;
    if (fd && fd.id === id) {
      // The frame moved: its cards by the same delta.
      const kids = moveFrameChildren(fd.kids, id, l.x - fd.x, l.y - fd.y);
      setBoard((bb) => (bb ? { ...bb, cards: bb.cards.map((c): MoCard => (c.id === id ? { ...c, x: l.x, y: l.y } as MoCard : kids.has(c.id) ? { ...c, ...kids.get(c.id)! } as MoCard : c)) } : bb));
      queue(id, { x: l.x, y: l.y });
      for (const [kid, p] of kids) queue(kid, p);
      return;
    }
    // A card dropped in a frame joins it; dragged out, it leaves it.
    const c = b?.cards.find((x) => x.id === id);
    const nextFrame = b && c ? frameForMovedCard(b.cards, { ...c, x: l.x, y: l.y, w: l.w, h: l.h }) : null;
    const frameChange = c && (nextFrame ?? undefined) !== c.frame ? { frame: nextFrame } : {};
    setBoard((bb) => (bb ? { ...bb, cards: bb.cards.map((cc): MoCard => (cc.id === id ? ({ ...cc, x: l.x, y: l.y, ...("frame" in frameChange ? (nextFrame ? { frame: nextFrame } : { frame: undefined }) : {}) } as MoCard) : cc)) } : bb));
    queue(id, { x: l.x, y: l.y, ...frameChange });
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
    // Measures (spec §6): the card Mo just produced, removed within 30 s, was not what was wanted.
    const lt = lastTurn.current;
    if (lt && ids.some((id) => cardRemovedTooSoon(lt, id, Date.now()))) patchTurn(lt.id, { misunderstood: true });
    const b = boardStateRef.current; if (!b || !ids.length) return;
    const removed = b.cards.filter((c) => ids.includes(c.id));
    if (!removed.length) return;
    const gone = new Set(removed.filter(isFrame).map((f) => f.id));
    setBoard((bb) => (bb ? { ...bb, cards: bb.cards.filter((c) => !ids.includes(c.id)).map((c) => (c.frame && gone.has(c.frame) ? ({ ...c, frame: undefined } as MoCard) : c)) } : bb));
    setSelected((s) => { const n = new Set(s); ids.forEach((i) => n.delete(i)); return n; });
    setUndo((u) => {
      if (u) { window.clearTimeout(u.timer); u.cards.forEach((c) => queue(c.id, { removed: true })); }
      const timer = window.setTimeout(() => { removed.forEach((c) => queue(c.id, { removed: true })); setUndo(null); }, 5000);
      return { cards: removed, timer };
    });
  }, [queue, patchTurn]);
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

  /** The card an export to Google Sheets is about (table, KPI, creatives): the one selected, else the freshest, else the latest on the board. */
  const targetSheetCard = useCallback((): SheetCard | null => {
    const b = boardStateRef.current; if (!b) return null;
    const rows = b.cards.filter(isSheetCard);
    const sel = rows.filter((c) => selectedRef.current.has(c.id));
    if (sel.length === 1) return sel[0];
    const latest = (list: SheetCard[]) => [...list].sort((a, c) => (c.at > a.at ? 1 : c.at < a.at ? -1 : 0))[0] ?? null;
    return latest(rows.filter((c) => freshRef.current.has(c.id))) ?? latest(rows);
  }, []);

  /** The KPI card a comparison is about: the one selected, else the freshest, else the latest on the board. */
  const targetKpiCard = useCallback((): Extract<MoCard, { type: "kpis" }> | null => {
    const b = boardStateRef.current; if (!b) return null;
    const kpis = b.cards.filter((c): c is Extract<MoCard, { type: "kpis" }> => c.type === "kpis");
    const sel = kpis.filter((c) => selectedRef.current.has(c.id));
    if (sel.length === 1) return sel[0];
    const latest = (list: typeof kpis) => [...list].sort((a, c) => (c.at > a.at ? 1 : c.at < a.at ? -1 : 0))[0] ?? null;
    return latest(kpis.filter((c) => freshRef.current.has(c.id))) ?? latest(kpis);
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
  /** « Google Sheet » in a card's header (or S on the selected card): its rows exported, the link lands on the card. */
  const onCardAction = useCallback((cardId: string, action: WholeCardAction) => { if (action === "sheet") void act({ action: "sheet", cardId }, { cardId, key: "sheet" }); }, [act]);
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

  /** « Ranger » : frame by frame (each sized to its cards), then the free cards by turn; every card moved and saved, then fit. */
  const arrange = useCallback(() => {
    const b = boardStateRef.current; if (!b || !b.cards.length) return;
    const pos = arrangeCards(b.cards);
    const cards = b.cards.map((c): MoCard => { const p = pos.get(c.id); if (!p) return c; const w = p.w ?? c.w, h = p.h ?? c.h; return p.x !== c.x || p.y !== c.y || w !== c.w || h !== c.h ? ({ ...c, x: p.x, y: p.y, w, ...(h !== undefined ? { h } : {}) } as MoCard) : c; });
    cards.forEach((c, i) => { if (c !== b.cards[i]) queue(c.id, { x: c.x, y: c.y, ...(isFrame(c) ? { w: c.w, h: c.h } : {}) }); });
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
      if (e.key === "Escape") { clearSelection(); setMenu(null); return; }
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
    // ⌘K is Mo's palette here (the app's own ⌘K listens on the window too: captured first, stopped).
    const onPalette = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); e.stopPropagation(); setPalette((p) => ({ open: !p.open, mode: "all" })); } };
    window.addEventListener("keydown", onPalette, true);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keydown", onPalette, true); };
  }, [selected, clearSelection, fitAll, fitFresh, arrange, removeCards, queue]);
  useEffect(() => () => { cancelAnimationFrame(commitRaf.current); if (undo) window.clearTimeout(undo.timer); }, [undo]);

  const frameList = useMemo(() => framesOf(board?.cards ?? []), [board]);
  const foldedFrames = useMemo(() => new Set(frameList.filter((f) => f.minimized).map((f) => f.id)), [frameList]);
  const frameCounts = useMemo(() => { const m = new Map<string, number>(); for (const c of board?.cards ?? []) if (c.frame && !isFrame(c)) m.set(c.frame, (m.get(c.frame) ?? 0) + 1); return m; }, [board]);
  const sortedCards = useMemo(() => (board?.cards ?? []).filter((c) => !isFrame(c) && !(c.frame && foldedFrames.has(c.frame))).sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || a.turn - b.turn), [board, foldedFrames]);
  const framedClients = useMemo(() => frameList.map((f) => ({ clientId: f.clientId, clientName: f.clientName })), [frameList]);
  const freshOrder = useMemo(() => { const m = new Map<string, number>(); let i = 0; for (const c of board?.cards ?? []) if (fresh.has(c.id)) m.set(c.id, i++); return m; }, [board, fresh]);
  const titles = useMemo(() => new Map((board?.cards ?? []).map((c) => [c.id, c.title])), [board]);
  const links = useMemo(() => (board?.cards ?? []).flatMap((c) => {
    const r = c.ref ? board?.cards.find((x) => x.id === c.ref) : null;
    if (!r) return [];
    const anchors = linkAnchors(rectOf(r), rectOf(c));
    return [{ id: c.id, d: linkPath(anchors), mid: { x: (anchors.a.x + anchors.b.x) / 2, y: (anchors.a.y + anchors.b.y) / 2 } }];
  }), [board]);

  const mood: WaveMood = intro ? "intro" : voice.listening ? "listening" : run || acting ? "thinking" : voice.speaking ? "speaking" : "idle";
  const running = useMemo(() => (run ? { label: moStatusLabel(run.activity, run.jobId.startsWith("quick") ? (run.jobId as `quick:${string}`) : "model"), startedAt: run.startedAt, onStop: () => { if (!run.jobId.startsWith("quick") && run.jobId !== "pending") void stopJob(run.jobId).catch(() => undefined); } }
    : acting ? { label: actStatusLabel(acting.action), startedAt: acting.startedAt, onStop: () => undefined } : null), [run, acting]);

  /** An « ask » card answered: the option is the next message, the card leaves quietly. */
  const onAnswer = useCallback((id: string, option: string) => {
    setBoard((b) => (b ? { ...b, cards: b.cards.filter((c) => c.id !== id) } : b));
    queue(id, { removed: true });
    void send(option, { fromChip: true });
  }, [queue, send]);

  /** « autre… » : the sentence goes back to the input, ready for the client's name. */
  const typeOther = useCallback((draft: string) => { setAsk(null); composerRef.current?.setText(`${draft.trim().replace(/[\s?.!…]+$/, "")} pour `); }, []);
  // Chips of the composer: clients of the day first (those named on the board), then the rest; « autre… » lets one type the name.
  const composerAsk = useMemo<ComposerAsk | null>(() => {
    if (!ask) return null;
    const pick = (text: string) => { setAsk(null); void send(text, { fromChip: true }); };
    if (ask.missing === "client") {
      const ordered = orderClientCandidates(ask.candidates, board?.cards ?? []);
      const chips = ordered.slice(0, MAX_CHIPS).map((c) => ({ label: c.name, onPick: () => pick(completeQuickAsk(ask, c)) }));
      const other = ordered.length > MAX_CHIPS ? [{ label: "autre…", muted: true, onPick: () => typeOther(ask.draft.text) }] : [];
      return { question: ask.question, chips: [...chips, ...other] };
    }
    return { question: ask.question, chips: PERIOD_OPTIONS.map((p) => ({ label: p.label, onPick: () => pick(completeQuickAsk(ask, p)) })) };
  }, [ask, board, send, typeOther]);

  // ── Workspace: pages, frames menu, palette, journal ───────────────────
  const openPageSafe = useCallback((id: string, focusIds?: string[]) => { void openPage(id, focusIds).catch((e) => setError(e instanceof Error ? e.message : "Page introuvable")); }, [openPage]);
  const renamePage = useCallback(async (id: string, title: string) => {
    await fetch(`/api/mo/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) }).catch(() => undefined);
    setBoard((b) => (b && b.id === id ? { ...b, title } : b));
    void loadPages();
  }, [loadPages]);
  const archivePage = useCallback(async (id: string) => {
    await fetch(`/api/mo/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: true }) }).catch(() => undefined);
    const p = await loadPages();
    if (boardStateRef.current?.id === id && p) openPageSafe(p.home.id);
  }, [loadPages, openPageSafe]);
  /** The frame of a client on this page brought into view and selected (true when there is one). */
  const focusFrame = useCallback((clientId: string): boolean => {
    const f = framesOf(boardStateRef.current?.cards ?? []).find((x) => x.clientId === clientId);
    if (!f) return false;
    const kids = frameChildren(boardStateRef.current?.cards ?? [], f.id);
    boardRef.current?.fit([rectOf(f), ...kids.map(rectOf)], 90, { kMin: 0.3, kMax: 1 });
    setSelected(new Set([f.id]));
    return true;
  }, []);
  /** A client picked in the palette: its frame here, else its page (created when needed). */
  const pickClient = useCallback((c: ClientRow, mode: PaletteMode) => {
    if (mode === "all" && focusFrame(c.id)) return;
    const page = pagesRef.current?.client.find((p) => p.clientId === c.id);
    if (page) { openPageSafe(page.id); return; }
    void createPage({ kind: "client", clientId: c.id }).catch((e) => setError(e instanceof Error ? e.message : "Impossible d'ouvrir la page du client"));
  }, [focusFrame, openPageSafe, createPage]);
  /** « Détacher en page » : the frame and its cards leave for the client's page, which opens. */
  const detachFrame = useCallback(async (frameId: string) => {
    const b = boardStateRef.current; if (!b) return;
    setMenu(null);
    try {
      const r = await fetch(`/api/mo/${b.id}/detach`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ frameId }) });
      const j = (await r.json().catch(() => ({}))) as { pageId?: string; error?: string };
      if (!r.ok || !j.pageId) throw new Error(j.error ?? `Erreur ${r.status}`);
      await loadPages();
      openPageSafe(j.pageId);
      setJournalTick((t) => t + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "Le cadre n'a pas pu être détaché."); }
  }, [loadPages, openPageSafe]);
  const onFrameMenu = useCallback((frameId: string, x: number, y: number) => setMenu({ frameId, x, y }), []);
  const onFrameOpenPage = useCallback((frameId: string) => { const f = frameList.find((x) => x.id === frameId); if (f) pickClient({ id: f.clientId } as ClientRow, "client-page"); }, [frameList, pickClient]);
  const onJournalOpen = useCallback((e: JournalEntry) => { if (e.boardId === boardStateRef.current?.id) { const wanted = (boardStateRef.current?.cards ?? []).filter((c) => e.cardIds.includes(c.id)); if (wanted.length) { setSelected(new Set(wanted.map((c) => c.id))); boardRef.current?.fit(wanted.map(rectOfCard), 90, { kMin: 0.5, kMax: 1 }); } return; } openPageSafe(e.boardId, e.cardIds); }, [openPageSafe]);
  /** « Publier la sélection » : the selected creatives card's visual at hand (else its first) goes to publish_prepare. */
  const publishSelection = useCallback(() => {
    const target = targetCreativesCard();
    if (!target) { setError("Sélectionne d'abord une carte de créas."); return; }
    const idx = hotItem.current?.cardId === target.id ? hotItem.current.index : target.items.findIndex((it) => it.verdict !== "cut");
    onItemAction(target.id, Math.max(0, idx), "publish");
  }, [targetCreativesCard, onItemAction]);
  const menuFrame = menu ? frameList.find((f) => f.id === menu.frameId) ?? null : null;
  const menuFrameHasPage = !!menuFrame && board?.kind === "client" && board.clientId === menuFrame.clientId;
  const currentTitle = board ? pageTitle({ kind: board.kind, title: board.title, clientName: pages?.client.find((p) => p.id === board.id)?.clientName }) : "";
  const railTop = "top-14", railBottom = "bottom-28";

  return (
    <div className="fixed inset-0 z-[70] bg-[#07050f] text-gray-100 overflow-hidden" data-mo-ready={board ? "1" : undefined} data-mo-page-kind={board?.kind}>
      <WaveCanvas mood={mood} level={voice.level} levelRef={voice.levelRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(7,5,15,0)_0%,rgba(7,5,15,0.55)_70%,rgba(7,5,15,0.85)_100%)] pointer-events-none" />

      {/* Intro wordmark */}
      <div className={`absolute inset-0 flex flex-col items-center justify-center pointer-events-none transition-opacity duration-700 ${intro ? "opacity-100" : "opacity-0"}`}>
        <div className="text-[96px] font-semibold tracking-tight bg-gradient-to-r from-violet-200 via-fuchsia-200 to-violet-300 bg-clip-text text-transparent mo-intro-title">Mo</div>
        <div className="text-sm text-violet-200/70 mo-intro-sub">Maintiens <kbd className="px-1.5 py-0.5 rounded border border-white/15 bg-white/5 text-[11px]">espace</kbd> et parle-moi</div>
      </div>

      {/* Board — inset by the open rails, so « tout voir » and the focus on a card fit between them */}
      <div className="absolute inset-y-0" style={{ left: railLeft ? 272 : 0, right: railRight ? 320 : 0 }}>
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
        {frameList.map((f) => (
          <MoFrameView key={f.id} frame={f as MoFrame} count={frameCounts.get(f.id) ?? 0} selected={selected.has(f.id)} getK={getK}
            onMove={onMove} onMoveEnd={onMoveEnd} onResizeStart={onResizeStart} onResize={onResize} onResizeEnd={onResizeEnd}
            onSelect={onSelect} onToggle={onToggle} onMenu={onFrameMenu} onOpenPage={onFrameOpenPage} />
        ))}
        {ghostFrame && <MoGhostFrame rect={ghostFrame.rect} name={ghostFrame.name} color={ghostFrame.color} />}
        {sortedCards.map((c) => (
          <MoCardView key={c.id} card={c} fresh={fresh.has(c.id)} delayMs={(freshOrder.get(c.id) ?? 0) * 60} selected={selected.has(c.id)} refTitle={c.ref ? titles.get(c.ref) ?? null : null} getK={getK}
            onMove={onMove} onMoveEnd={onMoveEnd} onResizeStart={onResizeStart} onResize={onResize} onResizeEnd={onResizeEnd}
            onFront={onFront} onSelect={onSelect} onToggle={onToggle} onClose={onClose} onFocusRef={onFocusRef} onHoverRef={onHoverRef} onAnswer={onAnswer}
            onItemAction={onItemAction} onItemHover={onItemHover} onConfirmPublish={onConfirmPublish} onCardAction={onCardAction} busy={acting?.cardId === c.id ? acting.key : null} />
        ))}
        {ghost && <MoGhostCard ghost={ghost} onRetry={() => { setGhost(null); void send(ghost.text); }} onClose={() => setGhost(null)} />}
        {uploads.map((up) => <MoUploadCard key={up.id} up={up} onClose={() => { if (up.preview) URL.revokeObjectURL(up.preview); setUploads((u) => u.filter((x) => x.id !== up.id)); }} />)}
      </Board>
      </div>

      {/* Board toolbar: ranger · fit · shortcuts — and the undo toast after a removal */}
      <div className="absolute bottom-5 left-5 flex items-center gap-1.5 pointer-events-auto">
        <button type="button" onClick={arrange} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-white/10" title="Ranger les cartes (R)"><LayoutGrid className="w-3.5 h-3.5" /> Ranger</button>
        <span className="hidden md:inline text-[10px] text-gray-600 ml-1">⌘K clients, actions, pages · ⌘0 tout voir · F nouvelles cartes · R ranger · Suppr retirer · G garder · X couper · P publier · glisse un fichier</span>
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
          <button type="button" data-rail-toggle="left" onClick={() => toggleRail("left")} className={`inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur px-2.5 py-1.5 text-xs hover:bg-white/10 ${railLeft ? "text-violet-200" : "text-gray-300"}`} title="Pages (rail de gauche)"><PanelLeft className="w-3.5 h-3.5" /></button>
          <div data-mo-page-title className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur px-3 py-1.5 text-xs text-gray-200 max-w-[320px]">
            {board?.kind === "client" ? <Briefcase className="w-3.5 h-3.5 text-violet-300 shrink-0" /> : <span className="w-2 h-2 rounded-full bg-violet-400 shrink-0" />}<span className="truncate">{currentTitle || "…"}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 pointer-events-auto">
          <button type="button" data-mo-palette-button onClick={() => setPalette({ open: true, mode: "all" })} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-white/10" title="Clients, actions, pages (⌘K)"><Search className="w-3.5 h-3.5" /> <span className="hidden md:inline">Rechercher</span> <kbd className="hidden md:inline text-[10px] text-gray-500 border border-white/10 rounded px-1">⌘K</kbd></button>
          <button type="button" onClick={fitAll} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-white/10" title="Tout voir"><Maximize2 className="w-3.5 h-3.5" /> Tout voir</button>
          <button type="button" onClick={() => { setMuted((m) => { if (!m) voice.hush(); return !m; }); }} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur px-2.5 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-white/10" title={muted ? "Réactiver la voix de Mo" : "Couper la voix de Mo"}>{muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}</button>
          <button type="button" data-rail-toggle="right" onClick={() => toggleRail("right")} className={`inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur px-2.5 py-1.5 text-xs hover:bg-white/10 ${railRight ? "text-violet-200" : "text-gray-300"}`} title="Journal du jour (rail de droite)"><PanelRight className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {/* Rails: pages on the left, the journal of the day on the right */}
      {railLeft && <PagesRail pages={pages} currentId={board?.id ?? null} onOpen={openPageSafe} onNewFree={() => void createBoard().catch((e) => setError(e.message))} onNewClient={() => setPalette({ open: true, mode: "client-page" })} onRename={(id, t) => void renamePage(id, t)} onArchive={(id) => void archivePage(id)} className={`absolute left-4 ${railTop} ${railBottom} w-60 z-10 pointer-events-auto`} />}
      {railRight && <JournalRail day={journal.day} entries={journal.entries} loading={journal.loading} onDay={(day) => setJournal((j) => ({ ...j, day }))} onOpen={onJournalOpen} className={`absolute right-4 ${railTop} ${railBottom} w-72 z-10 pointer-events-auto`} />}

      {/* Menu of a frame */}
      {menu && menuFrame && (
        <>
          <div className="fixed inset-0 z-30" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div data-frame-context-menu className="fixed z-40 w-72 rounded-xl border border-white/10 bg-[#0d0a1a]/95 backdrop-blur-xl shadow-2xl p-1.5 text-xs" style={{ left: Math.min(menu.x, window.innerWidth - 300), top: Math.min(menu.y, window.innerHeight - 200) }}>
            <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1.5"><FrameIcon className="w-3 h-3" /> {menuFrame.clientName}</div>
            {!menuFrameHasPage && <button type="button" data-menu-detach onClick={() => void detachFrame(menuFrame.id)} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-violet-200 hover:bg-white/10"><FileOutput className="w-3.5 h-3.5" /> Détacher en page</button>}
            <button type="button" onClick={() => { setMenu(null); focusFrame(menuFrame.clientId); }} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-gray-200 hover:bg-white/10"><Maximize2 className="w-3.5 h-3.5" /> Voir le cadre</button>
            <button type="button" onClick={() => { setMenu(null); onToggle(menuFrame.id); }} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-gray-200 hover:bg-white/10">{menuFrame.minimized ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />} {menuFrame.minimized ? "Déplier" : "Replier"}</button>
            <button type="button" onClick={() => { setMenu(null); removeCards([menuFrame.id]); }} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-gray-400 hover:text-rose-300 hover:bg-white/10"><X className="w-3.5 h-3.5 shrink-0" /> <span className="whitespace-nowrap">Retirer le cadre <span className="text-gray-600">(les cartes restent)</span></span></button>
          </div>
        </>
      )}

      {/* ⌘K */}
      <MoPalette open={palette.open} mode={palette.mode} onMode={(mode) => setPalette({ open: true, mode })} onClose={() => setPalette((p) => ({ ...p, open: false }))} pages={pages} currentId={board?.id ?? null} framed={framedClients} hasSelection={selected.size > 0}
        onPickClient={pickClient} onOpenPage={openPageSafe} onNewFree={() => void createBoard().catch((e) => setError(e.message))} onSend={(t) => void send(t)} onArrange={arrange} onFitAll={fitAll} onPublishSelection={publishSelection} />

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
      <Composer ref={composerRef} voice={voice} running={running} lastSaid={lastSaid} error={error} ask={composerAsk ?? choice} onSend={(t) => void send(t)} onEscape={() => { clearSelection(); setChoice(null); }} onFocus={warm} onBegin={warm} onThumbsDown={() => patchTurn(lastTurn.current?.id ?? null, { misunderstood: true })} className="absolute inset-x-0 bottom-0 pb-5" />
    </div>
  );
}
