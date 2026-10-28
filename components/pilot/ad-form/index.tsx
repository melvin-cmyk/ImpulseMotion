"use client";

/**
 * Pilotage — « Nouvelle publicité » on an ad set (components/pilot/ad-form):
 *   platform   deduced from the ad set (Meta today; Google Ads and TikTok Ads
 *              are shown greyed with why they wait);
 *   format     Image · Vidéo · Carrousel · Dynamique (greyed, next lot);
 *   media      the shared picker (media-picker.tsx): Studio visuals of the
 *              client, an image sent now, an https address; a video shows in
 *              a player and takes a thumbnail;
 *   carrousel  2 to 10 cards (carousel-editor.tsx);
 *   texts      name, primary text, headline, description, link, button, Page,
 *              Instagram account;
 *   preview    a simplified feed / story rendering (ad-preview.tsx).
 * Usable at the keyboard: tabs with the arrows, Enter sends the form, Escape
 * closes it. The ad goes to the panel « Modifier » like any other change:
 * preview checked on Meta, confirmation, HQ. Created PAUSED; « Mettre en
 * ligne » comes after, from the journal or the tree. Emits an AdSpec v2.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AdSpec, CarouselCard, CarouselOptions, MediaRef } from "@/lib/pilot/ad-spec";
import { CarouselEditor, carouselFormError, emptyCard } from "@/components/pilot/ad-form/carousel-editor";
import { MediaPicker } from "@/components/pilot/ad-form/media-picker";
import { AdPreview } from "@/components/pilot/ad-form/ad-preview";
import { AD_FORMAT_TABS, AD_PLATFORM_TABS, CTA_FR, input, studioMediaRef, tabClass, tabKeyNav, type AdFormatTab, type AdPlatform, type StudioMedia, type StudioPick } from "@/components/pilot/ad-form/shared";

export type { StudioPick } from "@/components/pilot/ad-form/shared";

type StudioAsset = { id: string; url: string | null; prompt: string; clientId: string | null; clientName: string; kind: string; status: string; sourceId: string | null };

export function NewAdForm({ clientId, accountId, adsetName, platform = "meta", preset, onCancel, onDone }: {
  clientId: string;
  accountId: string;
  adsetName: string;
  /** The platform of the ad set: only Meta creates ads from here today. */
  platform?: AdPlatform;
  /** A Studio visual chosen beforehand (« Pousser sur Meta »), image or video. */
  preset: StudioPick | null;
  onCancel: () => void;
  onDone: (spec: AdSpec, label: string) => void;
}) {
  const [identities, setIdentities] = useState<{ pages: Array<{ id: string; name: string }>; instagram: Array<{ id: string; name: string }> } | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [studio, setStudio] = useState<StudioMedia[] | null>(null);
  const [format, setFormat] = useState<AdFormatTab>(preset?.kind === "video" ? "video" : "image");
  const [cards, setCards] = useState<CarouselCard[]>([]);
  const [carouselOptions, setCarouselOptions] = useState<CarouselOptions>({ multiShareOptimized: false, endCard: true });
  const [image, setImage] = useState<MediaRef | null>(preset && preset.kind !== "video" ? { kind: "image", url: preset.url, studioAssetId: preset.id } : null);
  const [video, setVideo] = useState<MediaRef | null>(preset?.kind === "video" ? { kind: "video", url: preset.url, studioAssetId: preset.id } : null);
  const [error, setError] = useState<string | null>(null);
  const firstTab = useRef<HTMLButtonElement>(null);
  const today = new Date().toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  const [f, setF] = useState({ name: `${adsetName} — ${today}`, primaryText: "", headline: "", description: "", linkUrl: "", callToAction: "LEARN_MORE", pageId: "", instagramUserId: "" });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pilot/ad-identities?clientId=${encodeURIComponent(clientId)}&accountId=${encodeURIComponent(accountId)}`)
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`); return j; })
      .then((j) => {
        if (cancelled) return;
        setIdentities({ pages: j.pages ?? [], instagram: j.instagram ?? [] });
        setF((x) => ({ ...x, pageId: x.pageId || (j.pages?.length === 1 ? j.pages[0].id : ""), instagramUserId: x.instagramUserId || (j.instagram?.length === 1 ? j.instagram[0].id : "") }));
      })
      .catch((e) => { if (!cancelled) setIdentityError(e instanceof Error ? e.message : String(e)); });
    fetch("/api/studio/assets?take=200").then((r) => (r.ok ? r.json() : { assets: [] })).then((j) => {
      if (cancelled) return;
      const list = ((j.assets ?? []) as StudioAsset[]).filter((a) => a.status === "completed" && a.url && (a.kind === "image" || a.kind === "video"));
      // The client's visuals first.
      list.sort((a, b) => Number(b.clientId === clientId) - Number(a.clientId === clientId));
      setStudio(list.map((a) => ({ id: a.id, url: a.url!, prompt: a.prompt, kind: a.kind === "video" ? "video" : "image", sourceId: a.sourceId, clientId: a.clientId, clientName: a.clientName })));
    }).catch(() => { if (!cancelled) setStudio([]); });
    return () => { cancelled = true; };
  }, [clientId, accountId]);

  // Escape closes; the first tab takes the focus when the dialog opens.
  useEffect(() => {
    firstTab.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // A Studio video chosen beforehand takes its source image as thumbnail once the Studio is read (derived, no effect).
  const shownVideo = useMemo<MediaRef | null>(() => {
    if (!video || video.thumbUrl || !video.studioAssetId || !studio) return video;
    const a = studio.find((s) => s.id === video.studioAssetId);
    return a ? { ...studioMediaRef(a, studio), ...(video.thumbStudioAssetId ? {} : {}) } : video;
  }, [video, studio]);

  const pageName = identities?.pages.find((p) => p.id === f.pageId)?.name ?? "";
  const formats = AD_FORMAT_TABS.filter((t) => !t.soon).map((t) => t.id);

  /** Opening the carousel tab: the chosen image or video becomes the first card, a second empty card waits. */
  function pickFormat(next: AdFormatTab) {
    setError(null);
    setFormat(next);
    if (next !== "carousel" || cards.length) return;
    const first = format === "video" && shownVideo ? shownVideo : image;
    const link = f.linkUrl.trim();
    setCards(first ? [{ ...emptyCard(link), media: first }, emptyCard(link)] : [emptyCard(link), emptyCard(link)]);
  }

  function submit() {
    setError(null);
    if (format === "carousel") return submitCarousel();
    const media = format === "video" ? shownVideo : image;
    if (!media) return setError(format === "video" ? "Choisissez une vidéo du Studio ou collez l'adresse https d'un mp4." : "Choisissez une image.");
    if (format === "video" && !media.studioAssetId && !/\.(mp4|mov|m4v)(\?|$)/i.test(media.url)) return setError("L'adresse doit être celle d'un fichier mp4 (ou choisissez une vidéo du Studio).");
    if (format === "video" && !media.thumbUrl) return setError("Choisissez une vignette pour la vidéo : Meta l'exige.");
    if (!f.primaryText.trim()) return setError("Écrivez le texte principal.");
    if (!/^https:\/\//i.test(f.linkUrl.trim())) return setError("Le lien doit commencer par https://.");
    if (!f.pageId) return setError("Choisissez la Page Facebook.");
    const name = f.name.trim() || `${adsetName} — ${today}`;
    const spec: AdSpec = {
      v: 2, platform: "meta", format: format === "video" ? "video" : "image", name,
      linkUrl: f.linkUrl.trim(), callToAction: f.callToAction,
      texts: { primary: [f.primaryText.trim()], headline: f.headline.trim() ? [f.headline.trim()] : [], description: f.description.trim() ? [f.description.trim()] : [] },
      media: [format === "video"
        ? { kind: "video", url: media.url, ...(media.studioAssetId ? { studioAssetId: media.studioAssetId } : {}), thumbUrl: media.thumbUrl!, ...(media.thumbStudioAssetId ? { thumbStudioAssetId: media.thumbStudioAssetId } : {}) }
        : { kind: "image", url: media.url, ...(media.studioAssetId ? { studioAssetId: media.studioAssetId } : {}) }],
      identity: { pageId: f.pageId, ...(f.instagramUserId ? { instagramUserId: f.instagramUserId } : {}) },
    };
    onDone(spec, `Ensemble « ${adsetName} » : nouvelle publicité ${format === "video" ? "vidéo" : "image"} « ${name} » (créée en pause)`);
  }

  function submitCarousel() {
    const bad = carouselFormError(cards);
    if (bad) return setError(bad);
    if (!f.primaryText.trim()) return setError("Écrivez le texte principal.");
    if (!/^https:\/\//i.test(f.linkUrl.trim())) return setError("Le lien « voir plus » doit commencer par https://.");
    if (!f.pageId) return setError("Choisissez la Page Facebook.");
    const name = f.name.trim() || `${adsetName} — ${today}`;
    const spec: AdSpec = {
      v: 2, platform: "meta", format: "carousel", name,
      linkUrl: f.linkUrl.trim(), callToAction: f.callToAction,
      texts: { primary: [f.primaryText.trim()], headline: [], description: [] },
      media: [],
      cards: cards.map((c) => ({ ...c, link: c.link.trim(), headline: c.headline?.trim() || undefined, description: c.description?.trim() || undefined })),
      options: carouselOptions,
      identity: { pageId: f.pageId, ...(f.instagramUserId ? { instagramUserId: f.instagramUserId } : {}) },
    };
    onDone(spec, `Ensemble « ${adsetName} » : nouvelle publicité carrousel (${cards.length} cartes) « ${name} » (créée en pause)`);
  }

  const wide = format === "carousel";
  const preview = (
    <AdPreview format={format} pageName={pageName} primaryText={f.primaryText} headline={f.headline} description={f.description} cta={f.callToAction} linkUrl={f.linkUrl}
      media={format === "video" ? shownVideo : image} cards={cards} />
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onCancel}>
      <form
        role="dialog" aria-modal="true" aria-labelledby="new-ad-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
        className={`bg-gray-950 border border-gray-800 rounded-2xl ${wide ? "max-w-6xl" : "max-w-5xl"} w-full max-h-[92vh] overflow-auto`}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-800">
          <span id="new-ad-title" className="text-sm text-white font-semibold">Nouvelle publicité · ensemble « {adsetName} »</span>
          <button type="button" onClick={onCancel} className="text-gray-400 hover:text-white" aria-label="Fermer"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-4 pt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-1.5" role="tablist" aria-label="Plateforme">
            {AD_PLATFORM_TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={platform === t.id} disabled={!!t.soon || platform !== t.id} title={t.soon ?? undefined} className={tabClass(platform === t.id, !!t.soon)}>
                {t.label}{t.soon ? <span className="ml-1 text-[10px] text-gray-500">bientôt</span> : null}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5" role="tablist" aria-label="Format">
            {AD_FORMAT_TABS.map((t, i) => (
              <button key={t.id} ref={i === 0 ? firstTab : undefined} type="button" role="tab" data-tab={t.id} aria-selected={format === t.id} aria-controls="new-ad-media" tabIndex={t.soon ? -1 : format === t.id ? 0 : -1}
                disabled={!!t.soon} title={t.soon ?? undefined} onClick={() => pickFormat(t.id)} onKeyDown={(e) => tabKeyNav(e, formats, format, pickFormat)} className={tabClass(format === t.id, !!t.soon)}>
                {t.label}{t.soon ? <span className="ml-1 text-[10px] text-gray-500">bientôt</span> : null}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-gray-500">{AD_PLATFORM_TABS.find((t) => t.id === platform)?.soon ?? AD_FORMAT_TABS.find((t) => t.id === format)?.soon ?? (format === "video" ? "mp4, du 16:9 au 9:16, 1 200 px de large conseillés. La vidéo part chez Meta à l'aperçu et y est traitée quelques minutes." : format === "carousel" ? "2 à 10 cartes, image ou vidéo, chacune avec son lien." : "Image carrée 1:1 ou 4:5, 1 080 px conseillés.")}</span>
        </div>

        <div className={`p-4 grid gap-4 ${wide ? "lg:grid-cols-[minmax(0,1fr)_280px]" : "md:grid-cols-[240px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)_280px]"}`}>
          <div id="new-ad-media" role="tabpanel" className={`space-y-2 ${wide ? "lg:col-span-2" : ""}`}>
            {format === "carousel" ? (
              <CarouselEditor cards={cards} onChange={setCards} options={carouselOptions} onOptionsChange={setCarouselOptions} studio={studio} clientId={clientId} defaultLink={f.linkUrl.trim()} ctas={CTA_FR.filter(([v]) => v !== "NO_BUTTON")} />
            ) : format === "video" ? (
              <MediaPicker kind="video" clientId={clientId} studio={studio} value={shownVideo} onChange={setVideo} idPrefix="ad-video" />
            ) : (
              <MediaPicker kind="image" clientId={clientId} studio={studio} value={image} onChange={setImage} idPrefix="ad-image" />
            )}
          </div>

          <div className="space-y-3">
            <label className="block text-xs text-gray-400">Nom de la publicité<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={`${input} mt-1`} maxLength={255} /></label>
            <label className="block text-xs text-gray-400">Texte principal<textarea value={f.primaryText} onChange={(e) => setF({ ...f, primaryText: e.target.value })} rows={4} className={`${input} mt-1 resize-y`} maxLength={2000} placeholder="Le texte au-dessus du visuel" /></label>
            {format !== "carousel" && (
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="block text-xs text-gray-400">Titre (facultatif)<input value={f.headline} onChange={(e) => setF({ ...f, headline: e.target.value })} className={`${input} mt-1`} maxLength={255} /></label>
                <label className="block text-xs text-gray-400">Description (facultatif)<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className={`${input} mt-1`} maxLength={255} /></label>
              </div>
            )}
            <div className="grid sm:grid-cols-[minmax(0,1fr)_180px] gap-3">
              <label className="block text-xs text-gray-400">{format === "carousel" ? "Lien « voir plus » (carte de fin, obligatoire)" : "Lien de destination"}<input value={f.linkUrl} onChange={(e) => setF({ ...f, linkUrl: e.target.value })} className={`${input} mt-1`} placeholder="https://…" inputMode="url" /></label>
              <label className="block text-xs text-gray-400">{format === "carousel" ? "Bouton des cartes (par défaut)" : "Bouton"}
                <select value={f.callToAction} onChange={(e) => setF({ ...f, callToAction: e.target.value })} className={`${input} mt-1`}>
                  {CTA_FR.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block text-xs text-gray-400">Page Facebook
                <select value={f.pageId} onChange={(e) => setF({ ...f, pageId: e.target.value })} className={`${input} mt-1`} disabled={!identities}>
                  <option value="">{identities ? "Choisir…" : "Lecture…"}</option>
                  {identities?.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label className="block text-xs text-gray-400">Compte Instagram (facultatif)
                <select value={f.instagramUserId} onChange={(e) => setF({ ...f, instagramUserId: e.target.value })} className={`${input} mt-1`} disabled={!identities}>
                  <option value="">Aucun / celui de la Page</option>
                  {identities?.instagram.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            </div>
            {identityError && <p className="text-xs text-red-300">{identityError}</p>}
            {identities && identities.pages.length === 0 && (
              <p className="text-xs text-amber-300">
                Aucune Page visible pour ce compte : la Page Facebook du client n&apos;est pas partagée avec l&apos;utilisateur système d&apos;Impulse.
                À faire dans le Business Manager : Paramètres → Pages → la Page du client → ajouter l&apos;utilisateur système avec le droit de créer des publicités.
              </p>
            )}
            {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button type="submit" className="px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-sm text-white font-medium outline-none focus-visible:ring-2 focus-visible:ring-violet-300">Ajouter aux modifications</button>
              <button type="button" onClick={onCancel} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Annuler</button>
              <span className="text-[11px] text-gray-500 ml-auto">Créée en pause : rien n&apos;est dépensé avant « Mettre en ligne ». Entrée ajoute, Échap ferme.</span>
            </div>
          </div>

          <div className={`${wide ? "" : "md:col-span-2 lg:col-span-1"} lg:sticky lg:top-0 self-start`}>{preview}</div>
        </div>
      </form>
    </div>
  );
}
