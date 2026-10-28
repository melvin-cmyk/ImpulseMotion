"use client";

/**
 * Voice of Mo in the browser: push-to-talk through the Web Speech API
 * (Chrome, French), the microphone level for the wave, and speech synthesis
 * for the spoken answers. No audio leaves the page except through the
 * browser's own recognition service.
 */

import { useCallback, useEffect, useRef, useState } from "react";

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

export interface VoiceState {
  supported: boolean;
  listening: boolean;
  /** Live transcript while the key is held. */
  interim: string;
  /** 0..1 microphone level. */
  level: number;
  speaking: boolean;
  error: string | null;
}

export function useVoice(onFinal: (text: string) => void) {
  const [state, setState] = useState<VoiceState>({ supported: false, listening: false, interim: "", level: 0, speaking: false, error: null });
  const rec = useRef<RecognitionLike | null>(null);
  const transcript = useRef("");
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<{ ctx: AudioContext; analyser: AnalyserNode; raf: number } | null>(null);
  const onFinalRef = useRef(onFinal);
  useEffect(() => { onFinalRef.current = onFinal; }, [onFinal]);
  const holding = useRef(false);

  useEffect(() => { queueMicrotask(() => setState((s) => ({ ...s, supported: !!recognitionCtor() }))); }, []);

  const stopMeter = useCallback(() => {
    if (audio.current) { cancelAnimationFrame(audio.current.raf); void audio.current.ctx.close().catch(() => undefined); audio.current = null; }
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setState((s) => ({ ...s, level: 0 }));
  }, []);

  const startMeter = useCallback(async () => {
    try {
      const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!holding.current) { ms.getTracks().forEach((t) => t.stop()); return; }
      stream.current = ms;
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
        const rms = Math.sqrt(sum / buf.length);
        setState((s) => ({ ...s, level: Math.min(1, rms * 6) }));
        if (audio.current) audio.current.raf = requestAnimationFrame(tick);
      };
      audio.current = { ctx, analyser, raf: requestAnimationFrame(tick) };
    } catch {
      // No meter without the microphone permission; recognition will say so.
    }
  }, []);

  /** Push-to-talk: begin (key or button down). */
  const begin = useCallback(() => {
    if (holding.current) return;
    const Ctor = recognitionCtor();
    if (!Ctor) { setState((s) => ({ ...s, error: "La reconnaissance vocale n'est pas disponible dans ce navigateur (utilise Chrome)." })); return; }
    holding.current = true;
    window.speechSynthesis?.cancel();
    transcript.current = "";
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
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      setState((s) => ({ ...s, error: e.error === "not-allowed" ? "Micro refusé : autorise le micro pour parler à Mo." : `Micro : ${e.error}` }));
    };
    r.onend = () => {
      // Chrome ends the session by itself after a silence: keep going while the key is held.
      if (holding.current && rec.current === r) { try { r.start(); } catch { /* already started */ } }
    };
    rec.current = r;
    try { r.start(); } catch { /* ignore */ }
    setState((s) => ({ ...s, listening: true, interim: "", error: null, speaking: false }));
    void startMeter();
  }, [startMeter]);

  /** Push-to-talk: release → the transcript is sent. */
  const end = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    const r = rec.current;
    rec.current = null;
    stopMeter();
    // Final results may still arrive right after stop(): give them a moment.
    if (r) { r.onend = null; try { r.stop(); } catch { /* ignore */ } }
    window.setTimeout(() => {
      const text = transcript.current.trim();
      setState((s) => ({ ...s, listening: false, interim: "" }));
      if (text) onFinalRef.current(text);
    }, 350);
  }, [stopMeter]);

  const cancel = useCallback(() => {
    holding.current = false;
    const r = rec.current; rec.current = null;
    if (r) { r.onend = null; try { r.abort(); } catch { /* ignore */ } }
    stopMeter();
    transcript.current = "";
    setState((s) => ({ ...s, listening: false, interim: "" }));
  }, [stopMeter]);

  const speak = useCallback((text: string) => {
    const synth = window.speechSynthesis;
    if (!synth || !text.trim()) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    u.rate = 1.04;
    u.pitch = 1;
    const voices = synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith("fr"));
    const preferred = voices.find((v) => /google/i.test(v.name) && /fran/i.test(v.name)) ?? voices.find((v) => /am[ée]lie|thomas|audrey|aurelie|siri/i.test(v.name)) ?? voices[0];
    if (preferred) u.voice = preferred;
    u.onstart = () => setState((s) => ({ ...s, speaking: true }));
    u.onend = () => setState((s) => ({ ...s, speaking: false }));
    u.onerror = () => setState((s) => ({ ...s, speaking: false }));
    synth.speak(u);
  }, []);

  const hush = useCallback(() => { window.speechSynthesis?.cancel(); setState((s) => ({ ...s, speaking: false })); }, []);

  // Voices load asynchronously in Chrome: touching the list once makes the French one available at the first answer.
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.getVoices();
    const onVoices = () => synth.getVoices();
    synth.addEventListener?.("voiceschanged", onVoices);
    return () => { synth.removeEventListener?.("voiceschanged", onVoices); synth.cancel(); };
  }, []);

  useEffect(() => () => { holding.current = false; rec.current?.abort(); stopMeter(); }, [stopMeter]);

  return { ...state, begin, end, cancel, speak, hush };
}
