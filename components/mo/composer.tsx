"use client";

/**
 * The composer of Mo: always visible at the bottom of the board. A text
 * input, the microphone (hold to talk, or click to start / click to stop),
 * send, one line of state (what Mo is doing, in Mo's words), and the chips
 * Mo offers when something is missing (« Pour quel client ? »).
 * `/` focuses the input, Escape blurs it and quiets Mo, ⌘⏎ (or ⏎) sends.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Loader2, Mic, SendHorizontal, Square, Volume2 } from "lucide-react";
import type { Voice } from "@/components/mo/use-voice";

export interface ComposerChip { label: string; onPick: () => void; muted?: boolean }
export interface ComposerAsk { question: string; chips: ComposerChip[] }

export interface ComposerHandle {
  focus(): void;
  /** Puts a sentence in the input (cursor at the end) and focuses it. */
  setText(text: string): void;
}

interface Props {
  voice: Voice;
  /** The running turn: its state line and how to stop it. */
  running: { label: string; startedAt: number; onStop: () => void } | null;
  lastSaid: { you: string; mo: string | null } | null;
  error: string | null;
  ask: ComposerAsk | null;
  onSend: (text: string) => void;
  /** Escape pressed in the input (after the blur): the page deselects, etc. */
  onEscape?: () => void;
  /** The input took the focus (the page warms Mo). */
  onFocus?: () => void;
  /** A dictation starts from the microphone button (same). */
  onBegin?: () => void;
  className?: string;
}

const HOLD_MS = 350;

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ voice, running, lastSaid, error, ask, onSend, onEscape, onFocus, onBegin, className }, ref) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [elapsed, setElapsed] = useState(0);
  /** Microphone pressed at (ms): a short press toggles, a long press is push-to-talk. */
  const pressedAt = useRef<number | null>(null);
  const toggled = useRef(false);

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    setText: (t: string) => { setText(t); window.setTimeout(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 0); },
  }), []);

  // Elapsed seconds of the running turn (shown after 3 s).
  useEffect(() => {
    if (!running) { setElapsed(0); return; }
    const started = running.startedAt;
    const tick = () => setElapsed(Math.round((Date.now() - started) / 1000));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [running]);

  // `/` anywhere (outside a field) focuses the composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = useCallback(() => {
    const t = text.trim();
    if (!t || running) return;
    onSend(t);
    setText("");
  }, [text, running, onSend]);

  // Microphone: hold = push-to-talk (release sends); a short click starts listening, the next click stops.
  const micDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    if (toggled.current) { toggled.current = false; pressedAt.current = null; voice.end(); return; }
    pressedAt.current = Date.now();
    onBegin?.();
    voice.begin();
  }, [voice, onBegin]);
  const micUp = useCallback(() => {
    if (pressedAt.current === null) return;
    const held = Date.now() - pressedAt.current;
    pressedAt.current = null;
    if (held >= HOLD_MS) voice.end();
    else toggled.current = true;
  }, [voice]);
  const micLeave = useCallback(() => { if (pressedAt.current !== null && voice.listening && Date.now() - pressedAt.current >= HOLD_MS) { pressedAt.current = null; voice.end(); } }, [voice]);
  useEffect(() => { if (!voice.listening) toggled.current = false; }, [voice.listening]);

  const status = running ? `${running.label}${elapsed >= 3 ? ` · ${elapsed} s` : ""}`
    : voice.listening ? (voice.interim || "Je t'écoute…")
    : voice.transcribing ? "je note ce que tu as dit"
    : null;
  const busy = !!running || voice.transcribing;

  return (
    <div className={`flex flex-col items-center pointer-events-none ${className ?? ""}`}>
      <div className="w-[min(92vw,44rem)] mb-2 space-y-1.5 text-center min-h-[1.25rem]">
        {lastSaid?.you && !voice.listening && <div className="text-[13px] text-gray-400 line-clamp-2"><span className="text-gray-600">Toi ·</span> {lastSaid.you}</div>}
        {status ? (
          <div data-mo-status className="inline-flex items-center gap-2 rounded-full border border-violet-400/20 bg-violet-500/10 backdrop-blur px-3.5 py-1.5 text-[13px] text-violet-100 max-w-full">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />}
            <span className="truncate">{status}{busy ? "…" : ""}</span>
          </div>
        ) : lastSaid?.mo ? (
          <div data-mo-say className="text-[15px] text-gray-100 leading-snug pointer-events-auto">
            {voice.speaking ? <Volume2 className="w-3.5 h-3.5 text-violet-300 inline -mt-0.5 mr-1" /> : <span className="text-violet-300">Mo ·</span>} {lastSaid.mo}
            {voice.speaking && <button type="button" onClick={() => voice.hush()} className="ml-2 text-[11px] text-gray-400 hover:text-white align-middle">stop</button>}
          </div>
        ) : null}
        {error && <div className="text-[12px] text-rose-300">{error}</div>}
        {ask && !running && (
          <div data-mo-chips className="pointer-events-auto flex flex-wrap items-center justify-center gap-1.5 pt-1">
            <span className="text-[12px] text-violet-200/80 mr-1">{ask.question}</span>
            {ask.chips.map((c) => (
              <button key={c.label} type="button" onClick={c.onPick} className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${c.muted ? "border-white/10 bg-black/30 text-gray-400 hover:text-white hover:border-white/30" : "border-violet-400/40 bg-violet-500/15 text-violet-100 hover:bg-violet-500/30 hover:border-violet-300"}`}>{c.label}</button>
            ))}
          </div>
        )}
      </div>
      <form
        className="pointer-events-auto flex items-center gap-2 w-[min(92vw,44rem)] rounded-full border border-white/10 bg-black/50 backdrop-blur-xl pl-1.5 pr-1.5 py-1.5 shadow-[0_10px_40px_-10px_rgba(124,58,237,0.5)] focus-within:border-violet-400/60"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        {running ? (
          <button type="button" onClick={running.onStop} className="w-11 h-11 shrink-0 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 shadow-[0_0_40px_rgba(139,92,246,0.55)] inline-flex items-center justify-center text-white mo-orb-think" aria-label="Arrêter Mo" title="Arrêter Mo"><Square className="w-4 h-4" /></button>
        ) : (
          <button
            type="button"
            onPointerDown={micDown}
            onPointerUp={micUp}
            onPointerLeave={micLeave}
            onContextMenu={(e) => e.preventDefault()}
            className={`w-11 h-11 shrink-0 rounded-full inline-flex items-center justify-center text-white transition-transform ${voice.listening ? "bg-gradient-to-br from-fuchsia-500 to-violet-600 shadow-[0_0_60px_rgba(217,70,239,0.7)]" : voice.transcribing ? "bg-gradient-to-br from-violet-500 to-purple-700 mo-orb-think" : "bg-gradient-to-br from-violet-500 to-purple-700 shadow-[0_0_30px_rgba(139,92,246,0.45)] hover:scale-105"}`}
            style={voice.listening ? { transform: `scale(${1.05 + voice.level * 0.25})` } : undefined}
            aria-label={voice.listening ? "Arrêter d'écouter" : "Parler à Mo"}
            title={voice.supported ? "Maintiens pour parler (ou la barre espace) · un clic pour parler sans maintenir" : "Reconnaissance vocale indisponible ici : écris à Mo"}
          >
            {voice.transcribing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Mic className="w-5 h-5" />}
          </button>
        )}
        <input
          ref={input}
          data-mo-input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={onFocus}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); input.current?.blur(); voice.hush(); if (voice.listening) voice.cancel(); onEscape?.(); return; }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          }}
          placeholder={voice.listening ? "Je t'écoute…" : running ? "Mo travaille… (tu peux préparer la suite)" : "Écris à Mo, ou maintiens espace pour parler"}
          className="flex-1 min-w-0 bg-transparent px-2 py-2 text-[14px] text-white placeholder:text-gray-500 focus:outline-none"
          autoComplete="off"
          spellCheck={false}
        />
        <kbd className="hidden sm:inline text-[10px] text-gray-600 border border-white/10 rounded px-1 py-0.5 mr-1">/</kbd>
        <button type="submit" disabled={!text.trim() || !!running} className="w-9 h-9 shrink-0 rounded-full bg-violet-600 hover:bg-violet-500 disabled:opacity-30 inline-flex items-center justify-center text-white" aria-label="Envoyer" title="Envoyer (⏎ ou ⌘⏎)"><SendHorizontal className="w-4 h-4" /></button>
      </form>
      <div className="mt-1.5 text-[11px] text-gray-500">{voice.supported ? "espace ou l'orbe pour parler · / pour écrire · Échap pour couper" : "Reconnaissance vocale indisponible ici : utilise Chrome, ou écris à Mo"}</div>
    </div>
  );
});
