"use client";

/**
 * CreativeThumbnail
 *
 * Renders the thumbnail area for a creative card.
 *
 * - If a real `thumbnailUrl` is provided (from Meta/TikTok API), it is shown
 *   as an <img> with unoptimized rendering so that Meta CDN URLs pass through
 *   without Next.js image optimisation (which would fail for external CDN URLs
 *   that are not yet proxied).
 * - For video creatives, clicking the thumbnail expands an inline <video> player.
 * - Falls back to the gradient colour placeholder when no URL is available
 *   (e.g. demo / mock data).
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
  /** Extra Tailwind classes applied to the outer container */
  className?: string;
}

export function CreativeThumbnail({
  format,
  thumbnailColor,
  thumbnailUrl,
  videoUrl,
  className = "h-36",
}: CreativeThumbnailProps) {
  const [playing, setPlaying] = useState(false);

  const isVideo = format === "Video";

  // --- Playing state: render inline <video> ---
  if (playing && isVideo) {
    return (
      <div className={`relative ${className} bg-black`}>
        <video
          src={videoUrl}
          poster={thumbnailUrl}
          autoPlay
          controls
          className="w-full h-full object-contain"
          onEnded={() => setPlaying(false)}
        />
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
          className="w-full h-full object-cover"
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
      <div className="text-white/20 text-5xl font-black">
        {format === "Video" ? "▶" : format === "Image" ? "◼" : "⊞"}
      </div>
    </div>
  );
}
