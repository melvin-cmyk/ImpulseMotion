"use client";

/**
 * Voice of Mo in the browser.
 *
 * Listening (push-to-talk) records the microphone with MediaRecorder in
 * every browser; in parallel, when the browser offers it (Chrome), the Web
 * Speech API gives a live transcript. On release: the live transcript is
 * used when it is there, otherwise the recording goes to the relay
 * (POST /api/mo/stt → Parakeet, local, French) — so Brave, Arc, Safari and
 * Firefox work too, and nothing is lost when Chrome's recognition fails.
 *
 * Speaking: the sentence is synthesised on the relay (POST /api/mo/tts →
 * Piper French) and played; the browser's own speechSynthesis is the
 * fallback. `speak` replaces what is being said, `say` queues a sentence
 * after it (the answer is spoken sentence by sentence while it streams).
 * Barge-in: `begin()` (the person starts talking) cuts Mo's playback and
 * empties the queue. Hands-free (off by default, no wake word): the
 * microphone stays open, a level above the threshold starts an utterance
 * and 700 ms of silence ends it and sends it (lib/mo/voice.ts vadStep).
 * `levelRef` carries the microphone level at 60 Hz for the visuals, `level`
 * is a throttled copy for React.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { VAD_DEFAULT, initialSpeech, speechReduce, vadInitial, vadStep, type SpeechState, type VadState } from "@/lib/mo/voice";

interface RecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function recognitionCtor(): (new () => RecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Brave ships the API but keeps it off: treat it as absent. */
function webSpeechUsable(): boolean {
  if (!recognitionCtor()) return false;
  const nav = navigator as Navigator & { brave?: unknown };
  return !nav.brave;
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/wav"]) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* next */ }
  }
  return "";
}

export interface VoiceState {
  /** Some way to listen exists (recorder or recognition). */
  supported: boolean;
  listening: boolean;
  /** Live transcript while the key is held (Chrome only). */
  interim: string;
  /** 0..1 microphone level, throttled (~10 Hz). */
  level: number;
  /** The recording is at the server, being transcribed. */
  transcribing: boolean;
  speaking: boolean;
  error: string | null;
  /** Hands-free mode: the microphone stays open, a silence ends the sentence. */
  handsFree: boolean;
}

export interface Voice extends VoiceState {
  levelRef: MutableRefObject<number>;
  begin: () => void;
  end: () => void;
  cancel: () => void;
  /** Says this now (what was being said stops). */
  speak: (text: string) => void;
  /** Says this after what is being said (sentence by sentence while the answer streams). */
  say: (text: string) => void;
  hush: () => void;
  setHandsFree: (on: boolean) => void;
}

const SERVER_TTS = true;

/**
 * A natural FEMALE French voice of the browser, when it has one: Edge's neural
 * voices (Denise, Eloise, Vivienne « Online (Natural) »), Chrome's « Google
 * français », Apple's enhanced Amélie / Audrey. Null otherwise.
 */
function premiumBrowserVoice(): SpeechSynthesisVoice | null {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
  if (!synth) return null;
  const fr = synth.getVoices().filter((v) => /^fr([-_]|$)/i.test(v.lang));
  return fr.find((v) => /online.*natural|natural/i.test(v.name) && /denise|eloise|vivienne|charline|sylvie|ariane|fabienne|coralie|jacqueline|eloise/i.test(v.name))
    ?? fr.find((v) => /google/i.test(v.name) && /fran/i.test(v.name))
    ?? fr.find((v) => /am[ée]lie|audrey/i.test(v.name) && /enhanced|premium|am[ée]lior/i.test(v.name))
    ?? null;
}

export function useVoice(onFinal: (text: string) => void): Voice {
  const [state, setState] = useState<VoiceState>({ supported: false, listening: false, interim: "", level: 0, transcribing: false, speaking: false, error: null, handsFree: false });
  /** The speech queue (lib/mo/voice.ts): what is being said, what waits. */
  const speech = useRef<SpeechState>(initialSpeech);
  const handsFree = useRef(false);
  const vad = useRef<VadState>(vadInitial);
  const speakingRef = useRef(false);
  /** Set once the hook is built: the functions the level meter calls (defined below). */
  const onVoice = useRef<{ start: () => void; end: () => void }>({ start: () => undefined, end: () => undefined });
  const levelRef = useRef(0);
  const lastLevelPush = useRef(0);
  const rec = useRef<RecognitionLike | null>(null);
  const transcript = useRef("");
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const audio = useRef<{ ctx: AudioContext; analyser: AnalyserNode; raf: number } | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const onFinalRef = useRef(onFinal);
  useEffect(() => { onFinalRef.current = onFinal; }, [onFinal]);
  const holding = useRef(false);
  const session = useRef(0);

  useEffect(() => {
    queueMicrotask(() => setState((s) => ({ ...s, supported: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && (typeof MediaRecorder !== "undefined" || webSpeechUsable()) })));
  }, []);

  const setLevel = useCallback((v: number) => {
    levelRef.current = v;
    const now = performance.now();
    if (now - lastLevelPush.current > 100) { lastLevelPush.current = now; setState((s) => (Math.abs(s.level - v) > 0.02 ? { ...s, level: v } : s)); }
  }, []);

  const stopMeter = useCallback(() => {
    if (audio.current) { cancelAnimationFrame(audio.current.raf); void audio.current.ctx.close().catch(() => undefined); audio.current = null; }
    setLevel(0);
  }, [setLevel]);

  const stopTracks = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  /** Microphone: one stream feeds the recorder and the level meter. */
  const openMic = useCallback(async (): Promise<MediaStream | null> => {
    try {
      const ms = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (!holding.current) { ms.getTracks().forEach((t) => t.stop()); return null; }
      stream.current = ms;
      try {
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(ms);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
          const level = Math.min(1, Math.sqrt(sum / buf.length) * 6);
          setLevel(level);
          // Hands-free: the level meter is the end-point detector (a higher bar while Mo speaks, so its own voice does not count).
          if (handsFree.current) {
            const cfg = speakingRef.current ? { ...VAD_DEFAULT, threshold: VAD_DEFAULT.threshold * 2, minSpeechMs: 400 } : VAD_DEFAULT;
            const r = vadStep(vad.current, level, performance.now(), cfg);
            vad.current = r.state;
            if (r.event === "start") onVoice.current.start();
            else if (r.event === "end") onVoice.current.end();
          }
          if (audio.current) audio.current.raf = requestAnimationFrame(tick);
        };
        audio.current = { ctx, analyser, raf: requestAnimationFrame(tick) };
      } catch { /* no meter */ }
      return ms;
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      setState((s) => ({ ...s, error: name === "NotAllowedError" || name === "SecurityError" ? "Micro refusé : autorise le micro pour parler à Mo (icône dans la barre d'adresse)." : name === "NotFoundError" ? "Aucun micro détecté." : `Micro indisponible (${name || "erreur"}).` }));
      return null;
    }
  }, [setLevel]);

  /** Barge-in: the person speaks (or asks for silence) → Mo stops at once, the queue is emptied, an utterance in flight will not start. */
  const hush = useCallback(() => {
    session.current++;
    speech.current = speechReduce(speech.current, { type: "hush" }).state;
    window.speechSynthesis?.cancel();
    if (player.current) { player.current.pause(); player.current.currentTime = 0; }
    speakingRef.current = false;
    setState((s) => (s.speaking ? { ...s, speaking: false } : s));
  }, []);

  /** Push-to-talk: begin (key or button down). Cuts Mo's voice first (barge-in). */
  const begin = useCallback(() => {
    if (holding.current) return;
    hush();
    holding.current = true;
    const mySession = ++session.current;
    transcript.current = "";
    chunks.current = [];
    vad.current = vadInitial;
    setState((s) => ({ ...s, listening: true, interim: "", error: null, speaking: false, transcribing: false }));

    // Live transcript when the browser really offers it (Chrome).
    if (webSpeechUsable()) {
      const Ctor = recognitionCtor()!;
      const r = new Ctor();
      r.lang = "fr-FR";
      r.continuous = true;
      r.interimResults = true;
      r.maxAlternatives = 1;
      r.onresult = (e) => {
        let finals = "";
        let interim = "";
        for (let i = 0; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) finals += res[0].transcript + " ";
          else interim += res[0].transcript;
        }
        transcript.current = (finals + interim).trim();
        setState((s) => ({ ...s, interim: transcript.current }));
      };
      r.onerror = () => { /* the recording covers it */ };
      r.onend = () => { if (holding.current && rec.current === r) { try { r.start(); } catch { /* already */ } } };
      rec.current = r;
      try { r.start(); } catch { rec.current = null; }
    }

    // The recording, in every browser.
    void openMic().then((ms) => {
      if (!ms || session.current !== mySession || !holding.current) return;
      const mime = pickMime();
      try {
        const mr = mime ? new MediaRecorder(ms, { mimeType: mime, audioBitsPerSecond: 32_000 }) : new MediaRecorder(ms);
        mr.ondataavailable = (ev) => { if (ev.data.size) chunks.current.push(ev.data); };
        recorder.current = mr;
        mr.start(250);
      } catch { recorder.current = null; }
    });
  }, [openMic, hush]);

  const sendRecording = useCallback(async (blob: Blob, spoken: string) => {
    if (spoken) { onFinalRef.current(spoken); return; }
    if (!blob.size || blob.size < 2_000) { setState((s) => ({ ...s, error: "Je n'ai rien entendu : maintiens l'orbe pendant que tu parles." })); return; }
    setState((s) => ({ ...s, transcribing: true }));
    try {
      const res = await fetch("/api/mo/stt", { method: "POST", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob });
      const j = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      const text = (j.text ?? "").trim();
      if (!text) { setState((s) => ({ ...s, error: "Je n'ai pas compris : réessaie en parlant un peu plus fort." })); return; }
      onFinalRef.current(text);
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : "Transcription impossible." }));
    } finally {
      setState((s) => ({ ...s, transcribing: false }));
    }
  }, []);

  /** Push-to-talk: release → the transcript (or the recording) is sent. */
  const end = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    const r = rec.current;
    rec.current = null;
    if (r) { r.onend = null; try { r.stop(); } catch { /* ignore */ } }
    const mr = recorder.current;
    recorder.current = null;
    stopMeter();
    const finish = () => {
      stopTracks();
      const spoken = transcript.current.trim();
      const blob = new Blob(chunks.current, { type: mr?.mimeType || chunks.current[0]?.type || "audio/webm" });
      chunks.current = [];
      setState((s) => ({ ...s, listening: false, interim: "" }));
      void sendRecording(blob, spoken);
    };
    if (mr && mr.state !== "inactive") {
      mr.onstop = () => window.setTimeout(finish, 250); // final recognition results may still arrive
      try { mr.stop(); } catch { finish(); }
    } else {
      window.setTimeout(finish, 300);
    }
  }, [stopMeter, stopTracks, sendRecording]);

  const cancel = useCallback(() => {
    holding.current = false;
    session.current++;
    const r = rec.current; rec.current = null;
    if (r) { r.onend = null; try { r.abort(); } catch { /* ignore */ } }
    const mr = recorder.current; recorder.current = null;
    if (mr && mr.state !== "inactive") { mr.onstop = null; try { mr.stop(); } catch { /* ignore */ } }
    chunks.current = [];
    stopMeter();
    stopTracks();
    transcript.current = "";
    setState((s) => ({ ...s, listening: false, interim: "", transcribing: false }));
  }, [stopMeter, stopTracks]);

  /** One utterance is over (or failed): the next of the queue starts, else silence. */
  const utteranceEnded = useCallback((generation: number) => {
    if (generation !== speech.current.generation) return; // hushed meanwhile
    const r = speechReduce(speech.current, { type: "ended" });
    speech.current = r.state;
    if (r.start) startUtterance.current(r.start, r.state.generation);
    else { speakingRef.current = false; setState((s) => ({ ...s, speaking: false })); }
  }, []);

  const speakWithBrowser = useCallback((text: string, generation: number) => {
    const synth = window.speechSynthesis;
    if (!synth) { utteranceEnded(generation); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    u.rate = 1.04;
    const preferred = premiumBrowserVoice() ?? synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith("fr")).find((v) => /am[ée]lie|audrey|aurelie|denise|eloise|vivienne|marie|julie|siri/i.test(v.name)) ?? synth.getVoices().find((v) => v.lang.toLowerCase().startsWith("fr"));
    if (preferred) u.voice = preferred;
    u.onstart = () => { speakingRef.current = true; setState((s) => ({ ...s, speaking: true })); };
    u.onend = () => utteranceEnded(generation);
    u.onerror = () => utteranceEnded(generation);
    synth.speak(u);
  }, [utteranceEnded]);

  /** Starts one utterance of the queue (relay voice, else the browser's). */
  const startUtterance = useRef<(text: string, generation: number) => void>(() => undefined);
  startUtterance.current = (clean: string, generation: number) => {
    speakingRef.current = true;
    setState((s) => ({ ...s, speaking: true }));
    // The browser's own natural female French voice (Edge's neural voices, Chrome's Google voice, Apple's enhanced ones)
    // is better and instant; the relay's Piper voice is for the browsers without one (Brave, Firefox…).
    if (!SERVER_TTS || premiumBrowserVoice()) { speakWithBrowser(clean, generation); return; }
    const mySession = ++session.current;
    fetch("/api/mo/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: clean }) })
      .then(async (res) => {
        if (!res.ok) throw new Error(`tts ${res.status}`);
        const blob = await res.blob();
        if (session.current !== mySession || generation !== speech.current.generation) return;
        const url = URL.createObjectURL(blob);
        const el = player.current ?? new Audio();
        player.current = el;
        el.src = url;
        el.onended = () => { URL.revokeObjectURL(url); utteranceEnded(generation); };
        el.onerror = () => { URL.revokeObjectURL(url); utteranceEnded(generation); };
        await el.play().catch(() => utteranceEnded(generation));
      })
      .catch(() => { if (session.current === mySession && generation === speech.current.generation) speakWithBrowser(clean, generation); });
  };

  const enqueue = useCallback((text: string, replace: boolean) => {
    const clean = text.trim();
    if (!clean) return;
    if (replace) { window.speechSynthesis?.cancel(); if (player.current) { player.current.pause(); player.current.currentTime = 0; } }
    const r = speechReduce(speech.current, { type: "say", text: clean, replace });
    speech.current = r.state;
    if (r.start) startUtterance.current(r.start, r.state.generation);
  }, []);
  /** Says this now: what was being said stops. */
  const speak = useCallback((text: string) => enqueue(text, true), [enqueue]);
  /** Says this after what is being said. */
  const say = useCallback((text: string) => enqueue(text, false), [enqueue]);

  // ── Hands-free (explicit mode, no wake word): the meter's end-point ends the sentence and sends it, then listens again ──
  const endRef = useRef<() => void>(() => undefined);
  endRef.current = end;
  const beginRef = useRef<() => void>(() => undefined);
  beginRef.current = begin;
  onVoice.current = {
    // The person starts talking while Mo speaks: Mo stops (barge-in). The recording restarts so the sent audio starts at the voice.
    start: () => { if (speakingRef.current) hush(); const mr = recorder.current; const ms = stream.current; if (mr && ms && mr.state !== "inactive") { try { mr.ondataavailable = null; mr.stop(); const next = new MediaRecorder(ms, mr.mimeType ? { mimeType: mr.mimeType, audioBitsPerSecond: 32_000 } : undefined); chunks.current = []; next.ondataavailable = (ev) => { if (ev.data.size) chunks.current.push(ev.data); }; recorder.current = next; next.start(250); } catch { /* keep the running one */ } } },
    end: () => { if (!holding.current) return; endRef.current(); window.setTimeout(() => { if (handsFree.current && !holding.current) beginRef.current(); }, 700); },
  };
  const setHandsFree = useCallback((on: boolean) => {
    handsFree.current = on;
    vad.current = vadInitial;
    setState((s) => ({ ...s, handsFree: on }));
    if (on) { if (!holding.current) beginRef.current(); }
    else if (holding.current) cancel();
  }, [cancel]);

  // Voices load asynchronously in Chrome: touching the list once makes the French one available for the fallback.
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.getVoices();
    const onVoices = () => synth.getVoices();
    synth.addEventListener?.("voiceschanged", onVoices);
    return () => { synth.removeEventListener?.("voiceschanged", onVoices); synth.cancel(); };
  }, []);

  useEffect(() => () => { holding.current = false; handsFree.current = false; rec.current?.abort(); recorder.current?.stop?.(); stopMeter(); stopTracks(); player.current?.pause(); }, [stopMeter, stopTracks]);

  return { ...state, levelRef, begin, end, cancel, speak, say, hush, setHandsFree };
}
