/**
 * Voice worker of the relay (child process of server/voice.mjs): loads the
 * speech models once and answers over IPC.
 *   { id, op: "stt", path }            → { id, text, ms }      Parakeet-TDT 0.6B v3 (sherpa-onnx, int8, 25 languages)
 *   { id, op: "tts", text, speaker? }  → { id, path, ms, seconds }  Piper fr_FR-siwis-medium (default, female) | upmc jessica / pierre
 * A separate process so the native addon's ~1.1 GB and any crash stay out of
 * the relay; LD_LIBRARY_PATH is set by the parent (Linux requirement).
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node");

const MODELS = process.env.VOICE_MODELS_DIR || "/opt/impulsemotion/models";
const ASR_DIR = path.join(MODELS, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8");
const THREADS = Math.max(1, Number(process.env.VOICE_THREADS) || 1);

/** Mo's voices (Piper models of sherpa-onnx): siwis = the clear female voice, default; upmc holds jessica (0) and pierre (1). */
const VOICES = {
  siwis: { dir: "vits-piper-fr_FR-siwis-medium", model: "fr_FR-siwis-medium.onnx", sid: 0 },
  jessica: { dir: "vits-piper-fr_FR-upmc-medium", model: "fr_FR-upmc-medium.onnx", sid: 0 },
  pierre: { dir: "vits-piper-fr_FR-upmc-medium", model: "fr_FR-upmc-medium.onnx", sid: 1 },
};
export const DEFAULT_VOICE = process.env.VOICE_DEFAULT && VOICES[process.env.VOICE_DEFAULT] ? process.env.VOICE_DEFAULT : "siwis";

const engines = new Map();
let asr = null;

function voiceOf(name) {
  const v = VOICES[name] ?? VOICES[DEFAULT_VOICE] ?? VOICES.siwis;
  return fs.existsSync(path.join(MODELS, v.dir, v.model)) ? v : Object.values(VOICES).find((o) => fs.existsSync(path.join(MODELS, o.dir, o.model)));
}

function loadTts(name) {
  const v = voiceOf(name);
  if (!v) throw new Error("aucune voix Piper installée");
  if (engines.has(v.dir)) return { engine: engines.get(v.dir), sid: v.sid };
  const t0 = Date.now();
  const dir = path.join(MODELS, v.dir);
  const engine = new sherpa.OfflineTts({
    model: { vits: { model: path.join(dir, v.model), tokens: path.join(dir, "tokens.txt"), dataDir: path.join(dir, "espeak-ng-data") }, numThreads: THREADS, provider: "cpu", debug: 0 },
    maxNumSentences: 1,
  });
  engines.set(v.dir, engine);
  process.send?.({ event: "loaded", what: `tts ${v.dir}`, ms: Date.now() - t0 });
  return { engine, sid: v.sid };
}

function loadAsr() {
  if (asr) return asr;
  const t0 = Date.now();
  asr = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: path.join(ASR_DIR, "encoder.int8.onnx"), decoder: path.join(ASR_DIR, "decoder.int8.onnx"), joiner: path.join(ASR_DIR, "joiner.int8.onnx") },
      tokens: path.join(ASR_DIR, "tokens.txt"), numThreads: THREADS, provider: "cpu", modelType: "nemo_transducer", debug: 0,
    },
  });
  process.send?.({ event: "loaded", what: "asr", ms: Date.now() - t0 });
  return asr;
}

function stt(wavPath) {
  const rec = loadAsr();
  const wave = sherpa.readWave(wavPath);
  const stream = rec.createStream();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
  rec.decode(stream);
  const r = rec.getResult(stream);
  return { text: String(r.text ?? "").trim(), seconds: wave.samples.length / wave.sampleRate };
}

function speak(text, speaker) {
  const { engine, sid } = loadTts(typeof speaker === "string" ? speaker : DEFAULT_VOICE);
  const audio = engine.generate({ text, sid, speed: 1.03 });
  const out = path.join(os.tmpdir(), `mo-tts-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.wav`);
  sherpa.writeWave(out, { samples: audio.samples, sampleRate: audio.sampleRate });
  return { path: out, seconds: audio.samples.length / audio.sampleRate };
}

process.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  const { id, op } = msg;
  const t0 = Date.now();
  try {
    if (op === "preload") { loadTts(DEFAULT_VOICE); loadAsr(); process.send?.({ id, ok: true, ms: Date.now() - t0 }); return; }
    if (op === "stt") {
      const r = stt(msg.path);
      try { fs.unlinkSync(msg.path); } catch { /* fine */ }
      process.send?.({ id, ok: true, text: r.text, seconds: r.seconds, ms: Date.now() - t0 });
      return;
    }
    if (op === "tts") {
      const text = String(msg.text ?? "").slice(0, 1200);
      if (!text.trim()) { process.send?.({ id, ok: false, error: "texte vide" }); return; }
      const r = speak(text, msg.speaker);
      process.send?.({ id, ok: true, path: r.path, seconds: r.seconds, ms: Date.now() - t0 });
      return;
    }
    process.send?.({ id, ok: false, error: `op inconnue ${op}` });
  } catch (e) {
    process.send?.({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

process.send?.({ event: "ready", pid: process.pid, rssMb: Math.round(process.memoryUsage().rss / 1048576) });
