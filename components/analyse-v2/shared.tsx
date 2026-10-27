"use client";

/** Small shared pieces of Analyse Ads v2 (cards, table, drawer). */

import { Play } from "lucide-react";
import { AI_TAG_LABELS } from "@/lib/ads-warehouse/ai-tags-labels";
import { upgradeImageUrl } from "@/lib/image-upgrade";
import type { AdSample } from "@/lib/ads-warehouse/query";

const COLORS = ["from-violet-500 to-purple-700", "from-blue-500 to-cyan-600", "from-pink-500 to-rose-600", "from-emerald-500 to-teal-600", "from-orange-500 to-amber-600", "from-indigo-500 to-violet-600"];

export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
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
  if (!ad) return <div className={`${className} rounded-xl bg-gray-800`} />;
  const url = upgradeImageUrl(ad.imageUrl ?? ad.thumbnailUrl ?? undefined);
  // A group of several ads (Motion's comparative cards): a 2×2 collage of its top ads.
  const tiles = (ads ?? []).filter((a) => a.imageUrl || a.thumbnailUrl).slice(0, 4);
  if (tiles.length >= 2) {
    const cells = tiles.length === 2 ? "grid-cols-2 grid-rows-1" : "grid-cols-2 grid-rows-2";
    return (
      <div className={`relative ${className} w-full rounded-xl overflow-hidden bg-gray-950 grid ${cells} gap-0.5`}>
        {tiles.map((a, i) => (
          // eslint-disable-next-line @next/next/no-img-element -- Meta CDN, many hosts
          <img key={a.adId + i} src={upgradeImageUrl(a.imageUrl ?? a.thumbnailUrl ?? undefined)} alt="" loading="lazy" className="w-full h-full object-cover" />
        ))}
      </div>
    );
  }
  return (
    <div className={`relative ${className} w-full rounded-xl overflow-hidden bg-gray-950`}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- Meta CDN, many hosts
        <img src={url} alt="" loading="lazy" className="w-full h-full object-cover" />
      ) : (
        <div className={`w-full h-full bg-gradient-to-br ${colorFor(ad.adId)}`} />
      )}
      {ad.format === "Video" && (
        <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="w-11 h-11 rounded-full bg-black/60 border border-white/30 flex items-center justify-center"><Play className="w-5 h-5 text-white fill-white ml-0.5" /></span>
        </span>
      )}
    </div>
  );
}

export function FormatBadge({ ad }: { ad: AdSample | null }) {
  if (!ad) return null;
  return (
    <div className="absolute left-2 bottom-2 flex gap-1">
      <span className="rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">{FORMAT_LABEL[ad.format] ?? ad.format}</span>
      {ad.dynamic && <span className="rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-violet-200" title="Dynamic creative / Advantage+ : plusieurs variantes de texte ou de visuel dans une annonce">Dynamic</span>}
    </div>
  );
}

export function StatusDot({ status }: { status: string | null | undefined }) {
  const on = isActive(status);
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${on ? "bg-emerald-400" : "bg-gray-600"}`} title={on ? "Active" : status ?? "Inactive"} />;
}

/** Human label of a tag key: naming-convention keys as they are, AI keys with their category name. */
export function tagKeyLabel(k: string): string {
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
        <span key={k} className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-300 max-w-[140px] truncate" title={`${k} : ${v}`}>
          <span className="text-gray-500">{k}:</span>{v}
        </span>
      ))}
      {ai.map(([k, v]) => (
        <span key={k} className="rounded bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 text-[10px] text-violet-200 max-w-[150px] truncate" title={`${tagKeyLabel(k)} (IA) : ${v}`}>{v}</span>
      ))}
    </div>
  );
}
