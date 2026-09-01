"use client";

import { useCreativesContext } from "@/lib/creatives-context";
import { CreativeThumbnail } from "@/components/creative-thumbnail";
import { CreativeModal } from "@/components/creative-modal";
import { DateRangePicker } from "@/components/date-range-picker";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import { AlertTriangle, TrendingDown, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { Creative } from "@/lib/creative-types";
import { PageHelp } from "@/components/ui/page-help";
import { fmtMoney, fmtRoas } from "@/lib/creative-format";
import { FATIGUE_FREQUENCY_WEEKLY } from "@/lib/creative-stats";

type CreativeItem = Creative;

// ── Thresholds (documented in the empty state below) ─────────────────────────
/** Weekly-normalised frequency (frequency × 7 / days of the range) at/above which the audience is saturated. */
const FREQUENCY_THRESHOLD = FATIGUE_FREQUENCY_WEEKLY;
/** Second-half CTR below this share of the first-half CTR = declining (Σ clicks / Σ impressions per half). */
const CTR_DECLINE_RATIO = 0.9;
/** Video hook (plays / impressions) below this = hook fatigue. */
const HOOK_THRESHOLD = 25;

/** Σ clicks / Σ impressions over a slice of the daily trend (null without impressions). */
function halfCtr(days: CreativeItem["trend"]): number | null {
  const impressions = days.reduce((s, d) => s + d.impressions, 0);
  const clicks = days.reduce((s, d) => s + d.clicks, 0);
  return impressions > 0 ? (clicks / impressions) * 100 : null;
}

/**
 * Fatigue signals from real Meta metrics:
 * - weekly frequency (frequency × 7 / range days) ≥ 3.5 → audience saturation
 * - CTR of the second half of the daily trend (Σ clicks / Σ impressions)
 *   below 90 % of the first half (up to 14 days) → declining
 * - hook (video plays / impressions) < 25 % → hook fatigue
 */
function getFatigueSignals(creative: CreativeItem): {
  highFrequency: boolean;
  ctrDecline: boolean;
  hookFatigue: boolean;
  signals: string[];
} {
  const highFrequency = typeof creative.frequencyWeekly === "number" && creative.frequencyWeekly >= FREQUENCY_THRESHOLD;

  const trend = creative.trend;
  let ctrDecline = false;
  let ctrFirst: number | null = null;
  let ctrSecond: number | null = null;
  if (trend.length >= 4) {
    const mid = Math.floor(trend.length / 2);
    ctrFirst = halfCtr(trend.slice(0, mid));
    ctrSecond = halfCtr(trend.slice(mid));
    ctrDecline = ctrFirst !== null && ctrSecond !== null && ctrFirst > 0 && ctrSecond < ctrFirst * CTR_DECLINE_RATIO;
  }

  const hookFatigue = creative.format === "Video" && creative.hookRate > 0 && creative.hookRate < HOOK_THRESHOLD;

  const signals: string[] = [];
  if (highFrequency) signals.push(`Saturation d'audience : fréquence hebdo ${creative.frequencyWeekly!.toFixed(2)} ≥ ${FREQUENCY_THRESHOLD}`);
  if (ctrDecline) signals.push(`CTR en baisse : ${ctrSecond!.toFixed(2)} % (2e moitié) vs ${ctrFirst!.toFixed(2)} % (1re moitié) sur la tendance quotidienne (jusqu'à 14 j)`);
  if (hookFatigue) signals.push(`Hook ${creative.hookRate.toFixed(1)} % < ${HOOK_THRESHOLD} % (démarrages / impressions)`);

  return { highFrequency, ctrDecline, hookFatigue, signals };
}

function getDailyTrend(creative: CreativeItem) {
  // Use real trend data — if CTR is declining, it'll show naturally
  return creative.trend.map((d) => ({
    date: d.date,
    cpa: d.cpa,
    ctr: d.impressions > 0 ? Math.round((d.clicks / d.impressions) * 10000) / 100 : creative.ctr,
    roas: d.roas,
  }));
}

/**
 * Detect fatigued creatives using real metrics (delivering ads only — a paused
 * ad is already cut):
 * - status === "Fatigued" (server-side: hook < 20 % or weekly frequency ≥ 3.5)
 * - weekly frequency ≥ 3.5
 * - CTR declining AND hook < 25 %
 */
function isFatigued(creative: CreativeItem): boolean {
  if (creative.effectiveStatus && creative.effectiveStatus !== "ACTIVE") return false;
  if (creative.status === "Fatigued") return true;
  const { highFrequency, ctrDecline, hookFatigue } = getFatigueSignals(creative);
  return highFrequency || (ctrDecline && hookFatigue);
}

function CTRTrend({ data }: { data: ReturnType<typeof getDailyTrend> }) {
  return (
    <div>
      <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">CTR (14 j)</p>
      <ResponsiveContainer width="100%" height={48}>
        <LineChart data={data}>
          <XAxis dataKey="date" hide />
          <Line
            type="monotone"
            dataKey="ctr"
            stroke="#f87171"
            strokeWidth={2}
            dot={false}
          />
          <Tooltip
            contentStyle={{
              background: "#1f2937",
              border: "1px solid #374151",
              borderRadius: "6px",
              fontSize: "11px",
              color: "#e5e7eb",
            }}
            formatter={(v: unknown) => [`${(v as number).toFixed(2)}%`, "CTR"]}
            labelFormatter={(l) => l}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function CPATrend({ data, currency }: { data: ReturnType<typeof getDailyTrend>; currency: string | null }) {
  return (
    <div>
      <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">CPA (14 j)</p>
      <ResponsiveContainer width="100%" height={48}>
        <LineChart data={data}>
          <XAxis dataKey="date" hide />
          <Line
            type="monotone"
            dataKey="cpa"
            stroke="#fb923c"
            strokeWidth={2}
            dot={false}
          />
          <Tooltip
            contentStyle={{
              background: "#1f2937",
              border: "1px solid #374151",
              borderRadius: "6px",
              fontSize: "11px",
              color: "#e5e7eb",
            }}
            formatter={(v: unknown) => [fmtMoney(v as number, currency, 2), "CPA"]}
            labelFormatter={(l) => l}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ROASTrend({ data }: { data: ReturnType<typeof getDailyTrend> }) {
  return (
    <div>
      <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">ROAS (14 j)</p>
      <ResponsiveContainer width="100%" height={48}>
        <LineChart data={data}>
          <XAxis dataKey="date" hide />
          <Line
            type="monotone"
            dataKey="roas"
            stroke="#fbbf24"
            strokeWidth={2}
            dot={false}
          />
          <Tooltip
            contentStyle={{
              background: "#1f2937",
              border: "1px solid #374151",
              borderRadius: "6px",
              fontSize: "11px",
              color: "#e5e7eb",
            }}
            formatter={(v: unknown) => [`${(v as number).toFixed(2)}x`, "ROAS"]}
            labelFormatter={(l) => l}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function PlatformBadge({ platform }: { platform: string }) {
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 ${
        platform === "Meta"
          ? "bg-blue-900/70 text-blue-300 border border-blue-800"
          : "bg-pink-900/70 text-pink-300 border border-pink-800"
      }`}
    >
      {platform}
    </span>
  );
}

export default function FatiguePage() {
  const { creatives, currency } = useCreativesContext();
  const [selectedCreative, setSelectedCreative] = useState<Creative | null>(null);
  const [platformFilter, setPlatformFilter] = useState<"All" | "Meta" | "TikTok">("All");

  // Real fatigue detection (not only the status), biggest spenders first.
  const fatiguedCreatives = [...creatives]
    .filter((c) => (platformFilter === "All" ? true : c.platform === platformFilter))
    .filter(isFatigued)
    .sort((a, b) => b.spend - a.spend);
  const totalFatigued = fatiguedCreatives.length;

  // Compute real average degradation from trend data
  const avgCtrDrop = fatiguedCreatives.length > 0
    ? (() => {
        const drops = fatiguedCreatives.map((c) => {
          const t = c.trend;
          if (t.length < 2) return 0;
          const first = t[0].clicks / Math.max(t[0].impressions, 1) * 100;
          const last = t[t.length - 1].clicks / Math.max(t[t.length - 1].impressions, 1) * 100;
          return Math.max(0, first - last);
        });
        return Math.round((drops.reduce((s, v) => s + v, 0) / drops.length) * 10) / 10;
      })()
    : 0;

  const avgCpaRise = fatiguedCreatives.length > 0
    ? (() => {
        const rises = fatiguedCreatives.map((c) => {
          const t = c.trend;
          if (t.length < 2) return 0;
          const first = t[0].cpa;
          const last = t[t.length - 1].cpa;
          return first > 0 ? Math.round(((last - first) / first) * 100) : 0;
        });
        return Math.round(rises.reduce((s, v) => s + v, 0) / rises.length);
      })()
    : 0;

  return (
    <div className="p-6 space-y-5">
      {/* Page Help */}
      <PageHelp
        title="Fatigue Detection — Détecte l'essoufflement"
        description="Détecte les créas qui s'épuisent avant qu'elles ne coûtent trop cher. Un CTR qui baisse et un CPA qui monte sont les signaux d'alarme d'une audience saturée."
        steps={[
          "Filtre par plateforme (Meta / TikTok / Tout) pour cibler ton analyse.",
          "Lis le bandeau d'alerte en haut : il résume le nombre de créas en danger et la dégradation moyenne.",
          "Sur chaque carte, consulte les mini-graphes CTR, CPA et ROAS (tendance quotidienne, jusqu'à 14 jours), et la liste des signaux détectés : fréquence réelle, baisse de CTR, hook rate.",
        ]}
        tip="Dès qu'une créa affiche 2+ signaux de fatigue, considère lancer une variation avec un hook différent plutôt que d'attendre que le CPA explose."
      />
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Fatigue Detection</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          Creatives showing performance degradation signals
        </p>
      </div>

      {/* Date Range Picker */}
      <DateRangePicker />

      {/* Platform filter */}
      <div className="flex gap-2">
        {(["All", "Meta", "TikTok"] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPlatformFilter(p)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              platformFilter === p
                ? "bg-orange-600/30 border-orange-600 text-orange-200"
                : "bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200"
            }`}
          >
            {p}
          </button>
        ))}
      </div>

      {/* Alert Banner */}
      {totalFatigued > 0 && (
        <div className="flex items-start gap-4 bg-orange-950/50 border border-orange-700/60 rounded-2xl p-5">
          <div className="w-10 h-10 rounded-xl bg-orange-600/30 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-orange-400" />
          </div>
          <div className="flex-1">
            <p className="text-orange-200 font-semibold">
              {totalFatigued} creative{totalFatigued > 1 ? "s are" : " is"} showing fatigue signals
            </p>
            <p className="text-orange-400/80 text-sm mt-1">
              Average CTR dropped <span className="text-orange-300 font-medium">{avgCtrDrop}pp</span> and
              CPA increased <span className="text-orange-300 font-medium">{avgCpaRise}%</span> between the
              first and last day of the daily trend (up to 14 days) across fatigued creatives. Immediate creative refresh is recommended.
            </p>
          </div>
          <div className="flex gap-3 shrink-0">
            <div className="text-center">
              <p className="text-orange-300 font-bold text-lg">
                <TrendingDown className="w-5 h-5 inline" /> CTR
              </p>
              <p className="text-orange-400/70 text-xs">Trending down</p>
            </div>
            <div className="text-center">
              <p className="text-orange-300 font-bold text-lg">
                CPA <TrendingDown className="w-5 h-5 inline rotate-180" />
              </p>
              <p className="text-orange-400/70 text-xs">Trending up</p>
            </div>
          </div>
        </div>
      )}

      {/* Fatigued Creative Cards */}
      <div className="space-y-4">
        {fatiguedCreatives.map((creative) => {
          const trendData = getDailyTrend(creative);
          const signals = getFatigueSignals(creative).signals;

          return (
            <div
              key={creative.id}
              onClick={() => setSelectedCreative(creative)}
              className="bg-gray-900 border border-orange-900/40 rounded-2xl overflow-hidden hover:border-orange-700/60 hover:shadow-lg hover:shadow-orange-900/10 transition-all cursor-pointer"
            >
              {/* Top bar */}
              <div className="flex items-center gap-4 p-4 border-b border-gray-800">
                {/* Thumbnail */}
                <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0">
                  <CreativeThumbnail
                    format={creative.format}
                    thumbnailColor={creative.thumbnailColor}
                    thumbnailUrl={creative.thumbnailUrl}
                    videoUrl={creative.videoUrl}
                    videoId={creative.videoId}
                    className="w-12 h-12"
                  />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-gray-100 truncate">{creative.name}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <PlatformBadge platform={creative.platform} />
                    <span className="text-[10px] text-gray-500 uppercase tracking-wide">
                      {creative.format}
                    </span>
                    <span className="text-[10px] bg-orange-900/50 text-orange-300 border border-orange-800/60 rounded-full px-2 py-0.5 font-semibold">
                      ⚠️ Fatigued
                    </span>
                  </div>
                </div>

                {/* Fatigue signals count */}
                <div className="text-right shrink-0">
                  <p className="text-orange-400 font-bold text-lg">{signals.length}</p>
                  <p className="text-gray-500 text-xs">signals</p>
                </div>

                {/* Real metrics */}
                <div className="flex gap-4 shrink-0">
                  <div className="text-right">
                    <p className={`text-sm font-semibold ${typeof creative.frequencyWeekly === "number" && creative.frequencyWeekly >= FREQUENCY_THRESHOLD ? "text-orange-400" : "text-white"}`} title={typeof creative.frequency === "number" ? `Fréquence sur la période : ${creative.frequency.toFixed(2)}` : undefined}>
                      {typeof creative.frequencyWeekly === "number" ? creative.frequencyWeekly.toFixed(2) : "—"}
                    </p>
                    <p className="text-gray-500 text-xs">Fréq. hebdo</p>
                  </div>
                  <div className="text-right">
                    <p className="text-white text-sm font-semibold">
                      {creative.ctr.toFixed(2)}%
                    </p>
                    <p className="text-gray-500 text-xs">CTR</p>
                  </div>
                  <div className="text-right">
                    <p className="text-orange-400 text-sm font-semibold">
                      {creative.cpa > 0 ? fmtMoney(creative.cpa, currency, 2) : "—"}
                    </p>
                    <p className="text-gray-500 text-xs">CPA</p>
                  </div>
                  <div className="text-right">
                    <p className="text-gray-300 text-sm font-semibold">
                      {fmtMoney(creative.spend, currency)}
                    </p>
                    <p className="text-gray-500 text-xs">Spend</p>
                  </div>
                  <div className="text-right">
                    <p className="text-gray-300 text-sm font-semibold">
                      {fmtRoas(creative.roasUnavailable ? null : creative.roas, { estimated: creative.roasEstimated })}
                    </p>
                    <p className="text-gray-500 text-xs">ROAS</p>
                  </div>
                </div>
              </div>

              {/* Sparklines */}
              <div className="grid grid-cols-3 gap-px bg-gray-800 border-b border-gray-800">
                <div className="bg-gray-900 px-4 py-3">
                  <CTRTrend data={trendData} />
                </div>
                <div className="bg-gray-900 px-4 py-3">
                  <CPATrend data={trendData} currency={currency} />
                </div>
                <div className="bg-gray-900 px-4 py-3">
                  <ROASTrend data={trendData} />
                </div>
              </div>

              {/* Fatigue signals list */}
              {signals.length > 0 && (
                <div className="px-4 py-2 bg-orange-950/10 border-b border-gray-800">
                  <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mb-1">Detected Signals</p>
                  <ul className="space-y-0.5">
                    {signals.map((s) => (
                      <li key={s} className="text-xs text-orange-300/80 flex items-center gap-1.5">
                        <span className="w-1 h-1 rounded-full bg-orange-500 shrink-0" />
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Recommendation */}
              <div className="flex items-center gap-3 px-4 py-3 bg-orange-950/20">
                <RefreshCw className="w-4 h-4 text-orange-400 shrink-0" />
                <p className="text-orange-300 text-xs">
                  <span className="font-semibold">Recommend: Replace creative.</span>{" "}
                  {signals.length > 0
                    ? `${signals.length} fatigue signal${signals.length > 1 ? "s" : ""} detected — audience saturation likely. `
                    : "Audience saturation detected. "}
                  Consider launching a new variant with a different hook or visual angle.
                  <span className="text-gray-500 ml-1">(Click card to view full details)</span>
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {fatiguedCreatives.length === 0 && (
        <div className="flex flex-col items-center justify-center h-48 gap-2">
          <span className="text-2xl">✅</span>
          <p className="text-gray-500 text-sm">No fatigued creatives detected.</p>
          <p className="text-gray-600 text-xs max-w-xl text-center">
            Seuils : statut Fatigued (hook &lt; 20 % ou fréquence hebdo &ge; {FREQUENCY_THRESHOLD}), fréquence hebdo &ge; {FREQUENCY_THRESHOLD} (fréquence × 7 / jours de la période),
            ou CTR de la 2e moitié de la tendance (Σ clics / Σ impressions) &lt; {Math.round(CTR_DECLINE_RATIO * 100)} % de la 1re moitié avec un hook &lt; {HOOK_THRESHOLD} %. Les annonces en pause sont exclues.
          </p>
        </div>
      )}

      {/* Creative Detail Modal */}
      <CreativeModal
        creative={selectedCreative}
        onClose={() => setSelectedCreative(null)}
      />
    </div>
  );
}
