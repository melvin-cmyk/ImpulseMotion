"use client";

/**
 * Motion's card media frame, rebuilt from its DOM/CSS (projects.motionapp.com,
 * observed 2026-11-02):
 * - fixed frame (9:16 by default, 4:5 or 1:1 as options), 4 px inset, radius 12;
 * - the visual is never cropped: poster `object-contain` over a blurred,
 *   upscaled copy of itself that fills the empty space;
 * - Meta videos: hovering scrubs through the video with the mouse position
 *   (white scrub line), the round centre button plays inline (muted) with a
 *   circular progress ring, top-right buttons unmute and open the detail.
 * The MP4 is only requested on first hover (preload=metadata) through
 * /api/ads/video, which redirects to Meta's signed CDN file. Meta only serves
 * it when the system user can read the client's Page (same requirement as
 * Motion's "Page permissions needed"); otherwise the card keeps the poster and
 * its play button opens the detail, whose official preview plays the video.
 */

import { useRef, useState } from "react";
import { Maximize2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import type { AdSample } from "@/lib/ads-warehouse/query";
import { adImageSrc, colorFor } from "./shared";

/** Ads whose MP4 Meta refused during this session: not requested again. */
const unavailable = new Set<string>();

export type MediaRatio = "9:16" | "4:5" | "1:1";
const RATIO_CSS: Record<MediaRatio, string> = { "9:16": "1 / 1.76", "4:5": "4 / 5", "1:1": "1 / 1" };

function posterOf(ad: AdSample | null): string | undefined {
  return adImageSrc(ad);
}

/** One visual, contained over its own blurred copy. */
function ContainedImage({ src, fallbackId }: { src: string | undefined; fallbackId: string }) {
  if (!src) return <div className={`absolute inset-0 bg-gradient-to-br ${colorFor(fallbackId)}`} />;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- Meta CDN, many hosts */}
      <img src={src} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover blur-2xl scale-150 opacity-70" loading="lazy" />
      {/* eslint-disable-next-line @next/next/no-img-element -- Meta CDN, many hosts */}
      <img src={src} alt="" className="absolute inset-0 w-full h-full object-contain" loading="lazy" />
    </>
  );
}

interface Props {
  ad: AdSample | null;
  /** Several ads of a group: 2×2 collage (Motion's comparative cards). */
  ads?: AdSample[];
  ratio?: MediaRatio;
  /** Bottom-left caption, e.g. "Vidéo" or "3 annonces". */
  caption?: React.ReactNode;
  /** Top-left badge, e.g. the spend state. */
  badge?: React.ReactNode;
  onOpen?: () => void;
}

export function AdMedia({ ad, ads, ratio = "9:16", caption, badge, onOpen }: Props) {
  // Collage of DIFFERENT visuals only (a creative run in several ads is one visual).
  const seen = new Set<string>();
  const tiles = (ads ?? []).filter((a) => { const k = a.imageUrl ?? a.thumbnailUrl; if (!k || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
  const canPlay = !!ad && ad.platform === "meta" && ad.format === "Video" && !!ad.videoId && tiles.length < 2;
  return (
    <div className="relative w-full overflow-hidden rounded-2xl" style={{ aspectRatio: RATIO_CSS[ratio] }}>
      <div className="absolute inset-1 overflow-hidden rounded-xl bg-gray-950">
        {tiles.length >= 2 ? (
          <div className={`absolute inset-0 grid gap-0.5 ${tiles.length === 2 ? "grid-cols-2" : "grid-cols-2 grid-rows-2"}`}>
            {tiles.map((a, i) => (
              <div key={a.adId + i} className="relative overflow-hidden"><ContainedImage src={posterOf(a)} fallbackId={a.adId} /></div>
            ))}
          </div>
        ) : canPlay ? (
          <InlineVideo ad={ad!} onOpen={onOpen} />
        ) : ad?.format === "Text" && !ad.imageUrl && !ad.thumbnailUrl ? (
          <TextAd ad={ad} />
        ) : (
          <>
            <ContainedImage src={posterOf(ad)} fallbackId={ad?.adId ?? "x"} />
            {ad?.format === "Video" && (
              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="w-12 h-12 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center"><Play className="w-4 h-4 text-white fill-white ml-0.5" /></span>
              </span>
            )}
          </>
        )}
        {badge && <div className="absolute left-2 top-2 z-[6] pointer-events-none">{badge}</div>}
        {caption && (
          <div className="absolute left-2 bottom-2 z-[6] flex items-center gap-1 pointer-events-none">{caption}</div>
        )}
      </div>
    </div>
  );
}

/** Search text ad (Google RSA): no visual, so the ad itself, as a results page shows it. */
function TextAd({ ad }: { ad: AdSample }) {
  let host = "";
  try { host = ad.landingUrl ? new URL(ad.landingUrl).hostname.replace(/^www\./, "") : ""; } catch { /* keep empty */ }
  const title = (ad.title ?? ad.name).split(/\s*[|\n]\s*/).filter(Boolean).slice(0, 3).join(" | ");
  return (
    <div className="absolute inset-0 flex flex-col justify-center gap-2 bg-gray-900 p-4 text-left">
      <div className="text-[11px] text-gray-400">Sponsorisé{host ? ` · ${host}` : ""}</div>
      <div className="text-sm font-medium leading-snug text-sky-300 line-clamp-4">{title}</div>
      {ad.body && <div className="text-xs leading-relaxed text-gray-300 line-clamp-6">{ad.body}</div>}
    </div>
  );
}

export function MediaCaption({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "accent" }) {
  return <span className={`rounded-md bg-black/40 backdrop-blur-sm px-2 py-0.5 text-xs font-medium ${tone === "accent" ? "text-violet-200" : "text-white"}`}>{children}</span>;
}

function InlineVideo({ ad, onOpen }: { ad: AdSample; onOpen?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [armed, setArmed] = useState(false); // src set on first hover
  const [hover, setHover] = useState(false);
  const [visible, setVisible] = useState(false); // video frame shown over the poster
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [failed, setFailedState] = useState(() => unavailable.has(ad.adId));
  const setFailed = (v: boolean) => { if (v) unavailable.add(ad.adId); setFailedState(v); };
  const [scrubX, setScrubX] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  // The consultant asked to play: if the file turns out unreadable, open the large preview instead.
  const wantPlay = useRef(false);
  const poster = posterOf(ad);

  const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); e.preventDefault(); };

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    if (failed) return;
    if (!armed) setArmed(true);
    const v = ref.current;
    if (playing || !v) return;
    const box = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    setScrubX(frac * 100);
    if (v.duration && Number.isFinite(v.duration)) {
      v.currentTime = frac * v.duration;
      setVisible(true);
    }
  }

  function toggle(e: React.MouseEvent) {
    stop(e);
    const v = ref.current;
    if (failed) { onOpen?.(); return; }
    if (!v) return;
    if (!armed) setArmed(true);
    if (v.paused) {
      setScrubX(null);
      setVisible(true);
      wantPlay.current = true;
      void v.play().then(() => setPlaying(true)).catch(() => { setFailed(true); wantPlay.current = false; onOpen?.(); });
    } else {
      v.pause();
      setPlaying(false);
    }
  }

  return (
    <div
      className="absolute inset-0"
      onMouseEnter={() => setHover(true)}
      onMouseMove={onMove}
      onMouseLeave={() => { setHover(false); setScrubX(null); if (!playing) setVisible(false); }}
    >
      <ContainedImage src={poster} fallbackId={ad.adId} />
      <video
        ref={ref}
        src={armed ? `/api/ads/video?adId=${encodeURIComponent(ad.adId)}` : undefined}
        muted={muted}
        playsInline
        preload="metadata"
        className={`absolute inset-0 w-full h-full object-contain z-[2] pointer-events-none transition-opacity duration-150 ${visible && !failed ? "opacity-100" : "opacity-0"}`}
        onTimeUpdate={(e) => { const v = e.currentTarget; if (v.duration) setProgress((v.currentTime / v.duration) * 360); }}
        onEnded={() => { setPlaying(false); setProgress(0); }}
        onError={() => { setFailed(true); setVisible(false); setPlaying(false); if (wantPlay.current) { wantPlay.current = false; onOpen?.(); } }}
      />
      {scrubX !== null && visible && <div className="absolute top-0 bottom-0 z-[4] w-0.5 -translate-x-px bg-white/70 pointer-events-none" style={{ left: `${scrubX}%` }} />}
      {(
        <div className={`absolute left-1/2 top-1/2 z-[5] -translate-x-1/2 -translate-y-1/2 transition-opacity ${!playing || hover ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
          <button
            type="button"
            onClick={toggle}
            aria-label={failed ? "Voir la vidéo dans le détail" : playing ? "Mettre en pause" : "Lire la vidéo"}
            title={failed ? "Lecture dans la carte indisponible (accès à la Page du client requis) : ouvre l'aperçu officiel" : undefined}
            className="relative w-12 h-12 rounded-full bg-black/50 hover:bg-black/70 backdrop-blur-sm flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
          >
            {playing && (
              <span
                aria-hidden
                className="absolute inset-0 rounded-full pointer-events-none"
                style={{
                  background: `conic-gradient(rgb(163 230 53) 0deg ${progress}deg, transparent 0)`,
                  WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 3px), black calc(100% - 2.5px))",
                  mask: "radial-gradient(farthest-side, transparent calc(100% - 3px), black calc(100% - 2.5px))",
                }}
              />
            )}
            {playing ? <Pause className="w-4 h-4 text-white fill-white" /> : <Play className="w-4 h-4 text-white fill-white ml-0.5" />}
          </button>
        </div>
      )}
      <div className={`absolute right-2 top-2 z-[5] flex gap-2 transition-opacity ${hover ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
        {!failed && (
          <button type="button" onClick={(e) => { stop(e); setMuted((m) => !m); }} aria-label={muted ? "Activer le son" : "Couper le son"} className="w-8 h-8 rounded-full bg-black/50 hover:bg-black/70 backdrop-blur-sm flex items-center justify-center">
            {muted ? <VolumeX className="w-4 h-4 text-white" /> : <Volume2 className="w-4 h-4 text-white" />}
          </button>
        )}
        {onOpen && (
          <button type="button" onClick={(e) => { stop(e); onOpen(); }} aria-label="Ouvrir la créa" className="w-8 h-8 rounded-full bg-black/50 hover:bg-black/70 backdrop-blur-sm flex items-center justify-center">
            <Maximize2 className="w-4 h-4 text-white" />
          </button>
        )}
      </div>
    </div>
  );
}
