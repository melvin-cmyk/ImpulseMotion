// Agnes AI — image and video generation for the Studio créa (staff), behind the relay.
//
// The API key lives only here (AGNES_API_KEY in /etc/impulsemotion-relay.env): the app never
// sees it. Every generated file is copied to the relay's disk (AGNES_MEDIA_DIR), so a download
// still works if Agnes' own link expires; the app streams it through /api/studio/assets/[id]/file.
//
// Uploaded reference images (to animate a photo) are written to the same folder and served by
// GET /media/<name>?exp=&sig= — an HMAC-signed, short-lived link Agnes can fetch (it requires a
// public URL for keyframes). Nothing else is served from that folder, and nothing without a
// valid signature.
//
// Docs: https://wiki.agnes-ai.com/llms.txt (images: POST /v1/images/generations;
// videos: POST /v1/videos then GET /agnesapi?video_id=&model_name=).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const API = "https://apihub.agnes-ai.com";
export const MEDIA_DIR = process.env.AGNES_MEDIA_DIR || "/root/impulsemotion-media";
const NAME_RE = /^[a-z0-9_-]{6,80}\.(png|jpg|jpeg|webp|mp4)$/;
const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4" };
const IMAGE_MODELS = new Set(["agnes-image-2.5-flash", "agnes-image-2.1-flash"]);
const VIDEO_MODELS = new Set(["agnes-video-2.5-flash", "agnes-video-2.5"]);
const IMAGE_RATIOS = new Set(["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"]);
const VIDEO_RATIOS = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);

export const agnesConfigured = () => !!process.env.AGNES_API_KEY;

function ensureDir() {
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
}

async function agnes(path, init = {}, timeoutMs = 180_000) {
  const key = process.env.AGNES_API_KEY;
  if (!key) throw new Error("AGNES_API_KEY absent du relay");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || json?.error || text.slice(0, 300) || `HTTP ${res.status}`;
    const raw = typeof msg === "string" ? msg : JSON.stringify(msg);
    // The messages a consultant will meet most, said in French.
    const fr = /queue is full/i.test(raw) ? "la file d'attente vidéo d'Agnes est pleine, réessayez dans quelques minutes"
      : /could not be downloaded/i.test(raw) ? "Agnes n'a pas pu lire l'image de départ"
      : /rate limit|too many/i.test(raw) ? "trop de demandes en même temps chez Agnes, réessayez dans une minute"
      : null;
    const err = new Error(fr ? `${fr} (Agnes ${res.status})` : `Agnes ${res.status} : ${raw}`);
    err.status = res.status;
    throw err;
  }
  return json ?? {};
}

/** Copies a generated file to the relay's disk; returns its name, or null when the copy failed (the Agnes link still works). */
async function mirror(url, base, ext) {
  try {
    ensureDir();
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = `${base}.${ext}`;
    await writeFile(join(MEDIA_DIR, name), Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
    return name;
  } catch (e) {
    console.error("[agnes] copie impossible:", e.message);
    return null;
  }
}

const id = (prefix) => `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
const clean = (s, max) => (typeof s === "string" ? s.trim().slice(0, max) : "");

/** { prompt, model?, size?, ratio?, images?: string[] (data URI or https) } → { url, file, taskId } */
export async function generateImage(body) {
  const prompt = clean(body?.prompt, 4000);
  if (!prompt) throw Object.assign(new Error("prompt requis"), { status: 400 });
  const model = IMAGE_MODELS.has(body?.model) ? body.model : "agnes-image-2.5-flash";
  const size = ["1K", "2K"].includes(body?.size) ? body.size : "1K";
  const ratio = IMAGE_RATIOS.has(body?.ratio) ? body.ratio : "1:1";
  const images = Array.isArray(body?.images) ? body.images.filter((s) => typeof s === "string" && /^(data:image\/(png|jpe?g|webp);base64,|https:\/\/)/.test(s)).slice(0, 3) : [];
  const payload = { model, prompt, size, ratio, extra_body: { response_format: "url", ...(images.length ? { image: images } : {}) } };
  const json = await agnes("/v1/images/generations", { method: "POST", body: JSON.stringify(payload) });
  const url = json?.data?.[0]?.url;
  if (!url) throw new Error("Agnes n'a renvoyé aucune image");
  const file = await mirror(url, id("img"), "png");
  return { url, file, taskId: json.task_id ?? null, model, size, ratio };
}

/** { prompt, model?, seconds?, size?, aspect_ratio?, first_frame? (https or signed relay URL) } → { videoId, status } */
export async function createVideo(body) {
  const prompt = clean(body?.prompt, 4000);
  if (!prompt) throw Object.assign(new Error("prompt requis"), { status: 400 });
  const model = VIDEO_MODELS.has(body?.model) ? body.model : "agnes-video-2.5-flash";
  const seconds = String(Math.min(12, Math.max(4, Math.round(Number(body?.seconds) || 5))));
  const size = model === "agnes-video-2.5" && ["720P", "1080P"].includes(body?.size) ? body.size : "720P";
  const aspect_ratio = VIDEO_RATIOS.has(body?.aspect_ratio) ? body.aspect_ratio : "16:9";
  const first = typeof body?.first_frame === "string" && /^https?:\/\//.test(body.first_frame) ? body.first_frame : null;
  const payload = { model, prompt, seconds, size, aspect_ratio, mode: first ? "keyframe" : "text", ...(first ? { first_frame: first } : {}) };
  const json = await agnes("/v1/videos", { method: "POST", body: JSON.stringify(payload) }, 60_000);
  if (!json?.video_id) throw new Error("Agnes n'a renvoyé aucun identifiant de vidéo");
  return { videoId: json.video_id, taskId: json.task_id ?? null, status: json.status ?? "queued", model, seconds, size, aspect_ratio };
}

/** → { status, progress, url, file, error } ; the finished video is copied once. */
export async function pollVideo(videoId, model) {
  if (!/^(video|task)_[A-Za-z0-9_-]{4,80}$/.test(videoId || "")) throw Object.assign(new Error("video_id invalide"), { status: 400 });
  const m = VIDEO_MODELS.has(model) ? model : "agnes-video-2.5-flash";
  const json = await agnes(`/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(m)}`, { method: "GET" }, 30_000);
  const status = json?.status ?? "in_progress";
  const url = json?.url || json?.video_url || json?.data?.url || null;
  let file = null;
  if (status === "completed" && url) {
    const name = `${videoId.toLowerCase().replace(/[^a-z0-9_-]/g, "")}.mp4`;
    file = existsSync(join(MEDIA_DIR, name)) ? name : await mirror(url, name.replace(/\.mp4$/, ""), "mp4");
  }
  const error = status === "failed" ? (json?.error?.message || json?.error || json?.fail_reason || "échec de la génération") : null;
  return { status, progress: Number(json?.progress ?? 0) || 0, url, file, error: typeof error === "string" ? error : error ? JSON.stringify(error) : null };
}

/** A reference image sent by the app (data URI, ≤ 10 MB) → its file name on the relay. */
export function saveUpload(dataUri) {
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUri === "string" ? dataUri : "");
  if (!m) throw Object.assign(new Error("image invalide"), { status: 400 });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 10 * 1024 * 1024) throw Object.assign(new Error("image trop lourde (10 Mo max)"), { status: 400 });
  ensureDir();
  const name = `${id("up")}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
  writeFileSync(join(MEDIA_DIR, name), buf, { mode: 0o600 });
  return name;
}

// ── Signed links (GET /media/<name>) ─────────────────────────────────────

const mediaKey = () => createHmac("sha256", process.env.RELAY_SHARED_SECRET || "").update("impulsemotion-media").digest();
export const mediaSignature = (name, exp) => createHmac("sha256", mediaKey()).update(`${name}:${exp}`).digest("hex");

/** Serves a file of MEDIA_DIR when the link is signed and not expired; supports Range (video). */
export function serveMedia(req, res, url) {
  const name = decodeURIComponent(url.pathname.slice("/media/".length));
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") || "";
  const fail = (code) => { res.writeHead(code, { "Content-Type": "text/plain" }); res.end(String(code)); };
  if (!NAME_RE.test(name) || !Number.isFinite(exp) || exp < Date.now() / 1000 || !/^[a-f0-9]{64}$/.test(sig)) return fail(403);
  const want = Buffer.from(mediaSignature(name, exp), "hex");
  if (!timingSafeEqual(want, Buffer.from(sig, "hex"))) return fail(403);
  const path = join(MEDIA_DIR, name);
  if (!existsSync(path)) return fail(404);
  const size = statSync(path).size;
  const type = TYPES[name.split(".").pop()] || "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return fail(416);
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Cache-Control": "private, max-age=3600" });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" });
  createReadStream(path).pipe(res);
}

// ── Prompt rewriting (Agnes text model, free) ────────────────────────────
//
// The consultant writes a short request in French; image models follow a precise English brief
// much better: what to keep exactly, what to change, how to handle text, one single image.
// The rewriter sees the reference images. On any failure the request is sent as written.

const SCENES = {
  studio: "clean seamless white studio background, soft diffused key light, subtle natural shadow under the product",
  lifestyle: "warm modern lifestyle interior, natural window light, tasteful props that do not hide the product",
  outdoor: "natural outdoor setting matching the product's use, golden-hour light",
  usage: "the product in real use by a person, candid and authentic, the product clearly visible and in focus",
  seasonal: "festive seasonal setting (winter / holidays) with tasteful decor around the product",
  flatlay: "top-down flat lay on a textured surface with a few complementary items, balanced composition",
};

const REWRITE_SYSTEM = `You write prompts for an AI image/video generator used by a marketing agency to produce paid-social ad creatives.
Rewrite the user's request (often short, in French) into ONE precise English prompt. Rules:
- Output ONLY a JSON object: {"prompt": "...", "note": "..."} — "note" is one short sentence in French telling the consultant what you understood (no other text).
- If reference images are given, describe concretely what must stay IDENTICAL (subject identity, face, clothing, product shape, label, colors, packaging, logo, layout/composition) and what must change. Be explicit: "Keep ... exactly as in the reference".
- Text: if the request says NO TEXT, write: "Do not render any text, letters, numbers, logos or watermarks. Leave clean empty space <where> for a headline added later." Otherwise, if the user wants text changed, list the text currently visible in the reference and give exact replacements in quotes, keeping French spelling and accents exactly, e.g. Replace the headline "ON FAIT ÉQUIPE TOUT L'ÉTÉ" with "ON FAIT ÉQUIPE TOUT L'HIVER". Say which texts must stay unchanged. Never invent new text the user did not ask for.
- Always: "A single image with one composition — no collage, no split panels, no frames, no duplicated scenes."
- Product photography: professional commercial product shot, sharp focus on the product, true-to-life colors, the product unchanged from the reference.
- Photorealistic unless the user asks for another style. Mention the framing for the aspect ratio given.
- For a VIDEO prompt: describe subject motion, camera movement, pace and mood over a few seconds; keep the first frame's subject and composition; no text appearing.
- Keep it under 120 words.`;

/** { request, kind, mode, scene?, sceneCustom?, textless?, ratio?, images?: dataURI[] } → { prompt, note } */
export async function enhancePrompt(body) {
  const request = clean(body?.request, 2000);
  if (!request) throw Object.assign(new Error("request requis"), { status: 400 });
  const kind = body?.kind === "video" ? "video" : "image";
  const mode = ["free", "edit", "product"].includes(body?.mode) ? body.mode : "free";
  const images = Array.isArray(body?.images) ? body.images.filter((s) => typeof s === "string" && /^(data:image\/(png|jpe?g|webp);base64,|https:\/\/)/.test(s)).slice(0, 3) : [];
  const scene = SCENES[body?.scene] || clean(body?.sceneCustom, 300) || "";
  const lines = [
    `Type: ${kind}. Aspect ratio: ${clean(body?.ratio, 10) || "1:1"}.`,
    `Mode: ${mode === "product" ? "product photography" : mode === "edit" ? "edit the reference image" : "free creation"}.`,
    images.length ? `${images.length} reference image(s) attached${kind === "video" ? " (the first frame of the video)" : ""}.` : "No reference image.",
    scene ? `Scene / setting wanted: ${scene}.` : "",
    body?.textless ? "NO TEXT in the image: the agency adds the texts and the logo afterwards." : "",
    `User request (French): ${request}`,
  ].filter(Boolean).join("\n");
  const content = [{ type: "text", text: lines }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
  try {
    const json = await agnes("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "agnes-3.0-flash", max_tokens: 700, temperature: 0.3, messages: [{ role: "system", content: REWRITE_SYSTEM }, { role: "user", content }] }),
    }, 60_000);
    const text = String(json?.choices?.[0]?.message?.content ?? "");
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    const prompt = clean(parsed?.prompt, 4000);
    if (!prompt) throw new Error("réponse sans consigne");
    return { prompt, note: clean(parsed?.note, 400), enhanced: true };
  } catch (e) {
    console.error("[agnes] réécriture impossible, consigne d'origine:", e.message);
    const extra = [scene ? `Setting: ${scene}.` : "", body?.textless ? "No text, letters or logos in the image." : "", "Single image, no collage, no split panels."].filter(Boolean).join(" ");
    return { prompt: `${request}${extra ? `\n${extra}` : ""}`, note: "", enhanced: false };
  }
}
