/**
 * Voice of Mo on the relay: speech-to-text and text-to-speech, free and
 * local (sherpa-onnx: Parakeet-TDT v3 for French recognition, Piper
 * fr_FR-upmc-medium for the voice). The models live in a child process
 * (server/voice-worker.mjs) started on first use — or at boot with
 * VOICE_PRELOAD=1 — and kept warm; requests are serialised (1 vCPU).
 *
 *   transcribe(buffer, mimeType) → { text, seconds, ms }   any browser recording (webm/opus, mp4/aac, ogg, wav) via ffmpeg → 16 kHz mono
 *   synthesize(text, speaker)    → { wav: Buffer, seconds, ms }
 */

import { fork } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODELS = process.env.VOICE_MODELS_DIR || "/opt/impulsemotion/models";
/** Where sherpa-onnx-node is installed (outside the app's node_modules: Vercel must not download the native addon). */
const NODE_DIR = process.env.VOICE_NODE_DIR || "/opt/impulsemotion/voice";
const IDLE_MS = Math.max(60_000, Number(process.env.VOICE_IDLE_MS) || 45 * 60_000);
const MAX_AUDIO_SECONDS = 60;

export const voiceConfigured = () =>
  fs.existsSync(path.join(MODELS, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "encoder.int8.onnx")) &&
  fs.existsSync(path.join(MODELS, "vits-piper-fr_FR-upmc-medium", "fr_FR-upmc-medium.onnx")) &&
  fs.existsSync(path.join(NODE_DIR, "node_modules", "sherpa-onnx-node"));

let worker = null;
let ready = null;
let seq = 0;
const pending = new Map();
let idleTimer = null;
let queue = Promise.resolve();

function log(msg) { console.log(`[voice] ${msg}`); }

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (worker && !pending.size) { log("arrêt du worker (inactif)"); worker.kill(); } }, IDLE_MS);
}

function startWorker() {
  if (worker) return ready;
  const libDir = path.join(NODE_DIR, "node_modules", "sherpa-onnx-linux-x64");
  const env = { ...process.env, LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"), NODE_PATH: [path.join(NODE_DIR, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(":"), VOICE_MODELS_DIR: MODELS };
  const child = fork(path.join(HERE, "voice-worker.mjs"), [], { env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  worker = child;
  ready = new Promise((resolve, reject) => {
    const onReady = (m) => { if (m?.event === "ready") { child.off("message", onReady); log(`worker prêt (pid ${m.pid})`); resolve(child); } };
    child.on("message", onReady);
    child.once("exit", (code) => { reject(new Error(`voice worker terminé (${code})`)); });
  });
  child.on("message", (m) => {
    if (m?.event === "loaded") { log(`${m.what} chargé en ${m.ms} ms`); return; }
    if (!m || typeof m.id !== "number") return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m); else p.reject(new Error(m.error || "voice worker: erreur"));
  });
  child.on("exit", (code, signal) => {
    log(`worker arrêté (${code ?? signal})`);
    for (const p of pending.values()) p.reject(new Error("voice worker arrêté"));
    pending.clear();
    worker = null; ready = null;
  });
  touch();
  return ready;
}

function call(msg, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    startWorker().then((child) => {
      const id = ++seq;
      const t = setTimeout(() => { pending.delete(id); reject(new Error("voice: délai dépassé")); }, timeoutMs);
      pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } });
      child.send({ id, ...msg });
      touch();
    }, reject);
  });
}

/** One request at a time: the single core would only thrash. */
function serial(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

/** Loads both models in the background (relay start). */
export function preload() {
  if (!voiceConfigured()) { log("modèles absents, voix désactivée"); return; }
  serial(() => call({ op: "preload" }, 180_000)).then((m) => log(`modèles préchargés en ${m.ms} ms`)).catch((e) => log(`préchargement impossible : ${e.message}`));
}

/** Browser audio → 16 kHz mono 16-bit WAV file (ffmpeg sniffs the container). */
async function toWav16k(buffer) {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const inPath = path.join(os.tmpdir(), `mo-in-${stamp}`);
  const outPath = path.join(os.tmpdir(), `mo-in-${stamp}.wav`);
  fs.writeFileSync(inPath, buffer);
  try {
    await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", inPath, "-t", String(MAX_AUDIO_SECONDS), "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", "-f", "wav", outPath], { timeout: 30_000 });
  } finally {
    try { fs.unlinkSync(inPath); } catch { /* fine */ }
  }
  return outPath;
}

export async function transcribe(buffer) {
  if (!voiceConfigured()) throw new Error("voix non configurée sur le relay (modèles ou module absents)");
  if (!buffer?.length) throw new Error("audio vide");
  const t0 = Date.now();
  const wav = await toWav16k(buffer);
  const m = await serial(() => call({ op: "stt", path: wav }));
  return { text: m.text, seconds: m.seconds, ms: Date.now() - t0 };
}

export async function synthesize(text, speaker = "pierre") {
  if (!voiceConfigured()) throw new Error("voix non configurée sur le relay (modèles ou module absents)");
  const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 1200);
  if (!clean) throw new Error("texte vide");
  const t0 = Date.now();
  const m = await serial(() => call({ op: "tts", text: clean, speaker }));
  try {
    const wav = fs.readFileSync(m.path);
    return { wav, seconds: m.seconds, ms: Date.now() - t0 };
  } finally {
    try { fs.unlinkSync(m.path); } catch { /* fine */ }
  }
}
