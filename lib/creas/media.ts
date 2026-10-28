/**
 * Pictures of the swipe file: fetched from the web (a platform thumbnail, a
 * pasted link), checked, and turned into what the generators want (data URI)
 * or what the model reads (RelayImage). Server only.
 */

import type { RelayImage } from "@/lib/relay-chat";
import { RELAY_URLS } from "@/lib/relay-server";
import { mediaUrl } from "@/lib/studio";

const MAX_BYTES = 12 * 1024 * 1024;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

/** Downloads an https image (15 s, 12 MB), or null. Private hosts are refused. */
export async function fetchImageBytes(url: string): Promise<{ buf: Buffer; mediaType: ImageMediaType } | null> {
  if (!/^https:\/\//i.test(url)) return null;
  try {
    const host = new URL(url).hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith(".internal")) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const mediaType: ImageMediaType = ct === "image/png" ? "image/png" : ct === "image/webp" ? "image/webp" : ct === "image/jpeg" || ct === "image/jpg" ? "image/jpeg" : sniff(url);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    return { buf, mediaType };
  } catch { return null; }
}

function sniff(url: string): ImageMediaType {
  const ext = url.split(/[?#]/)[0].split(".").pop()?.toLowerCase();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
}

export const toDataUri = (buf: Buffer, mediaType: ImageMediaType) => `data:${mediaType};base64,${buf.toString("base64")}`;

export function dataUriToRelayImage(dataUri: string, name?: string): RelayImage | null {
  const m = dataUri.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const mediaType = (m[1] === "image/jpg" ? "image/jpeg" : m[1]) as ImageMediaType;
  if (!TYPES.has(mediaType)) return null;
  return { mediaType, data: m[2], ...(name ? { name } : {}) };
}

/** The relay's copy of a media file, as a data URI (for the generators) — null when the relay has no such file. */
export async function mediaFileDataUri(file: string): Promise<string | null> {
  for (const base of RELAY_URLS) {
    try {
      const res = await fetch(mediaUrl(base, file, 600), { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const mediaType: ImageMediaType = ct === "image/png" ? "image/png" : ct === "image/webp" ? "image/webp" : "image/jpeg";
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) return null;
      return toDataUri(buf, mediaType);
    } catch { /* next relay */ }
  }
  return null;
}
