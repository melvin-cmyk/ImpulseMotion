// fal.ai — image generation for the Studio créa and the copilots, behind the relay.
//
// The API key lives only here (FAL_KEY in /etc/impulsemotion-relay.env): the app never sees
// it. Models are addressed by their fal id; the queue API is used (submit → poll → result)
// so a slow generation never holds an HTTP connection open. Every generated file is copied
// to the relay's disk (same folder and signed links as Agnes, server/agnes.mjs).
//
// Docs: https://fal.ai/docs/model-apis/model-endpoints/queue
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MEDIA_DIR } from "./agnes.mjs";

const QUEUE = "https://queue.fal.run";
export const falConfigured = () => !!process.env.FAL_KEY;

/**
 * The models the Studio offers. `refs`: accepts reference images (product shots, templates,
 * previous creatives). `ratios`: aspect ratios the model understands; others are mapped to
 * the closest. Prices are fal's public list prices (USD per image) — indicative.
 */
export const FAL_MODELS = {
  "fal-ai/flux/schnell": { label: "FLUX Schnell — très rapide, économique", refs: false, usd: 0.003, ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] },
  "fal-ai/nano-banana": { label: "Nano Banana (Google) — rapide, texte propre", refs: false, usd: 0.039, ratios: ["21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"] },
  "fal-ai/nano-banana/edit": { label: "Nano Banana Edit — à partir de vos images (produit, template)", refs: true, usd: 0.039, ratios: ["auto", "21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"] },
  "fal-ai/nano-banana-2": { label: "Nano Banana 2 (Google) — qualité supérieure, texte propre", refs: false, usd: 0.06, ratios: ["21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"] },
  "fal-ai/nano-banana-2/edit": { label: "Nano Banana 2 Edit — à partir de vos images, qualité supérieure", refs: true, usd: 0.06, ratios: ["auto", "21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"] },
  "fal-ai/flux-pro/v1.1-ultra": { label: "FLUX 1.1 Pro Ultra — photoréalisme haute définition", refs: false, usd: 0.06, ratios: ["21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16", "9:21"] },
  "fal-ai/ideogram/v3": { label: "Ideogram 3 — typographie et affiches", refs: false, usd: 0.06, ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] },
};
// Default = the model every key may use; the richer ones need the key to allow them (fal dashboard → API keys → model access).
export const DEFAULT_MODEL = process.env.FAL_DEFAULT_MODEL || "fal-ai/flux/schnell";
/** The edit model used when references are given to a text-only model (the agency's key opens nano-banana-2/edit). */
const EDIT_MODEL = process.env.FAL_EDIT_MODEL || "fal-ai/nano-banana-2/edit";
const FLUX_SIZES = { "1:1": "square_hd", "16:9": "landscape_16_9", "9:16": "portrait_16_9", "4:3": "landscape_4_3", "3:4": "portrait_4_3", "3:2": "landscape_4_3", "2:3": "portrait_4_3" };
const IDEOGRAM_SIZES = { "1:1": "square_hd", "16:9": "landscape_16_9", "9:16": "portrait_16_9", "4:3": "landscape_4_3", "3:4": "portrait_4_3", "3:2": "landscape_4_3", "2:3": "portrait_4_3" };

function ensureDir() { if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 }); }
const id = (prefix) => `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
const clean = (s, max) => (typeof s === "string" ? s.trim().slice(0, max) : "");

async function fal(path, init = {}, timeoutMs = 60_000) {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY absent du relay");
  // `path` is a queue path ("/fal-ai/…") or one of the absolute URLs fal hands back (status_url, response_url).
  const target = /^https:\/\//.test(path) ? path : `${QUEUE}${path}`;
  if (!target.startsWith(`${QUEUE}/`)) throw new Error("URL fal inattendue");
  const res = await fetch(target, { ...init, headers: { Authorization: `Key ${key}`, "Content-Type": "application/json", ...(init.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const detail = json?.detail;
    const raw = typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((d) => d?.msg || JSON.stringify(d)).join(" ; ") : json?.message || text.slice(0, 300) || `HTTP ${res.status}`;
    const fr = /does not have access to model/i.test(raw) ? `la clé fal.ai n'autorise pas ce modèle (${raw.match(/model: ([\w./-]+)/)?.[1] ?? "?"}) — à ouvrir dans le tableau de bord fal.ai, API keys`
      : res.status === 401 || res.status === 403 ? "clé fal.ai refusée" : res.status === 429 ? "trop de demandes chez fal.ai, réessayez dans une minute" : /insufficient|balance|credit/i.test(raw) ? "crédit fal.ai épuisé" : null;
    const where = target.replace(QUEUE, "").replace(/requests\/[^/]+/, "requests/…");
    const err = new Error(fr ? `${fr} (fal ${res.status} sur ${where}${raw ? ` : ${String(raw).slice(0, 160)}` : ""})` : `fal ${res.status} sur ${where} : ${raw}`);
    err.status = res.status;
    throw err;
  }
  return json ?? {};
}

async function mirror(url, base, ext) {
  try {
    ensureDir();
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = `${base}.${ext}`;
    await writeFile(join(MEDIA_DIR, name), Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
    return name;
  } catch (e) {
    console.error("[fal] copie impossible:", e.message);
    return null;
  }
}

/** Closest ratio the model accepts. */
function ratioFor(model, wanted) {
  const list = FAL_MODELS[model].ratios;
  if (list.includes(wanted)) return wanted;
  const val = (r) => { const [a, b] = r.split(":").map(Number); return a && b ? a / b : 1; };
  const w = val(wanted || "1:1");
  return list.filter((r) => r !== "auto").sort((a, b) => Math.abs(val(a) - w) - Math.abs(val(b) - w))[0] || "1:1";
}

function inputFor(model, prompt, ratio, images, n) {
  const base = { prompt, num_images: n };
  switch (model) {
    case "fal-ai/flux/schnell": return { ...base, image_size: FLUX_SIZES[ratio] || "square_hd", num_inference_steps: 4, enable_safety_checker: true };
    case "fal-ai/nano-banana": return { ...base, aspect_ratio: ratio, output_format: "png" };
    case "fal-ai/nano-banana/edit": return { ...base, image_urls: images, aspect_ratio: images.length && !ratio ? "auto" : ratio, output_format: "png" };
    case "fal-ai/nano-banana-2": return { ...base, aspect_ratio: ratio, output_format: "png" };
    case "fal-ai/nano-banana-2/edit": return { ...base, image_urls: images, aspect_ratio: images.length && !ratio ? "auto" : ratio, output_format: "png" };
    case "fal-ai/flux-pro/v1.1-ultra": return { ...base, aspect_ratio: ratio, output_format: "png", safety_tolerance: "2", ...(images[0] ? { image_url: images[0], image_prompt_strength: 0.35 } : {}) };
    case "fal-ai/ideogram/v3": return { ...base, image_size: IDEOGRAM_SIZES[ratio] || "square_hd", rendering_speed: "BALANCED", style: "AUTO" };
    default: return base;
  }
}

/**
 * { prompt, model?, ratio?, images?: string[] (data URI or https), n? (1–4) }
 * → { urls: string[], files: (string|null)[], model, ratio, requestId, seconds, usd }
 */
export async function generateImage(body) {
  const prompt = clean(body?.prompt, 4000);
  if (!prompt) throw Object.assign(new Error("prompt requis"), { status: 400 });
  let model = FAL_MODELS[body?.model] ? body.model : DEFAULT_MODEL;
  const images = Array.isArray(body?.images) ? body.images.filter((s) => typeof s === "string" && /^(data:image\/(png|jpe?g|webp);base64,|https:\/\/)/.test(s)).slice(0, 4) : [];
  // References with a text-only model: switch to the edit model that takes them (the key's, see FAL_EDIT_MODEL).
  if (images.length && !FAL_MODELS[model].refs) model = FAL_MODELS[EDIT_MODEL] ? EDIT_MODEL : "fal-ai/nano-banana-2/edit";
  const ratio = ratioFor(model, clean(body?.ratio, 10) || "1:1");
  const n = Math.min(4, Math.max(1, Math.round(Number(body?.n) || 1)));
  const t0 = Date.now();
  const submitted = await fal(`/${model}`, { method: "POST", body: JSON.stringify(inputFor(model, prompt, ratio, images, n)) });
  const requestId = submitted?.request_id;
  if (!requestId) throw new Error("fal n'a pas renvoyé d'identifiant de requête");
  // Follow-up URLs come from the submission: they name owner/app only ("fal-ai/nano-banana/requests/…"),
  // never the sub-path of the model (building them by hand returns 405).
  const statusPath = typeof submitted.status_url === "string" ? submitted.status_url : `/${model.split("/").slice(0, 2).join("/")}/requests/${encodeURIComponent(requestId)}/status`;
  const resultPath = typeof submitted.response_url === "string" ? submitted.response_url : `/${model.split("/").slice(0, 2).join("/")}/requests/${encodeURIComponent(requestId)}`;
  const deadline = Date.now() + 240_000;
  let status = submitted?.status || "IN_QUEUE";
  while (status !== "COMPLETED") {
    if (Date.now() > deadline) throw new Error("fal.ai n'a pas répondu dans le délai (4 min)");
    await new Promise((r) => setTimeout(r, 1500));
    const st = await fal(statusPath, { method: "GET" }, 30_000);
    status = st?.status || status;
    if (status === "FAILED" || st?.error) throw new Error(`fal : génération échouée${st?.error ? ` (${JSON.stringify(st.error).slice(0, 200)})` : ""}`);
  }
  const result = await fal(resultPath, { method: "GET" }, 60_000);
  const out = Array.isArray(result?.images) ? result.images.map((i) => i?.url).filter(Boolean) : [];
  if (!out.length) throw new Error("fal n'a renvoyé aucune image");
  const files = [];
  for (const url of out) files.push(await mirror(url, id("fal"), /\.jpe?g(\?|$)/i.test(url) ? "jpg" : "png"));
  return { urls: out, files, model, ratio, requestId, seconds: Math.round((Date.now() - t0) / 1000), usd: Math.round(FAL_MODELS[model].usd * out.length * 1000) / 1000 };
}
