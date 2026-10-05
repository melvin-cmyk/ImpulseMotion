/**
 * Studio créa — images and videos generated with Agnes AI for the ads of the
 * agency's clients (staff only).
 *
 * The key and the calls stay on the relay (server/agnes.mjs): the app only
 * asks the relay, saves a CreativeAsset, and follows a video until it is
 * ready. Each generated file is also copied on the relay's disk; downloads go
 * through /api/studio/assets/[id]/file so they keep working if Agnes' own
 * link expires.
 *
 * What is sent to Agnes is the consultant's prompt and the images they choose
 * — no figure, no account data.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { relayHeaders } from "@/lib/relay-headers";
import { RELAY_URLS } from "@/lib/relay-server";

export const IMAGE_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2"] as const;
export const VIDEO_RATIOS = ["9:16", "1:1", "3:4", "4:3", "16:9"] as const;
export const VIDEO_SECONDS = { min: 4, max: 12, default: 5 } as const;

/** « Rapide » (720p, free for now) or « HD » (1080p, paid by the second). */
export const VIDEO_QUALITIES = {
  fast: { model: "agnes-video-2.5-flash", size: "720P", usdPerSecond: 0 },
  hd: { model: "agnes-video-2.5", size: "1080P", usdPerSecond: 0.04 },
} as const;
export type VideoQuality = keyof typeof VIDEO_QUALITIES;

/** Paid HD seconds the whole team may generate over 24 hours (STUDIO_HD_SECONDS_PER_DAY, 120 by default ≈ 5 $). */
export const hdSecondsPerDay = () => {
  const n = Number(process.env.STUDIO_HD_SECONDS_PER_DAY);
  return Number.isFinite(n) && n >= 0 ? n : 120;
};

export const RATIO_LABEL: Record<string, string> = {
  "1:1": "Carré 1:1 (feed)", "3:4": "Portrait 3:4", "4:3": "Paysage 4:3", "9:16": "Vertical 9:16 (stories, reels)",
  "16:9": "Paysage 16:9 (YouTube, display)", "2:3": "Portrait 2:3", "3:2": "Paysage 3:2",
};

export const promptOk = (p: unknown): p is string => typeof p === "string" && p.trim().length >= 3 && p.length <= 4000;
export const dataUriOk = (s: unknown): s is string => typeof s === "string" && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length < 14_000_000;

// ── Relay ────────────────────────────────────────────────────────────────

async function relay<T>(path: string, init: { method: "GET" | "POST"; body?: unknown }, timeoutMs: number): Promise<T> {
  let last: Error | null = null;
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}${path}`, {
        method: init.method,
        headers: relayHeaders(),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(url.includes("localhost") && RELAY_URLS.length > 1 ? Math.min(timeoutMs, 3000) : timeoutMs),
      });
      const json = (await res.json().catch(() => ({}))) as T & { error?: string };
      // The relay answered: its verdict is final (a refused prompt is not retried elsewhere).
      if (!res.ok) throw Object.assign(new Error(json.error ?? `relay ${res.status}`), { final: res.status < 500 || res.status === 502 || res.status === 503 });
      return json;
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
      if ((last as Error & { final?: boolean }).final) throw last;
    }
  }
  throw last ?? new Error("relay injoignable");
}

export interface ImageOut { url: string; file: string | null; model: string; size: string; ratio: string }
export const relayImage = (body: { prompt: string; ratio: string; size: string; images?: string[] }) =>
  relay<ImageOut>("/api/agnes/image", { method: "POST", body }, 200_000);

export interface VideoOut { videoId: string; status: string; model: string; seconds: string; size: string; aspect_ratio: string }
export const relayVideo = (body: { prompt: string; model: string; size: string; seconds: number; aspect_ratio: string; first_frame?: string }) =>
  relay<VideoOut>("/api/agnes/video", { method: "POST", body }, 60_000);

export interface PollOut { status: string; progress: number; url: string | null; file: string | null; error: string | null }
export const relayPoll = (videoId: string, model: string) =>
  relay<PollOut>(`/api/agnes/video?id=${encodeURIComponent(videoId)}&model=${encodeURIComponent(model)}`, { method: "GET" }, 30_000);

export const relayUpload = (image: string) => relay<{ file: string }>("/api/agnes/upload", { method: "POST", body: { image } }, 60_000);

// ── Signed media links (relay GET /media/<file>) ─────────────────────────

/** Same key as server/agnes.mjs: derived from the relay's shared secret. */
function mediaSignature(file: string, exp: number): string {
  const key = createHmac("sha256", process.env.RELAY_SHARED_SECRET ?? "").update("impulsemotion-media").digest();
  return createHmac("sha256", key).update(`${file}:${exp}`).digest("hex");
}

/** A link to a relay file: `base` = where the reader reaches the relay (public address for Agnes, localhost for the app). */
export function mediaUrl(base: string, file: string, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${base}/media/${encodeURIComponent(file)}?exp=${exp}&sig=${mediaSignature(file, exp)}`;
}

const FILE_RE = /^[a-z0-9_-]{6,80}\.(png|jpg|jpeg|webp|mp4)$/;

/** True when a link to `file` carries a valid, unexpired signature. */
export function verifyMediaSignature(file: string, exp: number, sig: string): boolean {
  if (!FILE_RE.test(file) || !Number.isFinite(exp) || exp < Date.now() / 1000 || !/^[a-f0-9]{64}$/.test(sig)) return false;
  const want = Buffer.from(mediaSignature(file, exp), "hex");
  return timingSafeEqual(want, Buffer.from(sig, "hex"));
}

/**
 * Where Agnes can download a file of the relay: the app's own HTTPS address
 * (/api/studio/media, Agnes refuses plain HTTP), else null.
 */
export function publicMediaUrl(file: string, ttlSeconds: number): string | null {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.NEXTAUTH_URL ?? "";
  const base = host ? (host.startsWith("http") ? host : `https://${host}`).replace(/\/$/, "") : "";
  if (!base.startsWith("https://")) return null;
  return mediaUrl(`${base}/api/studio`, file, ttlSeconds);
}

/** Estimated price of a video at generation. */
export const videoCost = (quality: VideoQuality, seconds: number) => Math.round(VIDEO_QUALITIES[quality].usdPerSecond * seconds * 1000) / 1000;
