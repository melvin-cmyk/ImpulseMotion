"use client";

/**
 * Pilotage — a simplified rendering of the ad being written, as a feed post
 * and as a story: the Page's name, the primary text, the visual (or the first
 * cards of a carousel), the headline, the description and the button. Not
 * Meta's preview (that one comes with the ad once created): enough to catch a
 * cut headline, a wrong visual or a missing button before the preview.
 */

import { useState } from "react";
import { Globe } from "lucide-react";
import type { CarouselCard, MediaRef } from "@/lib/pilot/ad-spec";
import { MediaThumb } from "@/components/pilot/ad-form/media-picker";
import { ctaLabel } from "@/components/pilot/ad-form/shared";

const domainOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, "").toUpperCase(); } catch { return url ? url.replace(/^https?:\/\//, "").split("/")[0].toUpperCase() : "EXEMPLE.FR"; } };

export function AdPreview({ format, pageName, primaryText, headline, description, cta, linkUrl, media, cards = [] }: {
  format: "image" | "video" | "carousel" | "dynamic";
  pageName: string;
  primaryText: string;
  headline: string;
  description: string;
  cta: string;
  linkUrl: string;
  /** Image or video ad: its media. */
  media: MediaRef | null;
  /** Carousel: its cards (the first two are shown). */
  cards?: CarouselCard[];
}) {
  const [mode, setMode] = useState<"feed" | "story">("feed");
  const page = pageName || "Page Facebook";
  const text = primaryText || "Le texte principal apparaît ici.";
  const first = format === "carousel" ? cards[0]?.media ?? null : media;
  const button = ctaLabel(cta === "NO_BUTTON" ? "" : cta);
  const showButton = cta !== "NO_BUTTON";

  const visual = (m: MediaRef | null | undefined, className: string) =>
    m?.url ? <MediaThumb media={m} className={className} /> : <div className={`${className} flex items-center justify-center text-[11px] text-gray-500`}>visuel</div>;

  return (
    <div className="space-y-2" aria-label="Aperçu de la publicité">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">Aperçu simplifié</span>
        <div className="flex gap-1" role="tablist" aria-label="Emplacement">
          {(["feed", "story"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={`px-2 py-0.5 text-[11px] rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${mode === m ? "border-violet-500 text-white" : "border-gray-800 text-gray-400 hover:text-white"}`}>{m === "feed" ? "Fil" : "Story"}</button>
          ))}
        </div>
      </div>

      {mode === "feed" ? (
        <div className="w-full max-w-[320px] mx-auto rounded-xl bg-white text-gray-900 overflow-hidden shadow-lg text-[12px]">
          <div className="flex items-center gap-2 px-3 pt-3 pb-2">
            <span className="w-8 h-8 rounded-full bg-gray-300 shrink-0" />
            <span className="min-w-0">
              <span className="block font-semibold truncate">{page}</span>
              <span className="block text-[10px] text-gray-500">Sponsorisé · <Globe className="inline w-2.5 h-2.5 -mt-0.5" /></span>
            </span>
          </div>
          <p className="px-3 pb-2 whitespace-pre-wrap break-words line-clamp-5">{text}</p>
          {format === "carousel" ? (
            <div className="flex gap-1 pl-3 overflow-hidden">
              {(cards.length ? cards.slice(0, 2) : [null, null]).map((c, i) => (
                <div key={i} className="shrink-0 w-[78%] rounded-lg border border-gray-200 overflow-hidden">
                  {visual(c?.media, "w-full aspect-square object-cover bg-gray-100")}
                  <div className="px-2 py-1.5 flex items-center gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold truncate">{c?.headline || `Carte ${i + 1}`}</span>
                      {c?.description && <span className="block text-[10px] text-gray-500 truncate">{c.description}</span>}
                    </span>
                    {showButton && <span className="shrink-0 rounded bg-gray-100 px-1.5 py-1 text-[10px] font-semibold">{ctaLabel(c?.callToAction || cta)}</span>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            visual(first, "w-full aspect-square object-cover bg-gray-100")
          )}
          {format !== "carousel" && (
            <div className="bg-gray-100 px-3 py-2 flex items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="block text-[10px] text-gray-500 truncate">{domainOf(linkUrl)}</span>
                <span className="block font-semibold truncate">{headline || (format === "video" ? "Titre de la vidéo" : "Titre")}</span>
                {description && <span className="block text-[10px] text-gray-500 truncate">{description}</span>}
              </span>
              {showButton && <span className="shrink-0 rounded bg-gray-300/70 px-2 py-1.5 text-[11px] font-semibold">{button}</span>}
            </div>
          )}
          {format === "carousel" && <div className="h-2" />}
        </div>
      ) : (
        <div className="relative w-full max-w-[200px] mx-auto aspect-[9/16] rounded-2xl overflow-hidden bg-gray-800 text-white shadow-lg">
          {visual(first, "absolute inset-0 w-full h-full object-cover")}
          <div className="absolute inset-x-0 top-0 p-2 bg-gradient-to-b from-black/60 to-transparent">
            <span className="block text-[11px] font-semibold truncate">{page}</span>
            <span className="block text-[9px] text-gray-300">Sponsorisé</span>
          </div>
          <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/70 to-transparent space-y-1.5">
            <p className="text-[10px] line-clamp-2">{headline || text}</p>
            {showButton && <span className="block text-center rounded-full bg-white text-gray-900 text-[11px] font-semibold py-1">{button}</span>}
          </div>
        </div>
      )}
      <p className="text-[10px] text-gray-600 text-center">Rendu indicatif ; l&apos;aperçu exact est celui du Gestionnaire une fois la publicité créée.</p>
    </div>
  );
}
