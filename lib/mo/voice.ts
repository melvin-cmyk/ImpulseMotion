/**
 * The pure parts of Mo's voice (components/mo/use-voice.ts): the sentences of
 * a « say » still streaming (spoken one by one while the rest arrives), the
 * speech queue with barge-in (the person speaks → Mo stops), and the
 * hands-free end-point (a silence of 700 ms after speech ends the turn).
 * Client-safe, tested without a browser.
 */

/** The « say » field of a ```mo answer as far as it has streamed: its text so far, and whether its closing quote arrived. */
export function sayProgress(stream: string): { text: string; complete: boolean } | null {
  const m = stream.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)("?)/);
  if (!m) return null;
  let text = m[1];
  try { text = String(JSON.parse(`"${m[1]}"`)); } catch { /* an escape cut in half: keep the raw text */ }
  return { text, complete: m[2] === '"' };
}

/** A text split in sentences (. ! ? … or a newline), each with its trailing mark; a trailing fragment without a mark is kept last. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?…\n]+[.!?…]+(?=\s|$)|[^.!?…\n]+(?:\n|$)/g;
  for (const m of text.matchAll(re)) { const s = m[0].trim(); if (s) out.push(s); }
  return out;
}

/** True when the sentence ends with a mark (it is complete, it can be said now). */
export const sentenceComplete = (s: string) => /[.!?…]$/.test(s.trim());

/**
 * What can be said now of a streaming « say », given what was already said:
 * the complete sentences not yet spoken (and the last fragment too once the
 * field is complete). `spoken` = the number of sentences already handed out.
 */
export function nextSentences(progress: { text: string; complete: boolean }, spoken: number): { sentences: string[]; spoken: number } {
  const all = splitSentences(progress.text);
  // Abbreviations and decimals make false ends (« 12.5 », « vs. ») : a sentence shorter than 12 chars waits for the next one.
  const ready = progress.complete ? all : all.filter((s, i) => i < all.length - 1 || (sentenceComplete(s) && s.length >= 12));
  const sentences = ready.slice(spoken);
  return { sentences, spoken: spoken + sentences.length };
}

// ── Speech queue with barge-in ───────────────────────────────────────────────

export interface SpeechState { speaking: boolean; current: string | null; queue: string[]; /** Bumped by hush / begin: an utterance from an older generation must not start. */ generation: number }
export type SpeechEvent =
  | { type: "say"; text: string; replace?: boolean }
  | { type: "started" }
  | { type: "ended" }
  /** The person starts talking (begin) or asks for silence (Escape, stop): everything is dropped. */
  | { type: "hush" };

export const initialSpeech: SpeechState = { speaking: false, current: null, queue: [], generation: 0 };

/** Next state and what to start saying now (null when nothing). */
export function speechReduce(state: SpeechState, e: SpeechEvent): { state: SpeechState; start: string | null } {
  switch (e.type) {
    case "say": {
      const text = e.text.trim();
      if (!text) return { state, start: null };
      if (e.replace || (!state.speaking && !state.current)) return { state: { ...state, speaking: true, current: text, queue: [], generation: e.replace ? state.generation + 1 : state.generation }, start: text };
      return { state: { ...state, queue: [...state.queue, text] }, start: null };
    }
    case "started": return { state: { ...state, speaking: true }, start: null };
    case "ended": {
      const [next, ...rest] = state.queue;
      if (next) return { state: { ...state, speaking: true, current: next, queue: rest }, start: next };
      return { state: { ...state, speaking: false, current: null }, start: null };
    }
    case "hush": return { state: { speaking: false, current: null, queue: [], generation: state.generation + 1 }, start: null };
  }
}

// ── Hands-free end-point (VAD on the level meter) ───────────────────────────

export interface VadConfig { /** Level (0..1) above which the person is speaking. */ threshold: number; /** Silence after speech that ends the turn. */ silenceMs: number; /** Speech shorter than this is noise. */ minSpeechMs: number }
export const VAD_DEFAULT: VadConfig = { threshold: 0.12, silenceMs: 700, minSpeechMs: 250 };
export interface VadState { speechStart: number | null; lastVoice: number | null }
export const vadInitial: VadState = { speechStart: null, lastVoice: null };

/**
 * One tick of the level meter: « start » the first time the level crosses the
 * threshold, « end » after `silenceMs` of silence following at least
 * `minSpeechMs` of speech (« cancel » when the burst was shorter: noise), else null.
 */
export function vadStep(state: VadState, level: number, now: number, cfg: VadConfig = VAD_DEFAULT): { state: VadState; event: "start" | "end" | "cancel" | null } {
  const voice = level >= cfg.threshold;
  if (state.speechStart === null) {
    return voice ? { state: { speechStart: now, lastVoice: now }, event: "start" } : { state, event: null };
  }
  if (voice) return { state: { ...state, lastVoice: now }, event: null };
  if (now - (state.lastVoice ?? state.speechStart) < cfg.silenceMs) return { state, event: null };
  const spoke = (state.lastVoice ?? now) - state.speechStart >= cfg.minSpeechMs;
  return { state: vadInitial, event: spoke ? "end" : "cancel" };
}
