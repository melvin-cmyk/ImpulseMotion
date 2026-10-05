"use client";

/**
 * Pilotage — « Nouvelle publicité » on a Meta ad set: the image (a visual of
 * the Studio créa, or one sent now), the texts, the link, the button, the Page
 * and the Instagram account. The ad goes to the panel « Modifier » like any
 * other change: preview checked on Meta, confirmation, HQ. Created PAUSED.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { prepareImage } from "@/lib/ai-chat-shared";
import type { NewAdSpec } from "@/lib/pilot/ops";

const CTA_FR: Array<[string, string]> = [
  ["LEARN_MORE", "En savoir plus"], ["SHOP_NOW", "Acheter"], ["BUY_NOW", "Acheter maintenant"], ["ORDER_NOW", "Commander"],
  ["SIGN_UP", "S'inscrire"], ["SUBSCRIBE", "S'abonner"], ["BOOK_NOW", "Réserver"], ["BOOK_TRAVEL", "Réserver (voyage)"],
  ["CONTACT_US", "Nous contacter"], ["GET_OFFER", "Profiter de l'offre"], ["GET_QUOTE", "Demander un devis"], ["APPLY_NOW", "Postuler"],
  ["DOWNLOAD", "Télécharger"], ["SEE_MORE", "Voir plus"], ["WATCH_MORE", "Regarder plus"], ["DONATE_NOW", "Faire un don"], ["NO_BUTTON", "Sans bouton"],
];

type StudioImage = { id: string; url: string | null; prompt: string; clientId: string | null; clientName: string; kind: string; status: string };
export type StudioPick = { id: string; url: string; prompt: string; clientId: string | null };

const input = "w-full bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-sm text-white outline-none focus:border-violet-500";

export function NewAdForm({ clientId, accountId, adsetName, preset, onCancel, onDone }: {
  clientId: string;
  accountId: string;
  adsetName: string;
  /** A Studio visual chosen beforehand (« Pousser sur Meta »). */
  preset: StudioPick | null;
  onCancel: () => void;
  onDone: (spec: NewAdSpec, label: string) => void;
}) {
  const [identities, setIdentities] = useState<{ pages: Array<{ id: string; name: string }>; instagram: Array<{ id: string; name: string }> } | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [studio, setStudio] = useState<StudioImage[] | null>(null);
  const [image, setImage] = useState<{ url: string; studioAssetId?: string; label: string } | null>(preset ? { url: preset.url, studioAssetId: preset.id, label: preset.prompt } : null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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
    fetch("/api/studio/assets").then((r) => (r.ok ? r.json() : { assets: [] })).then((j) => { if (!cancelled) setStudio((j.assets ?? []).filter((a: StudioImage) => a.kind === "image" && a.status === "completed" && a.url)); }).catch(() => setStudio([]));
    return () => { cancelled = true; };
  }, [clientId, accountId]);

  // The client's visuals first.
  const studioSorted = useMemo(() => [...(studio ?? [])].sort((a, b) => Number(b.clientId === clientId) - Number(a.clientId === clientId)).slice(0, 24), [studio, clientId]);

  async function upload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const img = await prepareImage(file);
      const res = await fetch("/api/pilot/ad-image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: `data:${img.mediaType};base64,${img.data}` }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.imageUrl) throw new Error(j.error ?? `Erreur ${res.status}`);
      setImage({ url: j.imageUrl, label: file.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  function submit() {
    setError(null);
    if (!image) return setError("Choisissez une image.");
    if (!f.primaryText.trim()) return setError("Écrivez le texte principal.");
    if (!/^https:\/\//i.test(f.linkUrl.trim())) return setError("Le lien doit commencer par https://.");
    if (!f.pageId) return setError("Choisissez la Page Facebook.");
    const spec: NewAdSpec = {
      name: f.name.trim() || `${adsetName} — ${today}`, primaryText: f.primaryText.trim(), headline: f.headline.trim() || undefined,
      description: f.description.trim() || undefined, linkUrl: f.linkUrl.trim(), callToAction: f.callToAction, imageUrl: image.url,
      pageId: f.pageId, instagramUserId: f.instagramUserId || undefined, studioAssetId: image.studioAssetId,
    };
    onDone(spec, `Ensemble « ${adsetName} » : nouvelle publicité « ${spec.name} » (créée en pause)`);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-gray-950 border border-gray-800 rounded-2xl max-w-3xl w-full max-h-[92vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <span className="text-sm text-white font-semibold">Nouvelle publicité · ensemble « {adsetName} »</span>
          <button type="button" onClick={onCancel} className="text-gray-400 hover:text-white" aria-label="Fermer"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 grid md:grid-cols-[220px_minmax(0,1fr)] gap-4">
          <div className="space-y-2">
            <span className="text-xs text-gray-400">Image</span>
            <div className="aspect-square rounded-lg border border-gray-800 bg-gray-900 flex items-center justify-center overflow-hidden">
              {image ? <img src={image.url} alt="" className="w-full h-full object-cover" /> : <span className="text-xs text-gray-500 px-3 text-center">Choisissez un visuel du Studio ou envoyez une image</span>}
            </div>
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-800 text-xs text-gray-300 hover:text-white">
              {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />} Envoyer une image
            </button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
            <span className="block text-[11px] text-gray-500 pt-1">Studio créa</span>
            {studio === null ? <Loader2 className="w-4 h-4 animate-spin text-gray-500" /> : studioSorted.length === 0 ? (
              <p className="text-[11px] text-gray-600">Aucun visuel dans le Studio pour le moment.</p>
            ) : (
              <div className="grid grid-cols-4 gap-1">
                {studioSorted.map((a) => (
                  <button key={a.id} type="button" title={`${a.clientName || "Sans client"} — ${a.prompt}`} onClick={() => setImage({ url: a.url!, studioAssetId: a.id, label: a.prompt })}
                    className={`aspect-square rounded overflow-hidden border ${image?.studioAssetId === a.id ? "border-violet-500" : "border-transparent hover:border-gray-600"}`}>
                    <img src={a.url!} alt="" className="w-full h-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
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
