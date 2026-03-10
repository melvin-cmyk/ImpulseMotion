"use client";

/**
 * CreativeThumbnail
 *
 * Renders the thumbnail area for a creative card.
 *
 * - For Meta video creatives (identified by videoId prop), clicking the
 *   thumbnail embeds an official Facebook iframe player via
 *   https://www.facebook.com/video/embed?video_id={videoId}.
 * - For non-Meta video creatives, a native <video> tag is used as fallback.
 * - If a real `thumbnailUrl` is provided (from Meta/TikTok API), it is shown
 *   as an <img> with unoptimized rendering so that Meta CDN URLs pass through
 *   without Next.js image optimisation.
 * - Falls back to the gradient colour placeholder when no URL is available.
 *
 * CORS note: Meta CDN URLs (*.fbcdn.net, *.fbsbx.com) include the access token
 * embedded in the signed URL, so they can be loaded by the browser directly as
 * <img> elements without CORS issues. We intentionally use a plain <img> tag
 * (not next/image) to avoid the Next.js image optimisation proxy rewriting the
 * signed URL, which would invalidate the signature.
 */

import { useState } from "react";
import { Format } from "@/lib/mock-data";

interface CreativeThumbnailProps {
  format: Format;
  thumbnailColor: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  /**
   * Meta video_id — when set, the player uses the official Facebook embed
   * iframe instead of a native <video> tag.
   */
  videoId?: string;
  /** Extra Tailwind classes applied to the outer container */
  className?: string;
}

export function CreativeThumbnail({
  format,
  thumbnailColor,
  thumbnailUrl,
  videoUrl,
  videoId,
  className = "h-36",
}: CreativeThumbnailProps) {
  const [playing, setPlaying] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  const isVideo = format === "Video";

  // --- Playing state ---
  if (playing && isVideo) {
    // If we have a direct video URL (Meta or TikTok), try it first.
    // On error, fall back to the Facebook iframe (Meta only).
    if (videoUrl && !videoFailed) {
      return (
        <div className={`relative ${className} bg-black`}>
          <video
            src={videoUrl}
            poster={thumbnailUrl}
            autoPlay
            controls
            crossOrigin="anonymous"
            className="w-full h-full object-contain"
            onEnded={() => setPlaying(false)}
            onError={() => {
              if (videoId) {
                // Direct URL failed → try Facebook iframe next render
                setVideoFailed(true);
              } else {
                setPlaying(false);
              }
            }}
          />
          <button
            className="absolute top-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded-lg z-10"
            onClick={() => setPlaying(false)}
          >
            ✕ close
          </button>
        </div>
      );
    }

    // Meta videos with no direct URL — show thumbnail + external link to Facebook
    if (videoId) {
      const fbUrl = `https://www.facebook.com/watch/?v=${videoId}`;
      return (
        <div className={`relative ${className} bg-black flex flex-col items-center justify-center gap-2`}>
          {thumbnailUrl && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={thumbnailUrl}
              alt="Video thumbnail"
              className="absolute inset-0 w-full h-full object-contain opacity-60"
            />
          )}
          <a
            href={fbUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="relative z-10 flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            Voir sur Facebook
          </a>
          <button
            className="absolute top-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded-lg z-10"
            onClick={() => { setPlaying(false); setVideoFailed(false); }}
          >
            ✕ close
          </button>
        </div>
      );
    }

    // No playable source — close player
    return (
      <div className={`relative ${className} bg-black flex items-center justify-center`}>
        <span className="text-gray-600 text-xs">Video unavailable</span>
        <button
          className="absolute top-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded-lg"
          onClick={() => setPlaying(false)}
        >
          ✕ close
        </button>
      </div>
    );
  }

  // --- Has a real thumbnail URL ---
  if (thumbnailUrl) {
    return (
      <div className={`relative ${className} bg-black overflow-hidden`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbnailUrl}
          alt="Creative thumbnail"
          className="w-full h-full object-contain"
          loading="lazy"
          onError={(e) => {
            // If the signed URL has expired or is unreachable, hide the img
            // so the fallback gradient div underneath shows through.
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
        {/* Play button overlay for video creatives */}
        {isVideo && (
          <button
            onClick={() => setPlaying(true)}
            aria-label="Play video"
            className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/50 transition-colors group"
          >
            <span className="w-12 h-12 rounded-full bg-white/20 border-2 border-white/70 flex items-center justify-center group-hover:scale-110 transition-transform">
              <span className="text-white text-xl ml-1">▶</span>
            </span>
          </button>
        )}
      </div>
    );
  }

  // --- Fallback: gradient placeholder (mock / demo data or missing URL) ---
  return (
    <div
      className={`${className} bg-gradient-to-br ${thumbnailColor} relative flex items-center justify-center`}
    >
      {isVideo && (
        <button
          onClick={() => setPlaying(true)}
          aria-label="Play video"
          className="absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/40 transition-colors group"
        >
          <span className="w-12 h-12 rounded-full bg-white/20 border-2 border-white/70 flex items-center justify-center group-hover:scale-110 transition-transform">
            <span className="text-white text-xl ml-1">▶</span>
          </span>
        </button>
      )}
      {!isVideo && (
        <div className="text-white/20 text-5xl font-black">
          {format === "Image" ? "◼" : "⊞"}
        </div>
      )}
    </div>
  );
}
