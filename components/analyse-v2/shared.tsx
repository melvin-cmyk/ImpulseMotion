"use client";

/** Small shared pieces of Analyse Ads v2 (cards, table, drawer). */

import { upgradeImageUrl } from "@/lib/image-upgrade";
import type { AdSample } from "@/lib/ads-warehouse/query";
import { CreativeThumbnail } from "@/components/creative-thumbnail";

const COLORS = ["from-violet-500 to-purple-700", "from-blue-500 to-cyan-600", "from-pink-500 to-rose-600", "from-emerald-500 to-teal-600", "from-orange-500 to-amber-600", "from-indigo-500 to-violet-600"];

export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

export const FORMAT_LABEL: Record<string, string> = { Video: "Vidéo", Image: "Image", Carousel: "Carrousel", Unknown: "—" };

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

/** Visual of an ad: image or video player, Meta CDN image upgraded to a large size. */
export function AdVisual({ ad, className = "aspect-[4/5]" }: { ad: AdSample | null; className?: string }) {
  if (!ad) return <div className={`${className} rounded-xl bg-gray-800`} />;
  const url = upgradeImageUrl(ad.imageUrl ?? ad.thumbnailUrl ?? undefined);
  return (
    <CreativeThumbnail
      format={ad.format}
      thumbnailColor={colorFor(ad.adId)}
      thumbnailUrl={url}
      videoId={ad.videoId ?? undefined}
      className={`${className} w-full rounded-xl overflow-hidden`}
    />
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

export function TagChips({ tags, max = 4 }: { tags: Record<string, string>; max?: number }) {
  const entries = Object.entries(tags).filter(([k]) => !/^(s|t)\d+$/.test(k)).slice(0, max);
  if (!entries.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span key={k} className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-300 max-w-[140px] truncate" title={`${k} : ${v}`}>
          <span className="text-gray-500">{k}:</span>{v}
        </span>
      ))}
    </div>
  );
}
