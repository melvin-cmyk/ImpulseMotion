"use client";

/**
 * Pilotage — « Nouvelle publicité » on a Meta ad set, image or video:
 *   Image  a visual of the Studio créa, or one sent now;
 *   Vidéo  a video of the Studio créa (the client's first), or the public https
 *          address of an mp4; its thumbnail is the Studio image the video was
 *          animated from when there is one, else an image sent now (Meta
 *          requires one). The video is sent to Meta at the preview and
 *          processed for a few minutes: the preview says so.
 * Then the texts, the link, the button, the Page and the Instagram account.
 * The ad goes to the panel « Modifier » like any other change: preview checked
 * on Meta, confirmation, HQ. Created PAUSED. Emits an AdSpec v2.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { prepareImage } from "@/lib/ai-chat-shared";
import type { AdSpec } from "@/lib/pilot/ad-spec";

const CTA_FR: Array<[string, string]> = [
  ["LEARN_MORE", "En savoir plus"], ["SHOP_NOW", "Acheter"], ["BUY_NOW", "Acheter maintenant"], ["ORDER_NOW", "Commander"],
  ["SIGN_UP", "S'inscrire"], ["SUBSCRIBE", "S'abonner"], ["BOOK_NOW", "Réserver"], ["BOOK_TRAVEL", "Réserver (voyage)"],
  ["CONTACT_US", "Nous contacter"], ["GET_OFFER", "Profiter de l'offre"], ["GET_QUOTE", "Demander un devis"], ["APPLY_NOW", "Postuler"],
  ["DOWNLOAD", "Télécharger"], ["SEE_MORE", "Voir plus"], ["WATCH_MORE", "Regarder plus"], ["DONATE_NOW", "Faire un don"], ["NO_BUTTON", "Sans bouton"],
];

type StudioAsset = { id: string; url: string | null; prompt: string; clientId: string | null; clientName: string; kind: string; status: string; sourceId: string | null };
export type StudioPick = { id: string; url: string; prompt: string; clientId: string | null; kind?: "image" | "video"; sourceId?: string | null };

type Media = { url: string; studioAssetId?: string; label: string; sourceId?: string | null };
type Thumb = { url: string; studioAssetId?: string; label: string };

const input = "w-full bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-sm text-white outline-none focus:border-violet-500";
const tab = (on: boolean) => `px-3 py-1.5 text-xs rounded-lg border ${on ? "border-violet-500 text-white bg-violet-500/10" : "border-gray-800 text-gray-400 hover:text-white"}`;

export function NewAdForm({ clientId, accountId, adsetName, preset, onCancel, onDone }: {
  clientId: string;
  accountId: string;
  adsetName: string;
  /** A Studio visual chosen beforehand (« Pousser sur Meta »), image or video. */
  preset: StudioPick | null;
  onCancel: () => void;
  onDone: (spec: AdSpec, label: string) => void;
}) {
  const [identities, setIdentities] = useState<{ pages: Array<{ id: string; name: string }>; instagram: Array<{ id: string; name: string }> } | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [studio, setStudio] = useState<StudioAsset[] | null>(null);
  const [format, setFormat] = useState<"image" | "video">(preset?.kind === "video" ? "video" : "image");
  const [image, setImage] = useState<Media | null>(preset && preset.kind !== "video" ? { url: preset.url, studioAssetId: preset.id, label: preset.prompt } : null);
  const [video, setVideo] = useState<Media | null>(preset?.kind === "video" ? { url: preset.url, studioAssetId: preset.id, label: preset.prompt, sourceId: preset.sourceId ?? null } : null);
  const [videoUrl, setVideoUrl] = useState("");
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const [uploading, setUploading] = useState<"image" | "thumb" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const thumbRef = useRef<HTMLInputElement>(null);
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
    fetch("/api/studio/assets").then((r) => (r.ok ? r.json() : { assets: [] })).then((j) => { if (!cancelled) setStudio((j.assets ?? []).filter((a: StudioAsset) => a.status === "completed" && a.url)); }).catch(() => setStudio([]));
    return () => { cancelled = true; };
  }, [clientId, accountId]);

  // The client's visuals first.
  const byClient = (list: StudioAsset[]) => [...list].sort((a, b) => Number(b.clientId === clientId) - Number(a.clientId === clientId)).slice(0, 24);
  const studioImages = useMemo(() => byClient((studio ?? []).filter((a) => a.kind === "image")), [studio, clientId]); // eslint-disable-line react-hooks/exhaustive-deps
  const studioVideos = useMemo(() => byClient((studio ?? []).filter((a) => a.kind === "video")), [studio, clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The thumbnail of a Studio video, unless one was chosen: the image it was animated from, when the Studio still has it.
  const sourceThumb = useMemo<Thumb | null>(() => {
    if (!video?.sourceId) return null;
    const source = (studio ?? []).find((a) => a.id === video.sourceId && a.kind === "image" && a.url);
    return source ? { url: source.url!, studioAssetId: source.id, label: source.prompt } : null;
  }, [video, studio]);
  const shownThumb = thumb ?? sourceThumb;

  async function upload(file: File | undefined, target: "image" | "thumb") {
    if (!file) return;
    setUploading(target);
    setError(null);
    try {
      const img = await prepareImage(file);
      const res = await fetch("/api/pilot/ad-image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: `data:${img.mediaType};base64,${img.data}` }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.imageUrl) throw new Error(j.error ?? `Erreur ${res.status}`);
      if (target === "image") setImage({ url: j.imageUrl, label: file.name }); else setThumb({ url: j.imageUrl, label: file.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(null);
    }
  }

  function pickVideoUrl(raw: string) {
    setVideoUrl(raw);
    const url = raw.trim();
    if (!url) { if (video && !video.studioAssetId) setVideo(null); return; }
    if (/^https:\/\/[^\s]+$/i.test(url)) setVideo({ url, label: url });
  }

  function submit() {
    setError(null);
    const media = format === "video" ? video : image;
    if (!media) return setError(format === "video" ? "Choisissez une vidéo du Studio ou collez l'adresse https d'un mp4." : "Choisissez une image.");
    if (format === "video" && !media.studioAssetId && !/\.(mp4|mov|m4v)(\?|$)/i.test(media.url)) return setError("L'adresse doit être celle d'un fichier mp4 (ou choisissez une vidéo du Studio).");
    const chosenThumb = shownThumb;
    if (format === "video" && !chosenThumb) return setError("Choisissez une vignette pour la vidéo : Meta l'exige.");
    if (!f.primaryText.trim()) return setError("Écrivez le texte principal.");
    if (!/^https:\/\//i.test(f.linkUrl.trim())) return setError("Le lien doit commencer par https://.");
    if (!f.pageId) return setError("Choisissez la Page Facebook.");
    const name = f.name.trim() || `${adsetName} — ${today}`;
    const spec: AdSpec = {
      v: 2, platform: "meta", format, name,
      linkUrl: f.linkUrl.trim(), callToAction: f.callToAction,
      texts: { primary: [f.primaryText.trim()], headline: f.headline.trim() ? [f.headline.trim()] : [], description: f.description.trim() ? [f.description.trim()] : [] },
      media: [format === "video"
        ? { kind: "video", url: media.url, ...(media.studioAssetId ? { studioAssetId: media.studioAssetId } : {}), thumbUrl: chosenThumb!.url, ...(chosenThumb!.studioAssetId ? { thumbStudioAssetId: chosenThumb!.studioAssetId } : {}) }
        : { kind: "image", url: media.url, ...(media.studioAssetId ? { studioAssetId: media.studioAssetId } : {}) }],
      identity: { pageId: f.pageId, ...(f.instagramUserId ? { instagramUserId: f.instagramUserId } : {}) },
    };
    onDone(spec, `Ensemble « ${adsetName} » : nouvelle publicité${format === "video" ? " vidéo" : ""} « ${name} » (créée en pause)`);
  }

  const thumbBlock = (
    <div className="space-y-1 pt-1">
      <span className="text-xs text-gray-400">Vignette (obligatoire)</span>
      <div className="aspect-video rounded-lg border border-gray-800 bg-gray-900 flex items-center justify-center overflow-hidden">
        {shownThumb ? <img src={shownThumb.url} alt="" className="w-full h-full object-cover" /> : <span className="text-[11px] text-gray-500 px-2 text-center">Image du Studio d&apos;origine, ou envoyez une image</span>}
      </div>
      <button type="button" onClick={() => thumbRef.current?.click()} disabled={uploading !== null} className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-800 text-xs text-gray-300 hover:text-white">
        {uploading === "thumb" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />} {shownThumb ? "Changer la vignette" : "Envoyer une vignette"}
      </button>
      <input ref={thumbRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { void upload(e.target.files?.[0], "thumb"); e.target.value = ""; }} />
      {video && studioImages.length > 0 && (
        <div className="grid grid-cols-4 gap-1">
          {studioImages.slice(0, 8).map((a) => (
            <button key={a.id} type="button" title={a.prompt} onClick={() => setThumb({ url: a.url!, studioAssetId: a.id, label: a.prompt })}
              className={`aspect-square rounded overflow-hidden border ${shownThumb?.studioAssetId === a.id ? "border-violet-500" : "border-transparent hover:border-gray-600"}`}>
              <img src={a.url!} alt="" className="w-full h-full object-cover" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-gray-950 border border-gray-800 rounded-2xl max-w-3xl w-full max-h-[92vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <span className="text-sm text-white font-semibold">Nouvelle publicité · ensemble « {adsetName} »</span>
          <button type="button" onClick={onCancel} className="text-gray-400 hover:text-white" aria-label="Fermer"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 grid md:grid-cols-[220px_minmax(0,1fr)] gap-4">
          <div className="space-y-2">
            <div className="flex gap-1.5" role="tablist" aria-label="Format">
              <button type="button" role="tab" aria-selected={format === "image"} onClick={() => setFormat("image")} className={tab(format === "image")}>Image</button>
              <button type="button" role="tab" aria-selected={format === "video"} onClick={() => setFormat("video")} className={tab(format === "video")}>Vidéo</button>
            </div>
            {format === "image" ? (
              <>
                <div className="aspect-square rounded-lg border border-gray-800 bg-gray-900 flex items-center justify-center overflow-hidden">
                  {image ? <img src={image.url} alt="" className="w-full h-full object-cover" /> : <span className="text-xs text-gray-500 px-3 text-center">Choisissez un visuel du Studio ou envoyez une image</span>}
                </div>
                <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading !== null} className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-800 text-xs text-gray-300 hover:text-white">
                  {uploading === "image" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />} Envoyer une image
                </button>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { void upload(e.target.files?.[0], "image"); e.target.value = ""; }} />
                <span className="block text-[11px] text-gray-500 pt-1">Studio créa</span>
                {studio === null ? <Loader2 className="w-4 h-4 animate-spin text-gray-500" /> : studioImages.length === 0 ? (
                  <p className="text-[11px] text-gray-600">Aucun visuel dans le Studio pour le moment.</p>
                ) : (
                  <div className="grid grid-cols-4 gap-1">
                    {studioImages.map((a) => (
                      <button key={a.id} type="button" title={`${a.clientName || "Sans client"} — ${a.prompt}`} onClick={() => setImage({ url: a.url!, studioAssetId: a.id, label: a.prompt })}
                        className={`aspect-square rounded overflow-hidden border ${image?.studioAssetId === a.id ? "border-violet-500" : "border-transparent hover:border-gray-600"}`}>
                        <img src={a.url!} alt="" className="w-full h-full object-cover" loading="lazy" />
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="aspect-[9/16] max-h-64 mx-auto rounded-lg border border-gray-800 bg-gray-900 flex items-center justify-center overflow-hidden">
                  {video ? <video key={video.url} src={video.url} controls muted playsInline className="w-full h-full object-contain bg-black" /> : <span className="text-xs text-gray-500 px-3 text-center">Choisissez une vidéo du Studio ou collez l&apos;adresse d&apos;un mp4</span>}
                </div>
                <label className="block text-[11px] text-gray-500">Adresse https d&apos;un mp4 (facultatif)
                  <input value={videoUrl} onChange={(e) => pickVideoUrl(e.target.value)} className={`${input} mt-1 text-xs`} placeholder="https://…/video.mp4" />
                </label>
                <span className="block text-[11px] text-gray-500 pt-1">Vidéos du Studio créa</span>
                {studio === null ? <Loader2 className="w-4 h-4 animate-spin text-gray-500" /> : studioVideos.length === 0 ? (
                  <p className="text-[11px] text-gray-600">Aucune vidéo dans le Studio pour le moment.</p>
                ) : (
                  <div className="grid grid-cols-3 gap-1">
                    {studioVideos.map((a) => (
                      <button key={a.id} type="button" title={`${a.clientName || "Sans client"} — ${a.prompt}`} onClick={() => { setVideoUrl(""); setVideo({ url: a.url!, studioAssetId: a.id, label: a.prompt, sourceId: a.sourceId }); if (thumb?.studioAssetId) setThumb(null); }}
                        className={`aspect-[9/16] rounded overflow-hidden border ${video?.studioAssetId === a.id ? "border-violet-500" : "border-transparent hover:border-gray-600"}`}>
                        <video src={a.url!} muted playsInline preload="metadata" className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
                {thumbBlock}
                <p className="text-[11px] text-gray-500">mp4, du 16:9 au 9:16, 1 200 px de large conseillés. La vidéo part chez Meta à l&apos;aperçu et y est traitée quelques minutes.</p>
              </>
            )}
          </div>

          <div className="space-y-3">
            <label className="block text-xs text-gray-400">Nom de la publicité<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={`${input} mt-1`} maxLength={255} /></label>
            <label className="block text-xs text-gray-400">Texte principal<textarea value={f.primaryText} onChange={(e) => setF({ ...f, primaryText: e.target.value })} rows={4} className={`${input} mt-1 resize-y`} maxLength={2000} placeholder="Le texte au-dessus du visuel" /></label>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block text-xs text-gray-400">Titre (facultatif)<input value={f.headline} onChange={(e) => setF({ ...f, headline: e.target.value })} className={`${input} mt-1`} maxLength={255} /></label>
              <label className="block text-xs text-gray-400">Description (facultatif)<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className={`${input} mt-1`} maxLength={255} /></label>
            </div>
            <div className="grid sm:grid-cols-[minmax(0,1fr)_180px] gap-3">
              <label className="block text-xs text-gray-400">Lien de destination<input value={f.linkUrl} onChange={(e) => setF({ ...f, linkUrl: e.target.value })} className={`${input} mt-1`} placeholder="https://…" /></label>
              <label className="block text-xs text-gray-400">Bouton
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
            {error && <p className="text-sm text-red-300">{error}</p>}
            <div className="flex items-center gap-2 pt-1">
              <button type="button" onClick={submit} className="px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-sm text-white font-medium">Ajouter aux modifications</button>
              <button type="button" onClick={onCancel} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Annuler</button>
              <span className="text-[11px] text-gray-500 ml-auto">Créée en pause : rien n&apos;est dépensé avant que vous l&apos;activiez.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
