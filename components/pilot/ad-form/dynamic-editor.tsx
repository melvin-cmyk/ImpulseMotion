"use client";

/**
 * Pilotage — the assets of a dynamic creative (format « Dynamique » of
 * « Nouvelle publicité »): a grid of up to 10 images and 10 videos (the shared
 * picker: Studio visuals of the client, an image sent now, an https address;
 * a video takes a thumbnail), and lists of variants Meta combines — 1 to 5
 * primary texts, up to 5 headlines, 5 descriptions and 5 buttons — with their
 * counters and the number of combinations. One link for all (on the form).
 * Emits MediaRef[] and the text lists of the AdSpec v2; the server checks
 * everything again (lib/pilot/ad-spec.ts dynamicSpecError) and refuses any ad
 * set that was not created in dynamic creative or already holds an ad.
 */

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { DYNAMIC_LIMITS, dynamicCombinations, dynamicMedia, type MediaRef } from "@/lib/pilot/ad-spec";
import { MediaPicker, MediaThumb } from "@/components/pilot/ad-form/media-picker";
import { input, type StudioMedia } from "@/components/pilot/ad-form/shared";

export interface DynamicVariants { primary: string[]; headline: string[]; description: string[]; ctas: string[] }

export const emptyVariants = (): DynamicVariants => ({ primary: [""], headline: [], description: [], ctas: ["LEARN_MORE"] });

/** What the form checks before the spec leaves (the server checks again); null when fine. Texts are trimmed and empty ones dropped by the caller. */
export function dynamicFormError(media: MediaRef[], variants: DynamicVariants): string | null {
  const { images, videos } = dynamicMedia({ media });
  if (!media.length) return "Ajoutez au moins une image ou une vidéo.";
  if (images.length > DYNAMIC_LIMITS.images) return `${DYNAMIC_LIMITS.images} images au plus.`;
  if (videos.length > DYNAMIC_LIMITS.videos) return `${DYNAMIC_LIMITS.videos} vidéos au plus.`;
  for (const [i, m] of media.entries()) {
    if (!/^https:\/\//i.test(m.url)) return `Visuel ${i + 1} : choisissez une image ou une vidéo.`;
    if (m.kind === "video" && !m.studioAssetId && !/\.(mp4|mov|m4v)(\?|$)/i.test(m.url)) return `Visuel ${i + 1} : l'adresse doit être celle d'un fichier mp4 (ou une vidéo du Studio).`;
    if (m.kind === "video" && !m.thumbUrl) return `Visuel ${i + 1} : choisissez une vignette pour la vidéo (Meta l'exige).`;
  }
  const primary = variants.primary.map((t) => t.trim()).filter(Boolean);
  if (!primary.length) return "Écrivez au moins un texte principal.";
  if (primary.length > DYNAMIC_LIMITS.bodies) return `${DYNAMIC_LIMITS.bodies} textes principaux au plus.`;
  if (variants.headline.filter((t) => t.trim()).length > DYNAMIC_LIMITS.titles) return `${DYNAMIC_LIMITS.titles} titres au plus.`;
  if (variants.description.filter((t) => t.trim()).length > DYNAMIC_LIMITS.descriptions) return `${DYNAMIC_LIMITS.descriptions} descriptions au plus.`;
  if (variants.ctas.length > DYNAMIC_LIMITS.callToActions) return `${DYNAMIC_LIMITS.callToActions} boutons au plus.`;
  return null;
}

function VariantList({ label, values, max, min = 0, maxChars, rows, placeholder, onChange, idPrefix }: {
  label: string;
  values: string[];
  max: number;
  /** Lines that stay (the first primary text). */
  min?: number;
  maxChars: number;
  rows?: number;
  placeholder: string;
  onChange: (values: string[]) => void;
  idPrefix: string;
}) {
  const filled = values.filter((v) => v.trim()).length;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">{label} <span className="text-gray-600">· {filled}/{max}</span></span>
        {values.length < max && (
          <button type="button" onClick={() => onChange([...values, ""])} className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-white"><Plus className="w-3 h-3" /> Ajouter</button>
        )}
      </div>
      {values.map((v, i) => (
        <div key={i} className="flex items-start gap-1.5">
          {rows ? (
            <textarea id={`${idPrefix}-${i}`} value={v} onChange={(e) => onChange(values.map((x, k) => (k === i ? e.target.value : x)))} rows={rows} className={`${input} resize-y`} maxLength={maxChars} placeholder={placeholder} aria-label={`${label} ${i + 1}`} />
          ) : (
            <input id={`${idPrefix}-${i}`} value={v} onChange={(e) => onChange(values.map((x, k) => (k === i ? e.target.value : x)))} className={input} maxLength={maxChars} placeholder={placeholder} aria-label={`${label} ${i + 1}`} />
          )}
          <button type="button" onClick={() => onChange(values.filter((_, k) => k !== i))} disabled={values.length <= min} className="shrink-0 mt-1 text-gray-500 hover:text-red-300 disabled:opacity-30" aria-label={`Retirer ${label.toLowerCase()} ${i + 1}`}><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      ))}
    </div>
  );
}

export function DynamicEditor({ media, onMediaChange, variants, onVariantsChange, studio, clientId, ctas }: {
  media: MediaRef[];
  onMediaChange: (media: MediaRef[]) => void;
  variants: DynamicVariants;
  onVariantsChange: (variants: DynamicVariants) => void;
  /** Studio assets; null while loading. */
  studio: StudioMedia[] | null;
  clientId: string;
  /** Buttons offered ([value, French label]), without NO_BUTTON. */
  ctas: Array<[string, string]>;
}) {
  /** The media the picker edits: an index of the grid, or null for a new one. */
  const [active, setActive] = useState<number | null>(null);
  const { images, videos } = dynamicMedia({ media });
  const full = images.length >= DYNAMIC_LIMITS.images && videos.length >= DYNAMIC_LIMITS.videos;
  const current = active !== null ? media[active] ?? null : null;

  function pick(next: MediaRef | null) {
    if (active === null) {
      if (!next) return;
      const limit = next.kind === "video" ? videos.length >= DYNAMIC_LIMITS.videos : images.length >= DYNAMIC_LIMITS.images;
      if (limit) return;
      onMediaChange([...media, next]);
      setActive(media.length);
      return;
    }
    if (!next) { onMediaChange(media.filter((_, i) => i !== active)); setActive(null); return; }
    onMediaChange(media.map((m, i) => (i === active ? next : m)));
  }

  const combos = dynamicCombinations({ media, texts: { primary: variants.primary.filter((t) => t.trim()), headline: variants.headline.filter((t) => t.trim()), description: variants.description.filter((t) => t.trim()) }, callToActions: variants.ctas });
  const toggleCta = (value: string) => {
    const on = variants.ctas.includes(value);
    if (!on && variants.ctas.length >= DYNAMIC_LIMITS.callToActions) return;
    onVariantsChange({ ...variants, ctas: on ? variants.ctas.filter((c) => c !== value) : [...variants.ctas, value] });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Visuels <span className="text-gray-600">· {images.length}/{DYNAMIC_LIMITS.images} images · {videos.length}/{DYNAMIC_LIMITS.videos} vidéos</span></span>
        </div>
        <div className="grid grid-cols-5 gap-1" role="group" aria-label="Visuels de la publicité dynamique">
          {media.map((m, i) => (
            <button key={i} type="button" aria-pressed={active === i} onClick={() => setActive(i)} title={m.kind === "video" ? `Vidéo ${i + 1}` : `Image ${i + 1}`}
              className={`relative aspect-square rounded overflow-hidden border outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${active === i ? "border-violet-500" : "border-gray-800 hover:border-gray-600"}`}>
              <MediaThumb media={m} className="w-full h-full object-cover" />
              {m.kind === "video" && <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] text-white">vidéo</span>}
              {m.kind === "video" && !m.thumbUrl && <span className="absolute inset-x-0 top-0 bg-amber-500/80 text-[9px] text-black text-center">vignette ?</span>}
            </button>
          ))}
          {!full && (
            <button type="button" onClick={() => setActive(null)} aria-label="Ajouter un visuel" className={`aspect-square rounded border border-dashed flex items-center justify-center text-gray-500 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${active === null ? "border-violet-500 text-violet-300" : "border-gray-700"}`}>
              <Plus className="w-4 h-4" />
            </button>
          )}
        </div>
        <p className="text-[11px] text-gray-500">{active === null ? "Choisissez un visuel à ajouter." : `Visuel ${active + 1} : remplacez-le, ou retirez-le avec la croix.`}</p>
        <MediaPicker key={active ?? "new"} kind="any" clientId={clientId} studio={studio} value={current} onChange={pick} idPrefix={`ad-dynamic-${active ?? "new"}`} compact />
      </div>

      <div className="space-y-3">
        <VariantList label="Textes principaux" values={variants.primary} max={DYNAMIC_LIMITS.bodies} min={1} maxChars={2000} rows={2} placeholder="Un texte au-dessus du visuel" idPrefix="ad-dyn-primary" onChange={(primary) => onVariantsChange({ ...variants, primary })} />
        <div className="grid sm:grid-cols-2 gap-3">
          <VariantList label="Titres" values={variants.headline} max={DYNAMIC_LIMITS.titles} maxChars={255} placeholder="Titre (facultatif)" idPrefix="ad-dyn-headline" onChange={(headline) => onVariantsChange({ ...variants, headline })} />
          <VariantList label="Descriptions" values={variants.description} max={DYNAMIC_LIMITS.descriptions} maxChars={255} placeholder="Description (facultatif)" idPrefix="ad-dyn-description" onChange={(description) => onVariantsChange({ ...variants, description })} />
        </div>
        <div className="space-y-1.5">
          <span className="text-xs text-gray-400">Boutons que Meta peut choisir <span className="text-gray-600">· {variants.ctas.length}/{DYNAMIC_LIMITS.callToActions}</span></span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Boutons">
            {ctas.map(([value, label]) => {
              const on = variants.ctas.includes(value);
              return (
                <button key={value} type="button" aria-pressed={on} onClick={() => toggleCta(value)} disabled={!on && variants.ctas.length >= DYNAMIC_LIMITS.callToActions}
                  className={`px-2 py-1 text-[11px] rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-violet-400 disabled:opacity-40 ${on ? "border-violet-500 text-white bg-violet-500/10" : "border-gray-800 text-gray-400 hover:text-white"}`}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        <p className="text-[11px] text-gray-500">
          {combos.toLocaleString("fr-FR")} combinaison{combos > 1 ? "s" : ""} possible{combos > 1 ? "s" : ""} : Meta assemble visuels, textes, titres, descriptions et boutons, et montre les meilleures. Un seul lien pour toutes.
        </p>
      </div>
    </div>
  );
}
