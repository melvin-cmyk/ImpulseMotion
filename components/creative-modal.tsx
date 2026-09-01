"use client";

/**
 * CreativeModal
 *
 * Full-screen dark modal for inspecting a creative in detail.
 *
 * Features:
 * - Video player (direct URL via <video> tag, or thumbnail + "Voir sur Facebook"
 *   button if no direct URL) or image at the top
 * - All key metrics: Spend, Impressions, Reach (real Meta reach), CTR, CPC, CPM,
 *   Hook (video plays / impressions), P25 / Hold (ThruPlay / impressions),
 *   ROAS (null-safe, "*" when estimated), Conversions, CPA — money in the
 *   account currency
 * - Creative name + Ad ID
 * - Platform / Status badges
 * - Link to Meta Ads Manager when applicable
 * - X button and click-outside to close
 * - Funnel Scores (Hook / Watch / Click / Convert)
 * - Custom Tags (saved in localStorage)
 *
 * Design: dark background #0a0a0f, violet/purple accents — matches ImpulseMotion.
 */

import { useEffect, useState, useCallback } from "react";
import { X, ExternalLink, Plus, Tag, StickyNote } from "lucide-react";
import type { Creative } from "@/lib/creative-types";
import { AudienceTagInput } from "@/components/audience-tag-input";
import { useCreativesContext } from "@/lib/creatives-context";
import { fmtMoney } from "@/lib/creative-format";
import { RoasValue } from "@/components/roas-value";
import { FUNNEL_BENCHMARKS } from "@/lib/funnel-scores";

interface CreativeModalProps {
  creative: Creative | null;
  onClose: () => void;
}

function MetricCell({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
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

/** Number formatter: a real 0 shows "0"; only null / non-finite show "—". */
function fmt(
  n: number | null | undefined,
  style: "percent" | "decimal" | "x" = "decimal",
  digits = 2
): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  if (style === "percent") return `${n.toFixed(digits)}%`;
  if (style === "x") return `${n.toFixed(digits)}x`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
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
  if (videoUrl) {
    return (
      <div className="w-full bg-black flex items-center justify-center" style={{ maxHeight: "70vh" }}>
        <video
          src={videoUrl}
          poster={thumbnailUrl}
          controls
          crossOrigin="anonymous"
          style={{ maxHeight: "70vh", maxWidth: "100%", width: "auto", height: "auto" }}
        />
      </div>
    );
  }

  // No direct video URL — embed via official Facebook iframe player
  if (videoId) {
    const embedSrc = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(`https://www.facebook.com/watch/?v=${videoId}`)}&show_text=false&allowfullscreen=true`;
    return (
      <div
        className="bg-black"
        style={{ aspectRatio: "9/16", maxHeight: "70vh", width: "auto", minWidth: "200px" }}
      >
        <iframe
          src={embedSrc}
          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
          allowFullScreen
        />
      </div>
    );
  }

  return (
    <div className="w-full flex items-center justify-center bg-gray-900" style={{ minHeight: "200px" }}>
      <span className="text-gray-600 text-sm">Video unavailable</span>
    </div>
  );
}

// ── Video Drop-off Waterfall ──────────────────────────────────────────────────

function VideoDropoff({ creative }: { creative: Creative }) {
  const steps = [
    { label: "Hook (démarrages)", value: creative.hookRate },
    { label: "25%", value: creative.videoP25Rate ?? 0 },
    { label: "50%", value: creative.videoP50Rate ?? 0 },
    { label: "75%", value: creative.videoP75Rate ?? 0 },
    { label: "100% (Thruplay)", value: creative.holdRate },
  ];

  const hasData = steps.some((s) => s.value > 0);
  if (!hasData) return null;

  const max = steps[0].value || 1;

  return (
    <div>
      <p className="text-[9px] uppercase tracking-widest text-gray-600 font-bold mb-3">
        Video Drop-off
      </p>
      <div className="bg-[#13131f] border border-white/5 rounded-xl p-4 space-y-2.5">
        {steps.map((step, i) => {
          const pct = (step.value / max) * 100;
          const dropoff =
            i > 0 && steps[i - 1].value > 0
              ? Math.round(((steps[i - 1].value - step.value) / steps[i - 1].value) * 100)
              : null;
          return (
            <div key={step.label}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-gray-400 font-medium w-28 shrink-0">{step.label}</span>
                <div className="flex-1 mx-3 h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-violet-500 transition-all duration-700"
                    style={{ width: `${pct}%`, opacity: 1 - i * 0.12 }}
                  />
                </div>
                <span className="text-white font-bold w-14 text-right">
                  {step.value > 0 ? `${step.value.toFixed(1)}%` : "—"}
                </span>
                {dropoff !== null && (
                  <span className="text-red-400 text-[10px] w-14 text-right">
                    {step.value > 0 ? `−${dropoff}%` : ""}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Funnel Score bar ──────────────────────────────────────────────────────────

interface FunnelMetric {
  label: string;
  value: number;
  benchmark: number;
  unit: string;
}

function FunnelBar({ label, value, benchmark, unit }: FunnelMetric) {
  const pct = Math.min((value / (benchmark * 2)) * 100, 100);
  const ratio = benchmark > 0 ? value / benchmark : 0;
  const color =
    ratio >= 1
      ? "bg-emerald-500"
      : ratio >= 0.6
      ? "bg-amber-500"
      : "bg-red-500";
  const textColor =
    ratio >= 1
      ? "text-emerald-400"
      : ratio >= 0.6
      ? "text-amber-400"
      : "text-red-400";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-400 font-medium">{label}</span>
        <span className={`font-bold ${textColor}`}>
          {value > 0 ? `${value.toFixed(1)}${unit}` : "—"}
        </span>
      </div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-[10px] text-gray-600">
        Benchmark: {benchmark}{unit}
      </div>
    </div>
  );
}

function FunnelScores({ creative }: { creative: Creative }) {
  // Same definitions and benchmarks as lib/funnel-scores.ts (Watch = ThruPlay / impressions).
  const roas = creative.roas !== null && !creative.roasUnavailable ? creative.roas : 0;

  return (
    <div>
      <p className="text-[9px] uppercase tracking-widest text-gray-600 font-bold mb-3">
        Funnel Scores
      </p>
      <div className="grid grid-cols-2 gap-4 bg-[#13131f] border border-white/5 rounded-xl p-4">
        <FunnelBar
          label="Hook (démarrages / impr.)"
          value={creative.hookRate}
          benchmark={FUNNEL_BENCHMARKS.hook}
          unit="%"
        />
        <FunnelBar
          label="Watch (ThruPlay / impr.)"
          value={creative.holdRate}
          benchmark={FUNNEL_BENCHMARKS.watch}
          unit="%"
        />
        <FunnelBar
          label="Click (CTR)"
          value={creative.ctr}
          benchmark={FUNNEL_BENCHMARKS.click}
          unit="%"
        />
        <FunnelBar
          label="Convert (ROAS)"
          value={roas}
          benchmark={FUNNEL_BENCHMARKS.convert}
          unit="x"
        />
      </div>
    </div>
  );
}

// ── Custom Tags ───────────────────────────────────────────────────────────────

function useCreativeTags(creativeId: string) {
  const storageKey = `impulse_tags_${creativeId}`;

  const [tags, setTags] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const addTag = useCallback(
    (tag: string) => {
      const trimmed = tag.trim();
      if (!trimmed) return;
      setTags((prev) => {
        if (prev.includes(trimmed)) return prev;
        const next = [...prev, trimmed];
        localStorage.setItem(storageKey, JSON.stringify(next));
        return next;
      });
    },
    [storageKey]
  );

  const removeTag = useCallback(
    (tag: string) => {
      setTags((prev) => {
        const next = prev.filter((t) => t !== tag);
        localStorage.setItem(storageKey, JSON.stringify(next));
        return next;
      });
    },
    [storageKey]
  );

  return { tags, addTag, removeTag };
}

/**
 * Consultant notes per creative — persisted to localStorage. Lets the consultant
 * track decisions, hypotheses, and qualitative observations next to the metrics.
 */
function useCreativeNotes(creativeId: string) {
  const [notes, setNotes] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(`impulse_notes_${creativeId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { text: string; t: number };
        setNotes(parsed.text);
        setSavedAt(parsed.t);
      } else {
        setNotes("");
        setSavedAt(null);
      }
    } catch {
      setNotes("");
    }
  }, [creativeId]);

  const save = useCallback(
    (text: string) => {
      try {
        const t = Date.now();
        localStorage.setItem(`impulse_notes_${creativeId}`, JSON.stringify({ text, t }));
        setSavedAt(t);
      } catch { /* quota exceeded — ignore */ }
    },
    [creativeId],
  );

  return { notes, setNotes, save, savedAt };
}

function CreativeNotesSection({ creativeId }: { creativeId: string }) {
  const { notes, setNotes, save, savedAt } = useCreativeNotes(creativeId);

  // Debounced autosave
  useEffect(() => {
    const handle = setTimeout(() => {
      save(notes);
    }, 600);
    return () => clearTimeout(handle);
  }, [notes, save]);

  return (
    <div>
      <p className="text-[9px] uppercase tracking-widest text-gray-600 font-bold mb-3 flex items-center gap-1.5">
        <StickyNote className="w-3 h-3" />
        Notes consultant
        {savedAt && (
          <span className="ml-auto text-gray-700 normal-case tracking-normal">
            sauvegardé {new Date(savedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </p>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Hypothèses, décisions, contexte… (auto-sauvegardé)"
        rows={4}
        className="w-full bg-[#13131f] border border-white/5 rounded-xl p-3 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-violet-500/50 transition-colors resize-y"
      />
    </div>
  );
}

function CustomTagsSection({ creativeId }: { creativeId: string }) {
  const { tags, addTag, removeTag } = useCreativeTags(creativeId);
  const [input, setInput] = useState("");

  function handleAdd() {
    if (input.trim()) {
      addTag(input.trim());
      setInput("");
    }
  }

  return (
    <div>
      <p className="text-[9px] uppercase tracking-widest text-gray-600 font-bold mb-3 flex items-center gap-1.5">
        <Tag className="w-3 h-3" />
        Custom Tags
      </p>
      <div className="bg-[#13131f] border border-white/5 rounded-xl p-4 space-y-3">
        {/* Input */}
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
            placeholder="Add tag (e.g. UGC, Promo50, Funnel-Top)"
            className="flex-1 bg-gray-800/60 border border-white/8 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-violet-500/50 transition-colors"
          />
          <button
            onClick={handleAdd}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-violet-600/20 border border-violet-500/30 text-violet-400 hover:bg-violet-600/30 transition-colors text-xs font-semibold"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
        </div>
        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span
                key={tag}
                className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/25"
              >
                {tag}
                <button
                  onClick={() => removeTag(tag)}
                  className="ml-0.5 hover:text-white transition-colors"
                  aria-label={`Remove tag ${tag}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {tags.length === 0 && (
          <p className="text-[11px] text-gray-600">No tags yet. Add tags to organize this creative.</p>
        )}
      </div>
    </div>
  );
}

export function CreativeModal({ creative, onClose }: CreativeModalProps) {
  const { metaAccountId, currency } = useCreativesContext();

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

  // Computed metrics (null when the denominator is missing, never invented)
  const cpm = creative.impressions > 0 ? (creative.spend / creative.impressions) * 1000 : null;
  const cpc = creative.clicks > 0 ? creative.spend / creative.clicks : null;
  const money = (v: number | null | undefined, digits = 0) => fmtMoney(v, currency, digits);

  // Meta Ads Manager URL — the account id comes from the selected account (act_…), not the campaign.
  const actId = metaAccountId ? metaAccountId.replace(/^act_/, "") : null;
  const metaAdsUrl =
    creative.platform === "Meta" && creative.id && actId
      ? `https://www.facebook.com/adsmanager/manage/ads?act=${actId}&selected_ad_ids=${creative.id}`
      : null;

  return (
    /* Overlay — softer, leaves the list partially visible behind */
    <div
      className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-[2px] animate-im-fade-in"
      onClick={onClose}
    >
      {/* Drawer — slides from the right, the list behind stays scannable */}
      <div
        className="absolute right-0 top-0 bottom-0 w-full max-w-2xl bg-[#0d0d14] border-l border-white/10 shadow-2xl shadow-black/80 flex flex-col overflow-y-auto animate-im-slide-right"
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
        <div className="relative bg-black rounded-t-2xl overflow-hidden flex items-center justify-center w-full max-h-[70vh]">
          {isVideo ? (
            <VideoPlayer
              videoUrl={creative.videoUrl}
              thumbnailUrl={creative.thumbnailUrl}
              videoId={creative.videoId}
            />
          ) : creative.thumbnailUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={creative.thumbnailUrl}
              alt={creative.name}
              className="max-h-[70vh] w-auto mx-auto object-contain block"
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
              <h2
                className="text-base font-bold text-white leading-snug"
                title={creative.name}
              >
                {creative.name}
              </h2>
              {/* Ad ID */}
              <p className="text-[10px] text-gray-600 font-mono mt-0.5">
                {creative.id}
              </p>
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                {/* Platform badge */}
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
                {/* Status badge */}
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
                Meta Ads
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
              <MetricCell label="Spend" value={money(creative.spend)} />
              <MetricCell
                label="Impressions"
                value={fmt(creative.impressions, "decimal", 0)}
              />
              <MetricCell
                label="Reach"
                value={typeof creative.reach === "number" ? fmt(creative.reach, "decimal", 0) : "—"}
              />
              <MetricCell label="CTR" value={fmt(creative.ctr, "percent")} />
              <MetricCell label="CPC" value={money(cpc, 2)} />
              <MetricCell label="CPM" value={money(cpm, 2)} />
              <MetricCell
                label="Hook (démarrages / impr.)"
                value={isVideo ? fmt(creative.hookRate, "percent") : "—"}
              />
              <MetricCell
                label="P25 / impr."
                value={isVideo && typeof creative.videoP25Rate === "number" ? fmt(creative.videoP25Rate, "percent") : "—"}
              />
              <MetricCell
                label="Hold (ThruPlay / impr.)"
                value={isVideo ? fmt(creative.holdRate, "percent") : "—"}
              />
              <MetricCell
                label="ROAS"
                value={<RoasValue value={creative.roasUnavailable ? null : creative.roas} estimated={creative.roasEstimated && !creative.roasUnavailable} />}
              />
              <MetricCell
                label="Conversions"
                value={fmt(creative.conversions, "decimal", 0)}
              />
              <MetricCell
                label="CPA"
                value={creative.cpa > 0 ? money(creative.cpa, 2) : "—"}
              />
              <MetricCell
                label="Fréquence"
                value={typeof creative.frequency === "number" ? `${creative.frequency.toFixed(2)}${typeof creative.frequencyWeekly === "number" ? ` (${creative.frequencyWeekly.toFixed(2)} / sem.)` : ""}` : "—"}
              />
              <MetricCell
                label="Clics"
                value={fmt(creative.clicks, "decimal", 0)}
              />
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-white/5" />

          {/* Video Drop-off (video ads only) */}
          {isVideo && (
            <>
              <VideoDropoff creative={creative} />
              <div className="border-t border-white/5" />
            </>
          )}

          {/* Funnel Scores */}
          <FunnelScores creative={creative} />

          {/* Divider */}
          <div className="border-t border-white/5" />

          {/* Consultant Notes */}
          <CreativeNotesSection creativeId={creative.id} />

          {/* Divider */}
          <div className="border-t border-white/5" />

          {/* Custom Tags */}
          <CustomTagsSection creativeId={creative.id} />

          {/* Divider */}
          <div className="border-t border-white/5" />

          {/* Intended Audience */}
          <AudienceTagInput creativeId={creative.id} />
        </div>
      </div>
    </div>
  );
}
