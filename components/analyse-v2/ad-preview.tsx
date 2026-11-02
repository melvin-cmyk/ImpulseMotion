"use client";

/**
 * Large preview of a creative — the left stage of the creative modal (Motion's
 * "Creative details"): the ad as big as the screen allows.
 * - Meta: the official placement preview (Feed, Instagram, Story, Reels),
 *   which plays the video; a directly readable MP4 is played natively instead.
 * - Google: YouTube player for video ads, the visual otherwise.
 * - TikTok / others: the visual (no embeddable preview for ad videos).
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { AdSample } from "@/lib/ads-warehouse/query";
import { adImageSrc } from "./shared";

const FORMATS: Array<{ id: string; label: string }> = [
  { id: "MOBILE_FEED_STANDARD", label: "Feed" },
  { id: "INSTAGRAM_STANDARD", label: "Instagram" },
  { id: "INSTAGRAM_STORY", label: "Story" },
  { id: "INSTAGRAM_REELS", label: "Reels" },
];

interface Preview { src: string | null; width: number | null; height: number | null; videoUrl: string | null }

/** The visual alone, contained over its blurred copy, filling the stage. */
function StageImage({ ad, note }: { ad: AdSample; note?: string }) {
  const src = adImageSrc(ad);
  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl bg-gray-900">
      {src && <>
        {/* eslint-disable-next-line @next/next/no-img-element -- platform CDNs */}
        <img src={src} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover blur-3xl scale-125 opacity-40" />
        {/* eslint-disable-next-line @next/next/no-img-element -- platform CDNs */}
        <img src={src} alt="" className="absolute inset-0 w-full h-full object-contain" />
      </>}
      {note && <div className="absolute inset-x-0 bottom-0 bg-black/60 px-3 py-2 text-xs text-gray-200">{note}</div>}
    </div>
  );
}

function youtubeId(ad: AdSample): string | null {
  if (ad.platform !== "google") return null;
  if (ad.videoId && /^[\w-]{11}$/.test(ad.videoId)) return ad.videoId;
  return ad.previewUrl?.match(/[?&]v=([\w-]{11})/)?.[1] ?? null;
}

export function AdStage({ ad }: { ad: AdSample }) {
  const yt = youtubeId(ad);
  if (ad.platform === "meta") return <MetaStage ad={ad} />;
  if (yt) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <iframe src={`https://www.youtube-nocookie.com/embed/${yt}?rel=0&modestbranding=1`} title="Vidéo YouTube de l'annonce" className="h-full max-h-full w-full max-w-full rounded-xl border-0 bg-black" style={{ aspectRatio: "16 / 9", height: "auto" }} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
      </div>
    );
  }
  const note = ad.format === "Video" ? (ad.platform === "tiktok" ? "TikTok ne permet pas de lire ses vidéos publicitaires en dehors de son gestionnaire de publicités : image de couverture." : "Vidéo non lisible ici : image de couverture.") : undefined;
  return <div className="h-full w-full flex items-center justify-center"><div className="h-full" style={{ aspectRatio: "9 / 16", maxWidth: "100%" }}><StageImage ad={ad} note={note} /></div></div>;
}

function MetaStage({ ad }: { ad: AdSample }) {
  const [format, setFormat] = useState(FORMATS[0].id);
  const [state, setState] = useState<{ key: string; preview: Preview | null; error: string | null } | null>(null);
  const key = `${ad.adId}:${format}`;
  const current = state && state.key === key ? state : null;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/ads/preview?adId=${encodeURIComponent(ad.adId)}&format=${format}`)
      .then(async (r) => (r.ok ? ((await r.json()) as Preview) : Promise.reject(new Error((await r.json().catch(() => ({}))).error ?? `Erreur ${r.status}`))))
      .then((p) => { if (!cancelled) setState({ key, preview: p, error: null }); })
      .catch((e: Error) => { if (!cancelled) setState({ key, preview: null, error: e.message }); });
    return () => { cancelled = true; };
  }, [ad.adId, format, key]);

  const p = current?.preview ?? null;
  const ratio = p?.videoUrl ? null : p?.width && p.height ? p.width / p.height : null;

  return (
    <div className="h-full w-full flex flex-col items-center gap-3 min-h-0">
      <div className="flex gap-1 shrink-0">
        {FORMATS.map((f) => (
          <button key={f.id} type="button" onClick={() => setFormat(f.id)} className={`rounded-full px-3 py-1 text-xs ${format === f.id ? "bg-white text-gray-900" : "bg-gray-800 text-gray-300 hover:text-white"}`}>{f.label}</button>
        ))}
      </div>
      <div className="flex-1 min-h-0 w-full flex items-center justify-center">
        {!current ? (
          <div className="h-full" style={{ aspectRatio: "9 / 16", maxWidth: "100%" }}>
            <div className="relative h-full"><StageImage ad={ad} /><div className="absolute inset-0 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-white/80" /></div></div>
          </div>
        ) : p?.videoUrl ? (
          <video src={p.videoUrl} controls autoPlay playsInline className="h-full max-w-full rounded-xl bg-black object-contain" poster={adImageSrc(ad)} />
        ) : p?.src ? (
          <iframe src={p.src} title="Aperçu officiel de l'annonce" className="h-full max-w-full rounded-xl border-0 bg-white" style={{ aspectRatio: String(ratio ?? 0.56) }} allow="autoplay; encrypted-media; fullscreen" />
        ) : (
          <div className="h-full" style={{ aspectRatio: "9 / 16", maxWidth: "100%" }}>
            <StageImage ad={ad} note={current.error ? `Aperçu Meta indisponible : ${current.error}` : "Pas d'aperçu Meta pour cet emplacement : essaie un autre format."} />
          </div>
        )}
      </div>
      <div className="shrink-0 text-[11px] text-gray-500">Aperçu officiel Meta, tel que diffusé. Clique dans l&apos;aperçu pour lancer la vidéo.</div>
    </div>
  );
}
