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
    <div className="flex flex-col gap-1 bg-[#13131f] border border-white/5 rounded-xl px-3 py-3 hover:border-white/10 transition-colors">
      <span className="text-[9px] uppercase tracking-widest text-gray-500 font-bold">
        {label}
      </span>
      <span className="text-sm font-bold text-white leading-tight">{value}</span>
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
        className="relative w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-2xl border border-white/10 bg-[#0d0d14] shadow-2xl shadow-black/80"
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
        <div className="relative bg-black rounded-t-2xl overflow-hidden flex items-center justify-center w-full max-h-[70vh]">
          {isVideo && creative.videoUrl ? (
            isMetaVideo ? (
              // Portrait (9:16) for Meta videos
              <div
                className="relative w-full bg-black overflow-hidden"
                style={{ paddingTop: "177.78%", maxHeight: "70vh" }}
              >
                <video
                  src={creative.videoUrl}
                  poster={creative.thumbnailUrl}
                  controls
                  crossOrigin="anonymous"
                  className="absolute inset-0 w-full h-full object-contain"
                />
              </div>
            ) : (
              // Landscape (16:9) for other platforms
              <div className="relative w-full bg-black" style={{ paddingTop: "56.25%" }}>
                <video
                  src={creative.videoUrl}
                  poster={creative.thumbnailUrl}
                  controls
                  crossOrigin="anonymous"
                  className="absolute inset-0 w-full h-full object-contain"
                />
              </div>
            )
          ) : isMetaVideo ? (
            // Meta video with no direct URL — show thumbnail + external link
            <div className="relative w-full bg-black" style={{ paddingTop: "56.25%" }}>
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                {creative.thumbnailUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={creative.thumbnailUrl}
                    alt="Video thumbnail"
                    className="absolute inset-0 w-full h-full object-contain opacity-60"
                  />
                )}
                <a
                  href={`https://www.facebook.com/watch/?v=${creative.videoId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="relative z-10 flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                >
                  Voir sur Facebook
                </a>
              </div>
            </div>
          ) : creative.thumbnailUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={creative.thumbnailUrl}
              alt={creative.name}
              className="max-h-[70vh] w-auto mx-auto object-contain block"
              style={{ background: "#000" }}
            />
          ) : (
            <div
              className={`w-full bg-gradient-to-br ${creative.thumbnailColor} flex items-center justify-center`}
              style={{ minHeight: "320px" }}
            >
              <span className="text-white/30 text-6xl font-black">
                {creative.format === "Image" ? "◼" : creative.format === "Video" ? "▶" : "⊞"}
              </span>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="px-5 pb-6 pt-4 space-y-4">
          {/* Title row */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold text-white leading-snug" title={creative.name}>
                {creative.name}
              </h2>
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
                    creative.platform === "Meta"
                      ? "bg-blue-500/15 text-blue-400 border border-blue-500/25"
                      : "bg-pink-500/15 text-pink-400 border border-pink-500/25"
                  }`}
                >
                  {creative.platform}
                </span>
                <span className="text-[10px] text-gray-600 uppercase tracking-wider font-semibold">
                  {creative.format}
                </span>
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
                    creative.status === "Winner"
                      ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/25"
                      : creative.status === "Fatigued"
                      ? "bg-amber-500/15 text-amber-400 border border-amber-500/25"
                      : creative.status === "Loser"
                      ? "bg-red-500/15 text-red-400 border border-red-500/25"
                      : "bg-violet-500/15 text-violet-400 border border-violet-500/25"
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
                className="shrink-0 flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-violet-600/15 border border-violet-500/30 text-violet-400 hover:bg-violet-600/25 hover:border-violet-500/50 transition-all"
              >
                <ExternalLink className="w-3 h-3" />
                Meta Ads Manager
              </a>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-white/5" />

          {/* Metrics grid — 4 columns, Motion-style */}
          <div>
            <p className="text-[9px] uppercase tracking-widest text-gray-600 font-bold mb-2.5">
              Performance Metrics
            </p>
            <div className="grid grid-cols-4 gap-2">
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
