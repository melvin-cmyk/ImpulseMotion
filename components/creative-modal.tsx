"use client";

/**
 * CreativeModal
 *
 * Full-screen dark modal for inspecting a creative in detail.
 *
 * Features:
 * - Video player (direct URL via <video> + crossOrigin, with Facebook iframe
 *   fallback) or image at the top
 * - All key metrics: Spend, Impressions, Reach (est.), CTR, CPC, CPM,
 *   Hook Rate, Thumbstop Ratio, Hold Rate, ROAS, Conversions/Purchases
 * - Creative name + Ad ID
 * - Platform / Status badges
 * - Link to Meta Ads Manager when applicable
 * - X button and click-outside to close
 *
 * Design: dark background #0a0a0f, violet/purple accents — matches ImpulseMotion.
 */

import { useEffect, useState } from "react";
import { X, ExternalLink } from "lucide-react";
import { Creative } from "@/lib/mock-data";

interface CreativeModalProps {
  creative: Creative | null;
  onClose: () => void;
}

function MetricCell({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex flex-col gap-0.5 bg-[#111118] rounded-xl px-3 py-2.5">
      <span className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
        {label}
      </span>
      <span className="text-sm font-bold text-gray-100">{value}</span>
    </div>
  );
}

function fmt(
  n: number,
  style: "currency" | "percent" | "decimal" | "x" = "decimal",
  digits = 2
): string {
  if (n === 0 || !isFinite(n)) return "—";
  if (style === "currency") {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
    return `$${n.toFixed(digits)}`;
  }
  if (style === "percent") return `${n.toFixed(digits)}%`;
  if (style === "x") return `${n.toFixed(digits)}x`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toFixed(digits);
}

function VideoPlayer({
  videoUrl,
  thumbnailUrl,
  videoId,
}: {
  videoUrl?: string;
  thumbnailUrl?: string;
  videoId?: string;
}) {
  const [useFallback, setUseFallback] = useState(false);

  // If no direct URL, go straight to iframe fallback
  if (!videoUrl && videoId) {
    return (
      <iframe
        src={`https://www.facebook.com/video/embed?video_id=${videoId}`}
        className="w-full"
        style={{ height: 360, border: "none" }}
        allowFullScreen
        scrolling="no"
        allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
        title="Facebook video player"
      />
    );
  }

  if (videoUrl && !useFallback) {
    return (
      <video
        src={videoUrl}
        poster={thumbnailUrl}
        controls
        crossOrigin="anonymous"
        className="w-full"
        style={{ maxHeight: 360, objectFit: "contain", background: "#000" }}
        onError={() => {
          // Direct URL failed (CORS / expired) → fall back to Facebook iframe
          if (videoId) setUseFallback(true);
        }}
      />
    );
  }

  // Fallback: Facebook iframe embed
  if (videoId) {
    return (
      <iframe
        src={`https://www.facebook.com/video/embed?video_id=${videoId}`}
        className="w-full"
        style={{ height: 360, border: "none" }}
        allowFullScreen
        scrolling="no"
        allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
        title="Facebook video player"
      />
    );
  }

  // No playable source at all
  return (
    <div
      className="w-full flex items-center justify-center bg-gray-900"
      style={{ height: 240 }}
    >
      <span className="text-gray-600 text-sm">Video unavailable</span>
    </div>
  );
}

export function CreativeModal({ creative, onClose }: CreativeModalProps) {
  // Close on Escape key
  useEffect(() => {
    if (!creative) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [creative, onClose]);

  // Prevent body scroll while open
  useEffect(() => {
    if (creative) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [creative]);

  if (!creative) return null;

  const isVideo = creative.format === "Video";
  const isMetaVideo = isVideo && !!creative.videoId;

  // Computed metrics
  const cpm =
    creative.impressions > 0
      ? (creative.spend / creative.impressions) * 1000
      : 0;
  const cpc = creative.clicks > 0 ? creative.spend / creative.clicks : 0;

  // Thumbstop ratio = 3s views / impressions
  const thumbstopRatio =
    creative.impressions > 0 && creative.threeSecViews > 0
      ? (creative.threeSecViews / creative.impressions) * 100
      : creative.hookRate;

  // Estimated reach (impressions / estimated frequency of ~2.5)
  const estimatedReach = Math.round(creative.impressions / 2.5);

  // Meta Ads Manager URL
  const metaAdsUrl =
    creative.platform === "Meta" && creative.id
      ? `https://www.facebook.com/adsmanager/manage/ads?act=${creative.campaignId ?? ""}&selected_ad_ids=${creative.id}`
      : null;

  return (
    /* Overlay */
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      {/* Panel */}
      <div
        className="relative w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl border border-gray-800 bg-[#0a0a0f] shadow-2xl shadow-black/70"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-20 w-9 h-9 rounded-full bg-gray-800/90 hover:bg-gray-700 flex items-center justify-center transition-colors"
          aria-label="Close"
        >
          <X className="w-4 h-4 text-gray-300" />
        </button>

        {/* Media section */}
        <div
          className="w-full bg-black rounded-t-2xl overflow-hidden"
          style={{ minHeight: 200 }}
        >
          {isMetaVideo ? (
            /* Meta video: try direct URL first, fall back to iframe */
            <VideoPlayer
              videoUrl={creative.videoUrl}
              thumbnailUrl={creative.thumbnailUrl}
              videoId={creative.videoId}
            />
          ) : isVideo && creative.videoUrl ? (
            <video
              src={creative.videoUrl}
              poster={creative.thumbnailUrl}
              controls
              crossOrigin="anonymous"
              className="w-full"
              style={{ maxHeight: 360, objectFit: "contain", background: "#000" }}
            />
          ) : creative.thumbnailUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={creative.thumbnailUrl}
              alt={creative.name}
              className="w-full object-contain"
              style={{ maxHeight: 360, background: "#000" }}
            />
          ) : (
            <div
              className={`w-full bg-gradient-to-br ${creative.thumbnailColor} flex items-center justify-center`}
              style={{ height: 240 }}
            >
              <span className="text-white/30 text-6xl font-black">
                {creative.format === "Image"
                  ? "◼"
                  : creative.format === "Video"
                  ? "▶"
                  : "⊞"}
              </span>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="p-5 space-y-5">
          {/* Title row */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2
                className="text-base font-bold text-white truncate"
                title={creative.name}
              >
                {creative.name}
              </h2>
              {/* Ad ID */}
              <p className="text-[10px] text-gray-600 font-mono mt-0.5">
                Ad ID: {creative.id}
              </p>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {/* Platform badge */}
                <span
                  className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                    creative.platform === "Meta"
                      ? "bg-blue-900/70 text-blue-300 border border-blue-800"
                      : "bg-pink-900/70 text-pink-300 border border-pink-800"
                  }`}
                >
                  {creative.platform}
                </span>
                <span className="text-xs text-gray-500 uppercase tracking-wide">
                  {creative.format}
                </span>
                {/* Status badge */}
                <span
                  className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                    creative.status === "Winner"
                      ? "bg-green-900/60 text-green-300 border border-green-800"
                      : creative.status === "Fatigued"
                      ? "bg-orange-900/60 text-orange-300 border border-orange-800"
                      : creative.status === "Loser"
                      ? "bg-red-900/60 text-red-300 border border-red-800"
                      : "bg-blue-900/60 text-blue-300 border border-blue-800"
                  }`}
                >
                  {creative.status}
                </span>
              </div>
            </div>

            {/* Meta Ads Manager CTA */}
            {metaAdsUrl && (
              <a
                href={metaAdsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-violet-600/20 border border-violet-600/40 text-violet-300 hover:bg-violet-600/30 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Meta Ads
              </a>
            )}
          </div>

          {/* Metrics grid */}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-gray-600 font-semibold mb-2">
              Performance Metrics
            </p>
            <div className="grid grid-cols-3 gap-2">
              <MetricCell
                label="Spend"
                value={fmt(creative.spend, "currency")}
              />
              <MetricCell
                label="Impressions"
                value={fmt(creative.impressions, "decimal", 0)}
              />
              <MetricCell
                label="Reach (est.)"
                value={fmt(estimatedReach, "decimal", 0)}
              />
              <MetricCell label="CTR" value={fmt(creative.ctr, "percent")} />
              <MetricCell label="CPC" value={fmt(cpc, "currency")} />
              <MetricCell label="CPM" value={fmt(cpm, "currency")} />
              <MetricCell
                label="Hook Rate"
                value={
                  creative.hookRate > 0 ? fmt(creative.hookRate, "percent") : "—"
                }
              />
              <MetricCell
                label="Thumbstop"
                value={
                  thumbstopRatio > 0 ? fmt(thumbstopRatio, "percent") : "—"
                }
              />
              <MetricCell
                label="Hold Rate"
                value={
                  creative.holdRate > 0 ? fmt(creative.holdRate, "percent") : "—"
                }
              />
              <MetricCell
                label="ROAS"
                value={creative.roas > 0 ? fmt(creative.roas, "x") : "—"}
              />
              <MetricCell
                label="Purchases"
                value={
                  creative.conversions > 0 ? String(creative.conversions) : "—"
                }
              />
              <MetricCell
                label="CPA"
                value={creative.cpa > 0 ? fmt(creative.cpa, "currency") : "—"}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
