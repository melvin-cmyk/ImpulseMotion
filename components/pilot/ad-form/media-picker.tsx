"use client";

/**
 * Pilotage — the media of a new ad, shared by every format of « Nouvelle
 * publicité » (image, video, each card of a carousel): a visual of the Studio
 * créa (the client's first, every client on demand), an image sent now
 * (/api/pilot/ad-image → signed relay link, 24 h), or the public https address
 * of an image or an mp4. A video shows in a player (the signed link) and takes
 * a thumbnail (Meta requires one): the Studio image it was animated from, an
 * image sent now, or a Studio image chosen. Emits a MediaRef of the AdSpec v2;
 * the server checks everything again.
 */

import { useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { prepareImage } from "@/lib/ai-chat-shared";
import { looksLikeVideoUrl, type MediaRef } from "@/lib/pilot/ad-spec";
import { input, studioMediaRef, type StudioMedia } from "@/components/pilot/ad-form/shared";

/** An image of the form sent to the relay; the signed https link Meta downloads it from. */
export async function uploadAdImage(file: File): Promise<string> {
  const img = await prepareImage(file);
  const res = await fetch("/api/pilot/ad-image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: `data:${img.mediaType};base64,${img.data}` }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.imageUrl) throw new Error(j.error ?? `Erreur ${res.status}`);
  return String(j.imageUrl);
}

/** The media as the pickers and the preview show it: an image, a video's thumbnail, else the video itself. */
export function MediaThumb({ media, className }: { media: MediaRef | null | undefined; className: string }) {
  if (!media?.url) return null;
  if (media.kind === "video") return media.thumbUrl ? <img src={media.thumbUrl} alt="" className={className} /> : <video src={media.url} muted playsInline preload="metadata" className={className} />;
  return <img src={media.url} alt="" className={className} />;
}

const tile = (on: boolean) => `relative aspect-square rounded overflow-hidden border outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${on ? "border-violet-500" : "border-transparent hover:border-gray-600"}`;

export function MediaPicker({ kind, clientId, studio, value, onChange, idPrefix, compact = false }: {
  /** What the slot takes: an image, a video, or either (a carousel card). */
  kind: "image" | "video" | "any";
  clientId: string;
  /** Completed Studio assets, images and videos; null while loading. */
  studio: StudioMedia[] | null;
  value: MediaRef | null;
  onChange: (media: MediaRef | null) => void;
  /** Prefix of the ids (several pickers may be on the page). */
  idPrefix: string;
  /** Smaller grids (inside the carousel editor). */
  compact?: boolean;
}) {
  const [allClients, setAllClients] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [uploading, setUploading] = useState<"media" | "thumb" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const thumbRef = useRef<HTMLInputElement>(null);

  const takes = (a: StudioMedia) => kind === "any" || a.kind === kind;
  const usable = (studio ?? []).filter(takes);
  const ofClient = usable.filter((a) => a.clientId === clientId);
  const shown = (allClients || !ofClient.length ? usable : ofClient).slice(0, compact ? 16 : 24);
  const clientImages = (studio ?? []).filter((a) => a.kind === "image" && (a.clientId === clientId || allClients)).slice(0, 8);
  const isVideo = value?.kind === "video";

  async function upload(file: File | undefined, target: "media" | "thumb") {
    if (!file) return;
    setUploading(target);
    setError(null);
    try {
      const url = await uploadAdImage(file);
      if (target === "media") onChange({ kind: "image", url });
      else if (value) onChange({ ...value, thumbUrl: url, thumbStudioAssetId: undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(null);
    }
  }

  function pickUrl(raw: string) {
    setUrlDraft(raw);
    const url = raw.trim();
    if (!url) { if (value && !value.studioAssetId) onChange(null); return; }
    if (!/^https:\/\/[^\s]+$/i.test(url)) return;
    const video = kind === "video" || (kind === "any" && looksLikeVideoUrl(url));
    onChange(video ? { kind: "video", url, ...(isVideo && value?.thumbUrl ? { thumbUrl: value.thumbUrl, thumbStudioAssetId: value.thumbStudioAssetId } : {}) } : { kind: "image", url });
  }

  const urlLabel = kind === "video" ? "Adresse https d'un mp4" : kind === "image" ? "Adresse https d'une image" : "Adresse https d'une image ou d'un mp4";
  const emptyText = kind === "video" ? "Choisissez une vidéo du Studio ou collez l'adresse d'un mp4" : kind === "image" ? "Choisissez un visuel du Studio ou envoyez une image" : "Visuel du Studio, image envoyée ou adresse https";

  return (
    <div className="space-y-2">
      <div className={`relative ${isVideo ? "aspect-[9/16] max-h-64 mx-auto" : "aspect-square"} rounded-lg border border-gray-800 bg-gray-900 flex items-center justify-center overflow-hidden`}>
        {value?.url
          ? isVideo
            ? <video key={value.url} src={value.url} controls muted playsInline className="w-full h-full object-contain bg-black" />
            : <img src={value.url} alt="" className="w-full h-full object-cover" />
          : <span className="text-xs text-gray-500 px-3 text-center">{emptyText}</span>}
        {value?.url && (
          <button type="button" onClick={() => { onChange(null); setUrlDraft(""); }} className="absolute top-1 right-1 rounded-full bg-black/70 p-1 text-gray-300 hover:text-white" aria-label="Retirer le média"><X className="w-3.5 h-3.5" /></button>
        )}
      </div>
      {kind !== "video" && (
        <>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading !== null} className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-800 text-xs text-gray-300 hover:text-white disabled:opacity-40">
            {uploading === "media" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />} Envoyer une image
          </button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { void upload(e.target.files?.[0], "media"); e.target.value = ""; }} />
        </>
      )}
      <label htmlFor={`${idPrefix}-url`} className="block text-[11px] text-gray-500">{urlLabel}
        <input id={`${idPrefix}-url`} value={urlDraft} onChange={(e) => pickUrl(e.target.value)} className={`${input} mt-1 text-xs`} placeholder={kind === "video" ? "https://…/video.mp4" : "https://…/visuel.jpg"} />
      </label>

      <div className="flex items-center justify-between pt-1">
        <span className="text-[11px] text-gray-500">Studio créa{ofClient.length ? ` · ${allClients ? "tous les clients" : "ce client"}` : ""}</span>
        {ofClient.length > 0 && usable.length > ofClient.length && (
          <button type="button" onClick={() => setAllClients(!allClients)} className="text-[11px] text-gray-400 hover:text-white underline-offset-2 hover:underline">{allClients ? "Ce client seulement" : "Tous les clients"}</button>
        )}
      </div>
      {studio === null ? <Loader2 className="w-4 h-4 animate-spin text-gray-500" /> : shown.length === 0 ? (
        <p className="text-[11px] text-gray-600">Aucun{kind === "video" ? "e vidéo" : " visuel"} dans le Studio pour le moment.</p>
      ) : (
        <div className={`grid ${compact ? "grid-cols-6 sm:grid-cols-8" : kind === "video" ? "grid-cols-3" : "grid-cols-4"} gap-1`} role="group" aria-label="Visuels du Studio">
          {shown.map((a) => {
            const on = value?.studioAssetId === a.id;
            return (
              <button key={a.id} type="button" aria-pressed={on} title={`${a.clientName || "Sans client"} — ${a.prompt}`} onClick={() => { setUrlDraft(""); onChange(studioMediaRef(a, studio ?? [])); }}
                className={`${tile(on)} ${a.kind === "video" && kind === "video" ? "!aspect-[9/16]" : ""}`}>
                {a.kind === "video" ? <video src={a.url} muted playsInline preload="metadata" className="w-full h-full object-cover" /> : <img src={a.url} alt="" className="w-full h-full object-cover" loading="lazy" />}
                {a.kind === "video" && kind !== "video" && <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] text-white">vidéo</span>}
              </button>
            );
          })}
        </div>
      )}

      {isVideo && value && (
        <div className="space-y-1 pt-1">
          <span className="text-xs text-gray-400">Vignette <span className="text-gray-600">(obligatoire)</span></span>
          <div className="aspect-video rounded-lg border border-gray-800 bg-gray-900 flex items-center justify-center overflow-hidden">
            {value.thumbUrl ? <img src={value.thumbUrl} alt="" className="w-full h-full object-cover" /> : <span className="text-[11px] text-gray-500 px-2 text-center">Image du Studio d&apos;origine, ou envoyez une image</span>}
          </div>
          <button type="button" onClick={() => thumbRef.current?.click()} disabled={uploading !== null} className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-800 text-[11px] text-gray-300 hover:text-white disabled:opacity-40">
            {uploading === "thumb" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />} {value.thumbUrl ? "Changer la vignette" : "Envoyer une vignette"}
          </button>
          <input ref={thumbRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { void upload(e.target.files?.[0], "thumb"); e.target.value = ""; }} />
          {clientImages.length > 0 && (
            <div className="grid grid-cols-4 gap-1" role="group" aria-label="Vignette parmi les images du Studio">
              {clientImages.map((a) => (
                <button key={a.id} type="button" title={a.prompt} aria-pressed={value.thumbStudioAssetId === a.id} onClick={() => onChange({ ...value, thumbUrl: a.url, thumbStudioAssetId: a.id })} className={tile(value.thumbStudioAssetId === a.id)}>
                  <img src={a.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
