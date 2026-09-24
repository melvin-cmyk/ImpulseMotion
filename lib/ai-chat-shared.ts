/**
 * Client-side helpers shared by the staff AI surfaces (console /ai and the
 * dashboard copilot): attachments (images downsized in the browser, documents
 * dropped in the conversation's sandbox workspace), model / effort
 * preferences, small formatters.
 */

/** Image attached to a user message: base64 (no data: prefix) + its media type. */
export interface ChatImage { mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string; name?: string }
/** File dropped by the consultant, stored in the conversation's sandbox workspace (relay). */
export interface ChatFile { name: string; path: string; bytes: number }

export const MAX_IMAGES_PER_MESSAGE = 4;
// Images are downsized in the browser so a screenshot costs ~100–300 KB and
// the whole POST stays far under Vercel's 4.5 MB body limit.
const IMAGE_MAX_EDGE = 1600;
const IMAGE_JPEG_QUALITY = 0.85;
// Vercel caps request bodies at 4.5 MB; base64 adds a third.
export const UPLOAD_MAX_BYTES = 3 * 1024 * 1024;
export const UPLOAD_EXT_RE = /\.(xlsx?|xlsm|csv|tsv|txt|md|json|pdf|docx?|pptx?)$/i;
export const UPLOAD_ACCEPT = "image/*,.xlsx,.xls,.xlsm,.csv,.tsv,.txt,.md,.json,.pdf,.doc,.docx,.ppt,.pptx";

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

export function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error(`Lecture impossible : ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** Downscale + re-encode a picked image; PNG stays PNG only when small (screenshots with text). */
export async function prepareImage(file: File): Promise<ChatImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Image illisible : ${file.name}`));
      el.src = url;
    });
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas indisponible");
    ctx.drawImage(img, 0, 0, w, h);
    const keepPng = file.type === "image/png" && file.size <= 600_000 && scale === 1;
    const mediaType: ChatImage["mediaType"] = keepPng ? "image/png" : "image/jpeg";
    const dataUrl = canvas.toDataURL(mediaType, IMAGE_JPEG_QUALITY);
    return { mediaType, data: dataUrl.slice(dataUrl.indexOf(",") + 1), name: file.name };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Note appended to the message text so the model knows where dropped files live. */
export function filesNote(files: ChatFile[]): string {
  if (!files.length) return "";
  return `\n\n[Fichiers déposés dans /work/${files.map((f) => `${f.path} (${fmtBytes(f.bytes)})`).join(", /work/")} — lis-les avec run_python]`;
}
export const FILES_NOTE_RE = /\n\n\[Fichiers déposés dans [^\]]*\]$/;

// ── Model / effort preferences ──────────────────────────────────────────────
export type AiModel = "sonnet" | "opus" | "fable";
export type AiEffort = "low" | "medium" | "high";
export interface AiPrefs { model: AiModel; effort: AiEffort; /** "auto" or a Claude Max account id of the relay pool */ account?: string }

export const MODEL_OPTIONS: Array<{ value: AiModel; label: string; hint: string }> = [
  { value: "opus", label: "Opus 5.5", hint: "Le plus fort pour orchestrer des analyses" },
  { value: "fable", label: "Fable 5.1", hint: "Le plus intelligent, consomme le plus de quota" },
  { value: "sonnet", label: "Sonnet 5", hint: "Rapide et économe" },
];
export const EFFORT_OPTIONS: Array<{ value: AiEffort; label: string; hint: string }> = [
  { value: "low", label: "Réflexion courte", hint: "Le moins cher" },
  { value: "medium", label: "Réflexion moyenne", hint: "Bon compromis pour les analyses" },
  { value: "high", label: "Réflexion longue", hint: "Le plus fort, le plus cher" },
];
export const DEFAULT_PREFS: AiPrefs = { model: "opus", effort: "low" };

export function loadPrefs(key: string): AiPrefs {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        model: MODEL_OPTIONS.some((o) => o.value === p.model) ? p.model : DEFAULT_PREFS.model,
        effort: EFFORT_OPTIONS.some((o) => o.value === p.effort) ? p.effort : DEFAULT_PREFS.effort,
        account: typeof p.account === "string" && /^[a-z0-9][a-z0-9-]{1,30}$/.test(p.account) ? p.account : "auto",
      };
    }
  } catch { /* private mode, blocked storage */ }
  return DEFAULT_PREFS;
}

export function savePrefs(key: string, prefs: AiPrefs): void {
  try { localStorage.setItem(key, JSON.stringify(prefs)); } catch { /* ignore */ }
}
