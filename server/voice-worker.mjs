/**
 * Voice worker of the relay (child process of server/voice.mjs): loads the
 * speech models once and answers over IPC.
 *   { id, op: "stt", path }            → { id, text, ms }      Parakeet-TDT 0.6B v3 (sherpa-onnx, int8, 25 languages)
 *   { id, op: "tts", text, speaker? }  → { id, path, ms, seconds }  Piper fr_FR-upmc-medium (jessica = 0, pierre = 1)
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
const TTS_DIR = path.join(MODELS, "vits-piper-fr_FR-upmc-medium");
const THREADS = Math.max(1, Number(process.env.VOICE_THREADS) || 1);

let tts = null;
let asr = null;

function loadTts() {
  if (tts) return tts;
  const t0 = Date.now();
  tts = new sherpa.OfflineTts({
    model: { vits: { model: path.join(TTS_DIR, "fr_FR-upmc-medium.onnx"), tokens: path.join(TTS_DIR, "tokens.txt"), dataDir: path.join(TTS_DIR, "espeak-ng-data") }, numThreads: THREADS, provider: "cpu", debug: 0 },
    maxNumSentences: 1,
  });
  process.send?.({ event: "loaded", what: "tts", ms: Date.now() - t0 });
  return tts;
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
  const engine = loadTts();
  const sid = speaker === "pierre" || speaker === 1 ? 1 : 0;
  const audio = engine.generate({ text, sid, speed: 1.05 });
  const out = path.join(os.tmpdir(), `mo-tts-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.wav`);
  sherpa.writeWave(out, { samples: audio.samples, sampleRate: audio.sampleRate });
  return { path: out, seconds: audio.samples.length / audio.sampleRate };
}

process.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  const { id, op } = msg;
  const t0 = Date.now();
  try {
    if (op === "preload") { loadTts(); loadAsr(); process.send?.({ id, ok: true, ms: Date.now() - t0 }); return; }
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
