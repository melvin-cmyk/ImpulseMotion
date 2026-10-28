"use client";

/**
 * Pilotage — the cards of a carousel ad (format « Carrousel » of « Nouvelle
 * publicité »): an ordered list of 2 to 10 cards, each with a media (a
 * Studio image or video of the client, an image sent now through
 * /api/pilot/ad-image, or the https address of an image), a title (≈ 35
 * characters), a description (≈ 30), a link and a button; a video card takes
 * a thumbnail (the Studio image it was animated from, or one chosen). Cards
 * move up and down, are added and removed. Two switches: « ordre optimisé
 * par Meta » (multi_share_optimized) and « carte de fin »
 * (multi_share_end_card). Emits CarouselCard[] and CarouselOptions of the
 * AdSpec v2; the server checks everything again (lib/pilot/ad-spec.ts).
 */

import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Loader2, Plus, Trash2 } from "lucide-react";
import { prepareImage } from "@/lib/ai-chat-shared";
import { CAROUSEL_CARDS, CAROUSEL_DESCRIPTION_MAX, CAROUSEL_HEADLINE_MAX, type CarouselCard, type CarouselOptions, type MediaRef } from "@/lib/pilot/ad-spec";

/** A completed Studio asset of the client, image or video, with its public link. */
export type StudioMedia = { id: string; url: string; prompt: string; kind: "image" | "video"; sourceId: string | null; clientName?: string };

const input = "w-full bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-sm text-white outline-none focus:border-violet-500";
const smallBtn = "inline-flex items-center justify-center gap-1 px-2 py-1 rounded-lg border border-gray-800 text-[11px] text-gray-300 hover:text-white disabled:opacity-40";

/** An empty card: the link of the ad as a start, no media yet (refused at the submit). */
export const emptyCard = (link: string): CarouselCard => ({ media: { kind: "image", url: "" }, link });

/** The media of a Studio asset as a card takes it; a video takes the Studio image it was animated from as its thumbnail. */
export function studioMediaRef(a: StudioMedia, studio: StudioMedia[]): MediaRef {
  if (a.kind === "video") {
    const source = a.sourceId ? studio.find((s) => s.id === a.sourceId && s.kind === "image") : undefined;
    return { kind: "video", url: a.url, studioAssetId: a.id, ...(source ? { thumbUrl: source.url, thumbStudioAssetId: source.id } : {}) };
  }
  return { kind: "image", url: a.url, studioAssetId: a.id };
}

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

export function CarouselEditor({ cards, onChange, options, onOptionsChange, studio, defaultLink, ctas }: {
  cards: CarouselCard[];
  onChange: (cards: CarouselCard[]) => void;
  options: CarouselOptions;
  onOptionsChange: (options: CarouselOptions) => void;
  /** Studio assets, the client's first; null while loading. */
  studio: StudioMedia[] | null;
  /** The « see more » link of the ad: the link of a new card until changed. */
  defaultLink: string;
  /** Buttons offered ([value, French label]). */
  ctas: Array<[string, string]>;
}) {
  const [active, setActive] = useState(0);
  const [uploading, setUploading] = useState<"media" | "thumb" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageUrlDraft, setImageUrlDraft] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const thumbRef = useRef<HTMLInputElement>(null);

  const current = cards[active] as CarouselCard | undefined;
  const images = (studio ?? []).filter((a) => a.kind === "image");
  const videos = (studio ?? []).filter((a) => a.kind === "video");

  const update = (i: number, patch: Partial<CarouselCard>) => onChange(cards.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const setMedia = (i: number, media: MediaRef) => update(i, { media });

  function add() {
    if (cards.length >= CAROUSEL_CARDS.max) return;
    onChange([...cards, emptyCard(defaultLink)]);
    setActive(cards.length);
    setImageUrlDraft("");
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

  async function upload(file: File | undefined, target: "media" | "thumb") {
    if (!file || !current) return;
    setUploading(target);
    setError(null);
    try {
      const img = await prepareImage(file);
      const res = await fetch("/api/pilot/ad-image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: `data:${img.mediaType};base64,${img.data}` }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.imageUrl) throw new Error(j.error ?? `Erreur ${res.status}`);
      if (target === "media") setMedia(active, { kind: "image", url: j.imageUrl });
      else setMedia(active, { ...current.media, thumbUrl: j.imageUrl, thumbStudioAssetId: undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(null);
    }
  }

  function pickImageUrl(raw: string) {
    setImageUrlDraft(raw);
    const url = raw.trim();
    if (/^https:\/\/[^\s]+$/i.test(url)) setMedia(active, { kind: "image", url });
  }

  const preview = (m: MediaRef, className: string) =>
    !m.url ? <span className="text-[10px] text-gray-500 px-1 text-center">média ?</span>
      : m.kind === "video" ? (m.thumbUrl ? <img src={m.thumbUrl} alt="" className={className} /> : <video src={m.url} muted playsInline preload="metadata" className={className} />)
        : <img src={m.url} alt="" className={className} />;

  return (
    <div className="space-y-3">
      {/* The cards, in the order shown. */}
      <div className="flex items-start gap-2 overflow-x-auto pb-1" role="list" aria-label="Cartes du carrousel">
        {cards.map((c, i) => (
          <div key={i} role="listitem" className={`shrink-0 w-24 rounded-lg border p-1 space-y-1 ${i === active ? "border-violet-500 bg-violet-500/10" : "border-gray-800"}`}>
            <button type="button" onClick={() => { setActive(i); setImageUrlDraft(""); }} className="w-full aspect-square rounded overflow-hidden bg-gray-900 flex items-center justify-center" title={c.headline || `Carte ${i + 1}`}>
              {preview(c.media, "w-full h-full object-cover")}
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
        <div className="grid md:grid-cols-[200px_minmax(0,1fr)] gap-3 rounded-xl border border-gray-800 p-3">
          <div className="space-y-2">
            <span className="text-xs text-gray-400">Carte {active + 1} — média</span>
            <div className="aspect-square rounded-lg border border-gray-800 bg-gray-900 flex items-center justify-center overflow-hidden">
              {current.media.url ? (current.media.kind === "video" ? <video key={current.media.url} src={current.media.url} controls muted playsInline className="w-full h-full object-contain bg-black" /> : <img src={current.media.url} alt="" className="w-full h-full object-cover" />) : <span className="text-xs text-gray-500 px-3 text-center">Visuel du Studio, image envoyée ou adresse https</span>}
            </div>
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading !== null} className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-800 text-xs text-gray-300 hover:text-white">
              {uploading === "media" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />} Envoyer une image
            </button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { void upload(e.target.files?.[0], "media"); e.target.value = ""; }} />
            <label className="block text-[11px] text-gray-500">Adresse https d&apos;une image
              <input value={imageUrlDraft} onChange={(e) => pickImageUrl(e.target.value)} className={`${input} mt-1 text-xs`} placeholder="https://…/visuel.jpg" />
            </label>
            {current.media.kind === "video" && (
              <div className="space-y-1 pt-1">
                <span className="text-xs text-gray-400">Vignette (obligatoire)</span>
                <div className="aspect-square rounded-lg border border-gray-800 bg-gray-900 flex items-center justify-center overflow-hidden">
                  {current.media.thumbUrl ? <img src={current.media.thumbUrl} alt="" className="w-full h-full object-cover" /> : <span className="text-[11px] text-gray-500 px-2 text-center">Image du Studio d&apos;origine, ou envoyez une image</span>}
                </div>
                <button type="button" onClick={() => thumbRef.current?.click()} disabled={uploading !== null} className={`${smallBtn} w-full`}>
                  {uploading === "thumb" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />} {current.media.thumbUrl ? "Changer la vignette" : "Envoyer une vignette"}
                </button>
                <input ref={thumbRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { void upload(e.target.files?.[0], "thumb"); e.target.value = ""; }} />
                {images.length > 0 && (
                  <div className="grid grid-cols-4 gap-1">
                    {images.slice(0, 8).map((a) => (
                      <button key={a.id} type="button" title={a.prompt} onClick={() => setMedia(active, { ...current.media, thumbUrl: a.url, thumbStudioAssetId: a.id })}
                        className={`aspect-square rounded overflow-hidden border ${current.media.thumbStudioAssetId === a.id ? "border-violet-500" : "border-transparent hover:border-gray-600"}`}>
                        <img src={a.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <span className="block text-[11px] text-gray-500">Studio créa</span>
              {studio === null ? <Loader2 className="w-4 h-4 animate-spin text-gray-500 mt-1" /> : images.length + videos.length === 0 ? (
                <p className="text-[11px] text-gray-600">Aucun visuel dans le Studio pour le moment.</p>
              ) : (
                <div className="grid grid-cols-6 sm:grid-cols-8 gap-1 mt-1">
                  {[...images, ...videos].slice(0, 32).map((a) => (
                    <button key={a.id} type="button" title={`${a.clientName || "Sans client"} — ${a.prompt}`} onClick={() => { setImageUrlDraft(""); setMedia(active, studioMediaRef(a, studio ?? [])); }}
                      className={`relative aspect-square rounded overflow-hidden border ${current.media.studioAssetId === a.id ? "border-violet-500" : "border-transparent hover:border-gray-600"}`}>
                      {a.kind === "video" ? <video src={a.url} muted playsInline preload="metadata" className="w-full h-full object-cover" /> : <img src={a.url} alt="" className="w-full h-full object-cover" loading="lazy" />}
                      {a.kind === "video" && <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] text-white">vidéo</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
