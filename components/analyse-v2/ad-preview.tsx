"use client";

/**
 * Preview pane of the drawer: the official Meta preview of the ad per
 * placement (Feed, Instagram, Story, Reels), which plays the video, with the
 * sharp thumbnail while it loads and as a fallback. A directly readable MP4
 * (rare) is played natively instead.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {FORMATS.map((f) => (
          <button key={f.id} type="button" onClick={() => setFormat(f.id)} className={`rounded-md px-2 py-0.5 text-[11px] ${format === f.id ? "bg-violet-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`}>{f.label}</button>
        ))}
      </div>
      <div className="relative rounded-xl overflow-hidden bg-gray-950 border border-gray-800" style={{ aspectRatio: String(ratio) }}>
        {p?.videoUrl ? (
          <video src={p.videoUrl} controls playsInline className="w-full h-full object-contain bg-black" poster={ad.imageUrl ?? ad.thumbnailUrl ?? undefined} />
        ) : p?.src ? (
          <iframe src={p.src} title="Aperçu de l'annonce" className="w-full h-full border-0 bg-white" allow="autoplay; encrypted-media; fullscreen" />
        ) : (
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
