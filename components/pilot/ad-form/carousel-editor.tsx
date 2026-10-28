"use client";

/**
 * Pilotage — the cards of a carousel ad (format « Carrousel » of « Nouvelle
 * publicité »): an ordered list of 2 to 10 cards, each with a media (the
 * shared picker: a Studio image or video of the client, an image sent now, or
 * an https address; a video card takes a thumbnail), a title (≈ 35
 * characters), a description (≈ 30), a link and a button. Cards move up and
 * down, are added and removed. Two switches: « ordre optimisé par Meta »
 * (multi_share_optimized) and « carte de fin » (multi_share_end_card). Emits
 * CarouselCard[] and CarouselOptions of the AdSpec v2; the server checks
 * everything again (lib/pilot/ad-spec.ts).
 */

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { CAROUSEL_CARDS, CAROUSEL_DESCRIPTION_MAX, CAROUSEL_HEADLINE_MAX, type CarouselCard, type CarouselOptions } from "@/lib/pilot/ad-spec";
import { MediaPicker, MediaThumb } from "@/components/pilot/ad-form/media-picker";
import { input, type StudioMedia } from "@/components/pilot/ad-form/shared";

/** An empty card: the link of the ad as a start, no media yet (refused at the submit). */
export const emptyCard = (link: string): CarouselCard => ({ media: { kind: "image", url: "" }, link });

/** What the form checks before the spec leaves (the server checks again); null when fine. */
export function carouselFormError(cards: CarouselCard[]): string | null {
  if (cards.length < CAROUSEL_CARDS.min) return `Un carrousel compte ${CAROUSEL_CARDS.min} cartes au moins.`;
  if (cards.length > CAROUSEL_CARDS.max) return `Un carrousel compte ${CAROUSEL_CARDS.max} cartes au plus.`;
  for (const [i, c] of cards.entries()) {
    const n = i + 1;
    if (!/^https:\/\//i.test(c.media.url)) return `Carte ${n} : choisissez une image ou une vidéo.`;
    if (c.media.kind === "video" && !c.media.studioAssetId && !/\.(mp4|mov|m4v)(\?|$)/i.test(c.media.url)) return `Carte ${n} : l'adresse doit être celle d'un fichier mp4 (ou une vidéo du Studio).`;
    if (c.media.kind === "video" && !c.media.thumbUrl) return `Carte ${n} : choisissez une vignette pour la vidéo (Meta l'exige).`;
    if (!/^https:\/\//i.test(c.link.trim())) return `Carte ${n} : le lien doit commencer par https://.`;
    if ((c.headline?.length ?? 0) > CAROUSEL_HEADLINE_MAX) return `Carte ${n} : titre trop long (${CAROUSEL_HEADLINE_MAX} caractères au plus).`;
    if ((c.description?.length ?? 0) > CAROUSEL_DESCRIPTION_MAX) return `Carte ${n} : description trop longue (${CAROUSEL_DESCRIPTION_MAX} caractères au plus).`;
  }
  const names = cards.map((c) => (c.headline ?? "").trim().toLowerCase()).filter(Boolean);
  if (new Set(names).size !== names.length) return "Deux cartes portent le même titre : donnez-leur des titres différents.";
  return null;
}

export function CarouselEditor({ cards, onChange, options, onOptionsChange, studio, clientId, defaultLink, ctas }: {
  cards: CarouselCard[];
  onChange: (cards: CarouselCard[]) => void;
  options: CarouselOptions;
  onOptionsChange: (options: CarouselOptions) => void;
  /** Studio assets; null while loading. */
  studio: StudioMedia[] | null;
  clientId: string;
  /** The « see more » link of the ad: the link of a new card until changed. */
  defaultLink: string;
  /** Buttons offered ([value, French label]). */
  ctas: Array<[string, string]>;
}) {
  const [active, setActive] = useState(0);
  const current = cards[active] as CarouselCard | undefined;

  const update = (i: number, patch: Partial<CarouselCard>) => onChange(cards.map((c, k) => (k === i ? { ...c, ...patch } : c)));

  function add() {
    if (cards.length >= CAROUSEL_CARDS.max) return;
    onChange([...cards, emptyCard(defaultLink)]);
    setActive(cards.length);
  }
  function remove(i: number) {
    const next = cards.filter((_, k) => k !== i);
    onChange(next);
    setActive(Math.max(0, Math.min(i, next.length - 1)));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= cards.length) return;
    const next = [...cards];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    setActive(j);
  }

  return (
    <div className="space-y-3">
      {/* The cards, in the order shown. */}
      <div className="flex items-start gap-2 overflow-x-auto pb-1" role="list" aria-label="Cartes du carrousel">
        {cards.map((c, i) => (
          <div key={i} role="listitem" className={`shrink-0 w-24 rounded-lg border p-1 space-y-1 ${i === active ? "border-violet-500 bg-violet-500/10" : "border-gray-800"}`}>
            <button type="button" onClick={() => setActive(i)} aria-pressed={i === active} className="w-full aspect-square rounded overflow-hidden bg-gray-900 flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-violet-400" title={c.headline || `Carte ${i + 1}`}>
              {c.media.url ? <MediaThumb media={c.media} className="w-full h-full object-cover" /> : <span className="text-[10px] text-gray-500 px-1 text-center">média ?</span>}
            </button>
            <div className="flex items-center justify-between text-[10px] text-gray-400">
              <span>{i + 1}{c.media.kind === "video" ? " · vidéo" : ""}</span>
              <span className="flex gap-0.5">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="p-0.5 hover:text-white disabled:opacity-30" aria-label={`Monter la carte ${i + 1}`}><ArrowUp className="w-3 h-3" /></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === cards.length - 1} className="p-0.5 hover:text-white disabled:opacity-30" aria-label={`Descendre la carte ${i + 1}`}><ArrowDown className="w-3 h-3" /></button>
                <button type="button" onClick={() => remove(i)} className="p-0.5 hover:text-red-300" aria-label={`Retirer la carte ${i + 1}`}><Trash2 className="w-3 h-3" /></button>
              </span>
            </div>
          </div>
        ))}
        <button type="button" onClick={add} disabled={cards.length >= CAROUSEL_CARDS.max} className="shrink-0 w-24 aspect-square rounded-lg border border-dashed border-gray-700 text-xs text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40 flex flex-col items-center justify-center gap-1">
          <Plus className="w-4 h-4" /> Ajouter
        </button>
      </div>
      <p className="text-[11px] text-gray-500">{cards.length} carte{cards.length > 1 ? "s" : ""} sur {CAROUSEL_CARDS.max} ({CAROUSEL_CARDS.min} au moins, 3 conseillées). Images carrées 1:1, 1 080 px conseillés.</p>

      {/* The card being edited. */}
      {current && (
        <div className="grid md:grid-cols-[220px_minmax(0,1fr)] gap-3 rounded-xl border border-gray-800 p-3">
          <div className="space-y-1">
            <span className="text-xs text-gray-400">Carte {active + 1} — média</span>
            <MediaPicker key={active} kind="any" clientId={clientId} studio={studio} value={current.media.url ? current.media : null} onChange={(m) => update(active, { media: m ?? { kind: "image", url: "" } })} idPrefix={`card-${active}`} compact />
          </div>
          <div className="space-y-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block text-xs text-gray-400">Titre de la carte <span className="text-gray-600">({(current.headline ?? "").length}/{CAROUSEL_HEADLINE_MAX})</span>
                <input value={current.headline ?? ""} onChange={(e) => update(active, { headline: e.target.value || undefined })} className={`${input} mt-1`} maxLength={CAROUSEL_HEADLINE_MAX} />
              </label>
              <label className="block text-xs text-gray-400">Description <span className="text-gray-600">({(current.description ?? "").length}/{CAROUSEL_DESCRIPTION_MAX})</span>
                <input value={current.description ?? ""} onChange={(e) => update(active, { description: e.target.value || undefined })} className={`${input} mt-1`} maxLength={CAROUSEL_DESCRIPTION_MAX} />
              </label>
            </div>
            <div className="grid sm:grid-cols-[minmax(0,1fr)_180px] gap-3">
              <label className="block text-xs text-gray-400">Lien de la carte
                <input value={current.link} onChange={(e) => update(active, { link: e.target.value })} className={`${input} mt-1`} placeholder="https://…" />
              </label>
              <label className="block text-xs text-gray-400">Bouton
                <select value={current.callToAction ?? ""} onChange={(e) => update(active, { callToAction: e.target.value || undefined })} className={`${input} mt-1`}>
                  <option value="">Comme la publicité</option>
                  {ctas.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-4 text-xs text-gray-300">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={options.multiShareOptimized} onChange={(e) => onOptionsChange({ ...options, multiShareOptimized: e.target.checked })} className="accent-violet-500" />
          Ordre optimisé par Meta <span className="text-gray-500">(décoché : l&apos;ordre ci-dessus est respecté)</span>
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={options.endCard} onChange={(e) => onOptionsChange({ ...options, endCard: e.target.checked })} className="accent-violet-500" />
          Carte de fin <span className="text-gray-500">(photo de la Page + lien « voir plus »)</span>
        </label>
      </div>
    </div>
  );
}
