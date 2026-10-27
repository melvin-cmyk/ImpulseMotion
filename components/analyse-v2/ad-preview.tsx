"use client";

/**
 * Preview pane of the drawer: the official Meta preview of the ad per
 * placement (Feed, Instagram, Story, Reels), which plays the video, with the
 * sharp thumbnail while it loads and as a fallback. A directly readable MP4
 * (rare) is played natively instead.
 */

import { useEffect, useState } from "react";
import { Loader2, Maximize2, X } from "lucide-react";
import type { AdSample } from "@/lib/ads-warehouse/query";
import { AdVisual, FormatBadge } from "./shared";

const FORMATS: Array<{ id: string; label: string }> = [
  { id: "MOBILE_FEED_STANDARD", label: "Feed" },
  { id: "INSTAGRAM_STANDARD", label: "Instagram" },
  { id: "INSTAGRAM_STORY", label: "Story" },
  { id: "INSTAGRAM_REELS", label: "Reels" },
];

interface Preview { src: string | null; width: number | null; height: number | null; videoUrl: string | null }

export function AdPreviewPane({ ad }: { ad: AdSample }) {
  const [format, setFormat] = useState(FORMATS[0].id);
  const [state, setState] = useState<{ key: string; preview: Preview | null; error: string | null } | null>(null);
  const key = `${ad.adId}:${format}`;
  const current = state && state.key === key ? state : null;

  useEffect(() => {
    if (ad.platform !== "meta") return;
    let cancelled = false;
    fetch(`/api/ads/preview?adId=${encodeURIComponent(ad.adId)}&format=${format}`)
      .then(async (r) => (r.ok ? ((await r.json()) as Preview) : Promise.reject(new Error((await r.json().catch(() => ({}))).error ?? `Erreur ${r.status}`))))
      .then((p) => { if (!cancelled) setState({ key, preview: p, error: null }); })
      .catch((e: Error) => { if (!cancelled) setState({ key, preview: null, error: e.message }); });
    return () => { cancelled = true; };
  }, [ad.adId, ad.platform, format, key]);

  const p = current?.preview ?? null;
  const ratio = p?.width && p.height ? p.width / p.height : 0.56;
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const media = (cls: string) => (
    p?.videoUrl ? (
      <video src={p.videoUrl} controls autoPlay={full} playsInline className={`${cls} object-contain bg-black`} poster={ad.imageUrl ?? ad.thumbnailUrl ?? undefined} />
    ) : p?.src ? (
      <iframe src={p.src} title="Aperçu de l'annonce" className={`${cls} border-0 bg-white`} allow="autoplay; encrypted-media; fullscreen" />
    ) : null
  );

  return (
    <div className="space-y-2">
      <div className="flex gap-1 items-center">
        {FORMATS.map((f) => (
          <button key={f.id} type="button" onClick={() => setFormat(f.id)} className={`rounded-md px-2 py-0.5 text-[11px] ${format === f.id ? "bg-violet-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`}>{f.label}</button>
        ))}
        <button type="button" onClick={() => setFull(true)} className="ml-auto inline-flex items-center gap-1 rounded-md border border-gray-800 bg-gray-900 px-2 py-0.5 text-[11px] text-gray-300 hover:text-white hover:border-violet-500/50" title="Afficher l'annonce en grand (Échap pour fermer)"><Maximize2 className="w-3 h-3" /> Tout afficher</button>
      </div>
      {full && (
        <div className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-6" onClick={() => setFull(false)}>
          <button type="button" onClick={() => setFull(false)} className="absolute top-4 right-4 p-2 rounded-md bg-gray-900 text-gray-300 hover:text-white" aria-label="Fermer"><X className="w-5 h-5" /></button>
          <div className="relative rounded-2xl overflow-hidden bg-gray-950 border border-gray-800 shadow-2xl" style={{ height: "92vh", aspectRatio: String(ratio), maxWidth: "92vw" }} onClick={(e) => e.stopPropagation()}>
            {media("w-full h-full") ?? <AdVisual ad={ad} className="h-full" />}
          </div>
        </div>
      )}
      <div className="relative rounded-xl overflow-hidden bg-gray-950 border border-gray-800" style={{ aspectRatio: String(ratio) }}>
        {media("w-full h-full") ?? (
          <>
            <AdVisual ad={ad} className="h-full" />
            <FormatBadge ad={ad} />
            <div className="absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1 text-[11px] text-gray-200 flex items-center gap-1">
              {!current ? <><Loader2 className="w-3 h-3 animate-spin" /> Aperçu en cours de chargement…</> : current.error ? `Aperçu indisponible : ${current.error}` : "Aperçu indisponible pour ce format"}
            </div>
          </>
        )}
      </div>
      <div className="text-[10px] text-gray-600">Aperçu officiel Meta, tel que diffusé. Si la vidéo ne démarre pas, clique dans l&apos;aperçu.</div>
    </div>
  );
}
