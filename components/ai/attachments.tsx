"use client";

/**
 * Attachments for the staff AI surfaces: images (downsized in the browser,
 * sent inline with the message) and documents (uploaded to the conversation's
 * sandbox workspace through `uploadUrl`, then read by the AI with Python).
 *
 *   const att = useAttachments({ uploadUrl: "/api/relay/files", uploadExtra: { conversationId } });
 *   <AttachButton att={att} />  <PendingAttachments att={att} />
 *   const { images, files } = att.take();  // when sending; att.restore(...) on failure
 */

import { useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from "react";
import {
  MAX_IMAGES_PER_MESSAGE, UPLOAD_ACCEPT, UPLOAD_EXT_RE, UPLOAD_MAX_BYTES,
  fmtBytes, prepareImage, readAsBase64, type ChatFile, type ChatImage,
} from "@/lib/ai-chat-shared";

export interface Attachments {
  images: ChatImage[];
  files: ChatFile[];
  uploading: string | null;
  error: string | null;
  /** Adds picked/pasted/dropped files (images queued, documents uploaded). */
  add: (files: FileList | File[]) => Promise<void>;
  removeImage: (index: number) => void;
  removeFile: (path: string) => void;
  /** Takes everything pending (clears the queue). */
  take: () => { images: ChatImage[]; files: ChatFile[] };
  restore: (images: ChatImage[], files: ChatFile[]) => void;
  clearError: () => void;
  /** Wire these on the text input / form. */
  onPaste: (e: ClipboardEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  /** Whether a send is allowed with only attachments. */
  hasPending: boolean;
  busy: boolean;
}

export function useAttachments({ uploadUrl, uploadExtra, disabled }: {
  uploadUrl: string;
  uploadExtra?: Record<string, string>;
  disabled?: boolean;
}): Attachments {
  const [images, setImages] = useState<ChatImage[]>([]);
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add(list: FileList | File[]) {
    const all = Array.from(list);
    if (!all.length || disabled) return;
    setError(null);
    const pics = all.filter((f) => f.type.startsWith("image/"));
    const docs = all.filter((f) => !f.type.startsWith("image/") && UPLOAD_EXT_RE.test(f.name));
    const other = all.length - pics.length - docs.length;
    if (other > 0) setError("Formats acceptés : images, Excel, CSV, PDF, Word, PowerPoint, texte.");
    const room = MAX_IMAGES_PER_MESSAGE - images.length;
    if (pics.length > room) setError(`${MAX_IMAGES_PER_MESSAGE} images maximum par message.`);
    const prepared: ChatImage[] = [];
    for (const f of pics.slice(0, Math.max(0, room))) {
      try { prepared.push(await prepareImage(f)); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }
    if (prepared.length) setImages((prev) => [...prev, ...prepared].slice(0, MAX_IMAGES_PER_MESSAGE));
    for (const f of docs) {
      if (f.size > UPLOAD_MAX_BYTES) {
        setError(`${f.name} dépasse ${fmtBytes(UPLOAD_MAX_BYTES)} — pour un gros tableur, partagez-le en Google Sheet.`);
        continue;
      }
      setUploading(f.name);
      try {
        const data = await readAsBase64(f);
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(uploadExtra ?? {}), name: f.name, data }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);
        setFiles((prev) => [...prev.filter((p) => p.path !== body.path), { name: f.name, path: body.path, bytes: body.bytes }]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(null);
      }
    }
  }

  return {
    images, files, uploading, error, add,
    removeImage: (index) => setImages((prev) => prev.filter((_, j) => j !== index)),
    removeFile: (path) => setFiles((prev) => prev.filter((p) => p.path !== path)),
    take: () => { const out = { images, files }; setImages([]); setFiles([]); return out; },
    restore: (im, fi) => { setImages(im); setFiles(fi); },
    clearError: () => setError(null),
    onPaste: (e) => {
      const list = Array.from(e.clipboardData?.files ?? []);
      if (list.length && !disabled) { e.preventDefault(); void add(list); }
    },
    onDrop: (e) => { e.preventDefault(); if (!disabled) void add(e.dataTransfer.files); },
    onDragOver: (e) => { e.preventDefault(); },
    hasPending: images.length > 0 || files.length > 0,
    busy: !!uploading,
  };
}

export function AttachButton({ att, disabled, className }: { att: Attachments; disabled?: boolean; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={UPLOAD_ACCEPT}
        multiple
        hidden
        onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) void att.add(e.target.files); e.target.value = ""; }}
      />
      <button
        type="button"
        onClick={() => ref.current?.click()}
        disabled={disabled || att.busy}
        title="Joindre des images ou des fichiers (Excel, CSV, PDF, Word…)"
        aria-label="Joindre un fichier"
        className={className ?? "px-2.5 py-2 rounded-lg text-sm bg-gray-900 border border-gray-800 text-gray-400 hover:text-white hover:border-gray-600 disabled:opacity-50"}
      >
        📎
      </button>
    </>
  );
}

/** Chips of what will go with the next message. */
export function PendingAttachments({ att }: { att: Attachments }) {
  if (!att.hasPending && !att.uploading) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {att.files.map((f) => (
        <span key={f.path} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-gray-900 border border-gray-700 text-gray-300">
          📄 {f.name} <span className="text-gray-500">{fmtBytes(f.bytes)}</span>
          <button type="button" aria-label="Retirer le fichier" onClick={() => att.removeFile(f.path)} className="text-gray-500 hover:text-red-400 ml-1">✕</button>
        </span>
      ))}
      {att.uploading && <span className="text-[11px] text-gray-500 px-2 py-0.5">Envoi de {att.uploading}…</span>}
      {att.images.map((im, k) => (
        <div key={k} className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:${im.mediaType};base64,${im.data}`} alt={im.name ?? `Image ${k + 1}`} title={im.name} className="h-14 w-14 object-cover rounded-md border border-gray-700" />
          <button
            type="button"
            onClick={() => att.removeImage(k)}
            aria-label="Retirer l'image"
            className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-gray-800 border border-gray-600 text-gray-300 text-[10px] leading-none hover:bg-red-700"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** Thumbnails + chips shown on a sent user message. */
export function MessageAttachments({ images, files }: { images?: ChatImage[]; files?: ChatFile[] }) {
  if (!images?.length && !files?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-1.5">
      {files?.map((f) => (
        <span key={f.path} className="text-[11px] px-2 py-0.5 rounded-md bg-gray-900 border border-violet-900/60 text-gray-300" title={f.path}>
          📄 {f.name} <span className="text-gray-500">{fmtBytes(f.bytes)}</span>
        </span>
      ))}
      {images?.map((im, k) => im.data ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={k}
          src={`data:${im.mediaType};base64,${im.data}`}
          alt={im.name ?? `Image ${k + 1}`}
          title={im.name}
          className="h-16 w-16 object-cover rounded-md border border-violet-900/60"
        />
      ) : (
        // Restored from local storage without its pixels (kept small on purpose).
        <span key={k} className="text-[11px] px-2 py-0.5 rounded-md bg-gray-900 border border-violet-900/60 text-gray-400">🖼 {im.name ?? `Image ${k + 1}`}</span>
      ))}
    </div>
  );
}
