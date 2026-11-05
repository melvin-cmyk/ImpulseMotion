"use client";

/** Small shared pieces of Analyse Ads v2 (cards, table, drawer). */

import { Pause, Play, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { AI_TAG_LABELS } from "@/lib/ads-warehouse/ai-tags-labels";
import { upgradeImageUrl } from "@/lib/image-upgrade";
import type { AdSample } from "@/lib/ads-warehouse/query";
import { fbcdnUsable } from "@/lib/ads-warehouse/cdn";
import { SPEND_STATE_HINT, SPEND_STATE_LABEL, type CreativeTrend, type SpendState } from "@/lib/ads-warehouse/trends";

/**
 * Image to show for an ad: the stored visual while its signed Meta URL is
 * valid, otherwise /api/ads/image which re-reads it from Meta (and stores it).
 */
export function adImageSrc(ad: AdSample | null | undefined): string | undefined {
  if (!ad) return undefined;
  const stored = ad.imageUrl ?? ad.thumbnailUrl ?? null;
  if (ad.platform === "meta" && !(fbcdnUsable(ad.imageUrl) || fbcdnUsable(ad.thumbnailUrl))) return `/api/ads/image?adId=${encodeURIComponent(ad.adId)}`;
  const best = fbcdnUsable(ad.imageUrl) ? ad.imageUrl : ad.platform === "meta" ? ad.thumbnailUrl : stored;
  return upgradeImageUrl(best ?? undefined);
}

/** Placeholder of a creative without a visual: one neutral surface (no colour per ad). */
export function colorFor(id: string): string {
  void id;
  return "bg-ui-raised";
}

export const FORMAT_LABEL: Record<string, string> = { Video: "Vidéo", Image: "Image", Carousel: "Carrousel", Text: "Texte", Unknown: "—" };

export function isActive(status: string | null | undefined): boolean {
  return status === "ACTIVE" || status === "ENABLE" || status === "ENABLED";
}

export function relativeDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z").getTime();
  const days = Math.max(0, Math.floor((Date.now() - d) / 86400_000));
  if (days < 1) return "aujourd'hui";
  if (days < 14) return `il y a ${days} j`;
  if (days < 70) return `il y a ${Math.round(days / 7)} sem.`;
  return `il y a ${Math.round(days / 30)} mois`;
}

/**
 * Visual of an ad on a card: the sharp thumbnail (1200 px rendition stored by
 * the warehouse), with a play badge for videos. Playback happens in the
 * drawer through the official ad preview (the Facebook embed player refuses
 * most ad videos, which showed "Video unavailable").
 */
export function AdVisual({ ad, ads, className = "aspect-[4/5]" }: { ad: AdSample | null; ads?: AdSample[]; className?: string }) {
  if (!ad) return <div className={`${className} rounded-xl bg-ui-raised`} />;
  const url = adImageSrc(ad);
  // A group of several ads (Motion's comparative cards): a 2×2 collage of its top ads.
  const tiles = (ads ?? []).filter((a) => a.imageUrl || a.thumbnailUrl).slice(0, 4);
  if (tiles.length >= 2) {
    const cells = tiles.length === 2 ? "grid-cols-2 grid-rows-1" : "grid-cols-2 grid-rows-2";
    return (
      <div className={`relative ${className} w-full rounded-xl overflow-hidden bg-ui-bg grid ${cells} gap-0.5`}>
        {tiles.map((a, i) => (
          // eslint-disable-next-line @next/next/no-img-element -- Meta CDN, many hosts
          <img key={a.adId + i} src={adImageSrc(a)} alt="" loading="lazy" className="w-full h-full object-cover" />
        ))}
      </div>
    );
  }
  return (
    <div className={`relative ${className} w-full rounded-xl overflow-hidden bg-ui-bg`}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- Meta CDN, many hosts
        <img src={url} alt="" loading="lazy" className="w-full h-full object-cover" />
      ) : (
        <div className={`w-full h-full bg-ui-raised`} />
      )}
      {ad.format === "Video" && (
        <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="w-11 h-11 rounded-full bg-black/50 border border-ui-line flex items-center justify-center"><Play className="w-5 h-5 text-ui-fg fill-white ml-0.5" /></span>
        </span>
      )}
    </div>
  );
}

export function FormatBadge({ ad }: { ad: AdSample | null }) {
  if (!ad) return null;
  return (
    <div className="absolute left-2 bottom-2 flex gap-1">
      <span className="rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-ui-fg">{FORMAT_LABEL[ad.format] ?? ad.format}</span>
      {ad.dynamic && <span className="rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-ui-accent-ink" title="Dynamic creative / Advantage+ : plusieurs variantes de texte ou de visuel dans une annonce">Dynamic</span>}
    </div>
  );
}

export function StatusDot({ status }: { status: string | null | undefined }) {
  const on = isActive(status);
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${on ? "bg-emerald-400" : "bg-ui-line-strong"}`} title={on ? "Active" : status ?? "Inactive"} />;
}

/** Human label of a tag key: naming-convention keys as they are, AI keys with their category name. */
export function tagKeyLabel(k: string): string {
  if (k === "ai:msg") return "Thème de message";
  return AI_TAG_LABELS[k as keyof typeof AI_TAG_LABELS] ?? k;
}

export function TagChips({ tags, max = 4 }: { tags: Record<string, string>; max?: number }) {
  const entries = Object.entries(tags).filter(([k]) => !/^(s|t)\d+$/.test(k));
  const naming = entries.filter(([k]) => !k.startsWith("ai:")).slice(0, max);
  const ai = entries.filter(([k]) => k.startsWith("ai:") && !/indéterminé|aucune?$/i.test(tags[k])).slice(0, max);
  if (!naming.length && !ai.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {naming.map(([k, v]) => (
        <span key={k} className="rounded bg-ui-raised px-1.5 py-0.5 text-[10px] text-ui-fg2 max-w-[140px] truncate" title={`${k} : ${v}`}>
          <span className="text-ui-muted">{k}:</span>{v}
        </span>
      ))}
      {ai.map(([k, v]) => (
        <span key={k} className="rounded bg-ui-accent-soft border border-ui-accent px-1.5 py-0.5 text-[10px] text-ui-accent-ink max-w-[150px] truncate" title={`${tagKeyLabel(k)} (IA) : ${v}`}>{v}</span>
      ))}
    </div>
  );
}

/** Motion's score gauge: 2-segment bar + value (green ≥ 60, amber 50-59, grey below; "—" when not scored). */
export function ScoreGauge({ value }: { value: number }) {
  if (!value) return <span className="text-ui-muted">—</span>;
  const tone = value >= 60 ? "bg-emerald-400" : value >= 50 ? "bg-amber-400" : "bg-ui-muted";
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      <span className="flex gap-0.5 w-9">
        <span className="h-1.5 flex-1 rounded-full bg-ui-line-strong overflow-hidden"><span className={`block h-full ${tone}`} style={{ width: `${Math.min(100, value * 2)}%` }} /></span>
        <span className="h-1.5 flex-1 rounded-full bg-ui-line-strong overflow-hidden"><span className={`block h-full ${tone}`} style={{ width: `${Math.max(0, value * 2 - 100)}%` }} /></span>
      </span>
      {Math.round(value)}
    </span>
  );
}

const TREND_CLASS: Record<SpendState, string> = {
  new: "text-sky-200",
  scaling: "text-emerald-200",
  declining: "text-red-200",
  paused: "text-ui-fg2",
  stable: "text-ui-fg",
  testing: "text-ui-fg2",
};

/** Spend-state badge (Motion's "This creative is scaling"), with the week-over-week spend change. */
export function TrendBadge({ trend, compact }: { trend: CreativeTrend | null | undefined; compact?: boolean }) {
  if (!trend || trend.state === "stable" || trend.state === "testing") return null;
  const Icon = trend.state === "scaling" ? TrendingUp : trend.state === "declining" ? TrendingDown : trend.state === "paused" ? Pause : Sparkles;
  const wow = trend.wow !== null && (trend.state === "scaling" || trend.state === "declining") ? ` ${trend.wow > 0 ? "+" : ""}${Math.round(trend.wow)} %` : "";
  return (
    <span title={`${SPEND_STATE_HINT[trend.state]} (7 j : ${Math.round(trend.last7)} vs ${Math.round(trend.prev7)})`} className={`inline-flex items-center gap-1 rounded-md bg-black/50 backdrop-blur-sm px-2 py-0.5 text-xs font-medium ${TREND_CLASS[trend.state]}`}>
      <Icon className="w-3 h-3" />{compact ? "" : SPEND_STATE_LABEL[trend.state]}{wow}
    </span>
  );
}

/** Inline spend state for tables and lists (no background). */
export function TrendText({ trend }: { trend: CreativeTrend }) {
  const tone = trend.state === "scaling" ? "text-emerald-400" : trend.state === "declining" ? "text-red-400" : trend.state === "new" ? "text-sky-400" : "text-ui-muted";
  const wow = trend.wow !== null && (trend.state === "scaling" || trend.state === "declining") ? ` ${trend.wow > 0 ? "+" : ""}${Math.round(trend.wow)} %` : "";
  return <span className={tone} title={SPEND_STATE_HINT[trend.state]}>{SPEND_STATE_LABEL[trend.state]}{wow}</span>;
}
