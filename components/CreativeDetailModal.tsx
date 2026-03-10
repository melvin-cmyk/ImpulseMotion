"use client";

/**
 * CreativeDetailModal
 *
 * Opens a dark modal with the full creative details:
 * - Video (Facebook embed) or image at the top
 * - Complete metrics grid
 * - Creative name + ad name
 * - "View in Meta Ads Manager" button when a Meta ad ID is available
 */

import { X, ExternalLink } from "lucide-react";
import { Creative } from "@/lib/mock-data";

interface CreativeDetailModalProps {
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

function fmt(n: number, style: "currency" | "percent" | "decimal" | "x" = "decimal", digits = 2): string {
  if (n === 0 || !isFinite(n)) return "—";
  if (style === "currency") {
    if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
    return `$${n.toFixed(digits)}`;
  }
  if (style === "percent") return `${n.toFixed(digits)}%`;
  if (style === "x") return `${n.toFixed(digits)}x`;
  return n.toFixed(digits);
}

export function CreativeDetailModal({ creative, onClose }: CreativeDetailModalProps) {
  if (!creative) return null;

  const isVideo = creative.format === "Video";
  const isMetaVideo = isVideo && !!creative.videoId;

  // Computed metrics
  const cpm =
    creative.impressions > 0
      ? (creative.spend / creative.impressions) * 1000
      : 0;
  const cpc =
    creative.clicks > 0 ? creative.spend / creative.clicks : 0;
  // thumbstop ratio = 3s views / impressions (same as hookRate essentially)
  const thumbstopRatio =
    creative.impressions > 0 && creative.threeSecViews > 0
      ? (creative.threeSecViews / creative.impressions) * 100
      : creative.hookRate;

  // Meta Ads Manager URL — only for Meta creatives with a known ad id
  const metaAdsUrl =
    creative.platform === "Meta" && creative.id
      ? `https://www.facebook.com/adsmanager/manage/ads?act=${creative.campaignId ?? ""}&selected_ad_ids=${creative.id}`
      : null;

  return (
    /* Overlay */
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      {/* Panel */}
      <div
        className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-gray-800 bg-[#0a0a0f] shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 w-8 h-8 rounded-full bg-gray-800/80 hover:bg-gray-700 flex items-center justify-center transition-colors"
          aria-label="Close"
        >
          <X className="w-4 h-4 text-gray-300" />
        </button>

        {/* Media section */}
        <div className="w-full bg-black rounded-t-2xl overflow-hidden" style={{ minHeight: 240 }}>
          {isMetaVideo ? (
            <iframe
              src={`https://www.facebook.com/video/embed?video_id=${creative.videoId}`}
              className="w-full"
              style={{ height: 340, border: "none" }}
              allowFullScreen
              scrolling="no"
              allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
              title="Facebook video player"
            />
          ) : isVideo && creative.videoUrl ? (
            <video
              src={creative.videoUrl}
              poster={creative.thumbnailUrl}
              controls
              crossOrigin="anonymous"
              className="w-full"
              style={{ maxHeight: 340, objectFit: "contain" }}
            />
          ) : creative.thumbnailUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={creative.thumbnailUrl}
              alt={creative.name}
              className="w-full object-contain"
              style={{ maxHeight: 340 }}
            />
          ) : (
            <div
              className={`w-full bg-gradient-to-br ${creative.thumbnailColor} flex items-center justify-center`}
              style={{ height: 240 }}
            >
              <span className="text-white/30 text-6xl font-black">
                {creative.format === "Image" ? "◼" : creative.format === "Video" ? "▶" : "⊞"}
              </span>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Title row */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-bold text-white truncate" title={creative.name}>
                {creative.name}
              </h2>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
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
                Meta Ads Manager
              </a>
            )}
          </div>

          {/* Metrics grid */}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-gray-600 font-semibold mb-2">
              Performance Metrics
            </p>
            <div className="grid grid-cols-3 gap-2">
              <MetricCell label="Spend" value={fmt(creative.spend, "currency")} />
              <MetricCell
                label="Impressions"
                value={
                  creative.impressions >= 1000
                    ? `${(creative.impressions / 1000).toFixed(1)}k`
                    : String(creative.impressions)
                }
              />
              <MetricCell label="Clicks" value={creative.clicks >= 1000 ? `${(creative.clicks / 1000).toFixed(1)}k` : String(creative.clicks)} />
              <MetricCell label="CTR" value={fmt(creative.ctr, "percent")} />
              <MetricCell label="CPC" value={fmt(cpc, "currency")} />
              <MetricCell label="CPM" value={fmt(cpm, "currency")} />
              <MetricCell label="Hook Rate" value={creative.hookRate > 0 ? fmt(creative.hookRate, "percent") : "—"} />
              <MetricCell label="Hold Rate" value={creative.holdRate > 0 ? fmt(creative.holdRate, "percent") : "—"} />
              <MetricCell
                label="Thumbstop"
                value={thumbstopRatio > 0 ? fmt(thumbstopRatio, "percent") : "—"}
              />
              <MetricCell label="ROAS" value={creative.roas > 0 ? fmt(creative.roas, "x") : "—"} />
              <MetricCell label="Purchases" value={creative.conversions > 0 ? String(creative.conversions) : "—"} />
              <MetricCell label="CPA" value={creative.cpa > 0 ? fmt(creative.cpa, "currency") : "—"} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
