/**
 * Server-side validation of chat messages carrying attachments, shared by the
 * staff AI routes (console, dashboard copilot). The browser downsizes images
 * and the relay re-checks everything; these caps are the app's backstop
 * (Vercel bodies are capped at 4.5 MB).
 */

import type { RelayImage, RelayMessage } from "@/lib/relay-chat";

/** Metadata of documents dropped in the sandbox workspace (display only — the
 *  relay finds the files by path, the note in the message text tells the AI). */
export interface ThreadFile { name: string; path: string; bytes: number }
export type ThreadMessage = RelayMessage & { files?: ThreadFile[] };

const IMAGE_MEDIA_TYPES = new Set<RelayImage["mediaType"]>(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_B64_CHARS = 2_000_000;
const MAX_IMAGES_PER_THREAD = 12;
const MAX_FILES_PER_MESSAGE = 8;

export function sanitizeImages(raw: unknown): RelayImage[] {
  if (!Array.isArray(raw)) return [];
  const out: RelayImage[] = [];
  for (const im of raw.slice(0, MAX_IMAGES_PER_MESSAGE)) {
    const mediaType = (im as Record<string, unknown>)?.mediaType;
    const data = (im as Record<string, unknown>)?.data;
    const name = (im as Record<string, unknown>)?.name;
    if (typeof mediaType !== "string" || !IMAGE_MEDIA_TYPES.has(mediaType as RelayImage["mediaType"])) continue;
    if (typeof data !== "string" || !data || data.length > MAX_IMAGE_B64_CHARS || !/^[A-Za-z0-9+/=]+$/.test(data)) continue;
    out.push({ mediaType: mediaType as RelayImage["mediaType"], data, ...(typeof name === "string" ? { name: name.slice(0, 120) } : {}) });
  }
  return out;
}

export function sanitizeFiles(raw: unknown): ThreadFile[] {
  if (!Array.isArray(raw)) return [];
  const out: ThreadFile[] = [];
  for (const f of raw.slice(0, MAX_FILES_PER_MESSAGE)) {
    const name = (f as Record<string, unknown>)?.name;
    const path = (f as Record<string, unknown>)?.path;
    const bytes = (f as Record<string, unknown>)?.bytes;
    if (typeof name !== "string" || typeof path !== "string" || !/^uploads\/[A-Za-z0-9._ \-()]{1,120}$/.test(path)) continue;
    out.push({ name: name.slice(0, 120), path, bytes: typeof bytes === "number" && bytes >= 0 ? Math.floor(bytes) : 0 });
  }
  return out;
}

/**
 * Validates a thread: roles, text length, attachments. Returns null when a
 * message is malformed. Only the most recent images are kept (older ones
 * would pile up in every replay).
 */
export function sanitizeThread(raw: unknown, opts: { maxMessages: number; maxChars: number }): ThreadMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const recent = raw.slice(-opts.maxMessages);
  const messages: ThreadMessage[] = [];
  for (const m of recent) {
    const role = (m as Record<string, unknown>)?.role;
    const content = (m as Record<string, unknown>)?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    const images = role === "user" ? sanitizeImages((m as Record<string, unknown>).images) : [];
    const files = role === "user" ? sanitizeFiles((m as Record<string, unknown>).files) : [];
    messages.push({ role, content: content.slice(0, opts.maxChars), ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) });
  }
  let budget = MAX_IMAGES_PER_THREAD;
  for (let i = messages.length - 1; i >= 0; i--) {
    const im = messages[i].images;
    if (!im) continue;
    if (budget <= 0) { delete messages[i].images; continue; }
    if (im.length > budget) messages[i].images = im.slice(0, budget);
    budget -= messages[i].images!.length;
  }
  return messages;
}

/** What the relay needs: role, content, images — file metadata stays in the thread. */
export function toRelayMessages(messages: ThreadMessage[]): RelayMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content, ...(m.images ? { images: m.images } : {}) }));
}
