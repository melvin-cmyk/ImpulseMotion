"use client";

/**
 * Pilotage — « Textes » of an ad.
 *   Meta       the texts of the creative shown now (read on Meta), edited; the
 *              change makes a NEW creative with the same image or video and
 *              switches the ad to it.
 *   Google Ads the headlines, descriptions, URL and paths of a responsive
 *              search ad; the change makes a NEW ad and pauses this one.
 * The change goes to the panel « Modifier » like any other. Nothing is sent here.
 */

import { useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import {
  CALL_TO_ACTIONS, RSA_DESCRIPTIONS, RSA_DESCRIPTION_MAX, RSA_HEADLINES, RSA_HEADLINE_MAX, RSA_PINS, metaTextsDiff, readMetaAdTexts, readRsa, rsaDiff,
  type MetaAdTexts, type RsaAsset, type RsaSpec,
} from "@/lib/pilot/creative";

const CTA_FR: Record<string, string> = {
  LEARN_MORE: "En savoir plus", SHOP_NOW: "Acheter", BUY_NOW: "Acheter maintenant", ORDER_NOW: "Commander", SIGN_UP: "S'inscrire", SUBSCRIBE: "S'abonner",
  BOOK_NOW: "Réserver", BOOK_TRAVEL: "Réserver (voyage)", CONTACT_US: "Nous contacter", GET_OFFER: "Profiter de l'offre", GET_QUOTE: "Demander un devis",
  APPLY_NOW: "Postuler", DOWNLOAD: "Télécharger", SEE_MORE: "Voir plus", WATCH_MORE: "Regarder plus", DONATE_NOW: "Faire un don", NO_BUTTON: "Sans bouton",
};
const input = "w-full bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-sm text-white outline-none focus:border-violet-500";

function Shell({ title, onCancel, children }: { title: string; onCancel: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex items-start justify-center overflow-y-auto p-4" onClick={onCancel}>
      <div className="w-full max-w-2xl bg-gray-900 border border-gray-700 rounded-2xl p-5 my-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">{title}</h3>
          <button type="button" onClick={onCancel} className="text-gray-400 hover:text-white" aria-label="Fermer"><X className="w-4 h-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function MetaAdTextsForm({ clientId, accountId, adId, adName, onCancel, onDone }: {
  clientId: string; accountId: string; adId: string; adName: string; onCancel: () => void; onDone: (json: string, label: string) => void;
}) {
  const [current, setCurrent] = useState<MetaAdTexts | null | undefined>(undefined);
  const [media, setMedia] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<MetaAdTexts | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pilot/ad-texts?clientId=${encodeURIComponent(clientId)}&accountId=${encodeURIComponent(accountId)}&adId=${encodeURIComponent(adId)}`)
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`); return j; })
      .then((j) => { if (cancelled) return; setCurrent(j.texts ?? null); setF(j.texts ?? null); setMedia(j.media ?? null); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [clientId, accountId, adId]);

  const diff = current && f ? metaTextsDiff(current, f) : [];
  function submit() {
    if (!f) return;
    const read = readMetaAdTexts(f);
    if (!read.ok) { setError(read.error); return; }
    if (!diff.length) { setError("Rien n'a changé."); return; }
    onDone(JSON.stringify(read.texts), `Annonce « ${adName} » : nouveaux textes — ${diff.join(" ; ")}`);
  }

  return (
    <Shell title={`Textes — « ${adName} »`} onCancel={onCancel}>
      {error && <p className="text-sm text-red-300">{error}</p>}
      {current === undefined && !error && <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture de la créa sur Meta…</p>}
      {current === null && <p className="text-sm text-amber-300">Cette annonce n&apos;est pas une annonce image ou vidéo avec un lien (carrousel, catalogue, publication existante…) : ses textes se changent dans le Gestionnaire de publicités.</p>}
      {current && f && (
        <>
          <p className="text-xs text-gray-400">Même {current.kind === "video" ? "vidéo" : "image"}{media ? ` (${media})` : ""}, même Page : Meta reçoit une nouvelle créa avec ces textes et l&apos;annonce bascule dessus. L&apos;ancienne créa reste disponible pour revenir en arrière.</p>
          <label className="block space-y-1 text-sm"><span className="text-xs text-gray-400">Texte principal</span><textarea value={f.primaryText} onChange={(e) => setF({ ...f, primaryText: e.target.value })} rows={4} maxLength={2000} className={input} /></label>
          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <label className="space-y-1"><span className="text-xs text-gray-400">Titre</span><input value={f.headline} onChange={(e) => setF({ ...f, headline: e.target.value })} maxLength={255} className={input} /></label>
            <label className="space-y-1"><span className="text-xs text-gray-400">Description</span><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={255} className={input} /></label>
            <label className="space-y-1"><span className="text-xs text-gray-400">Lien (https)</span><input value={f.linkUrl} onChange={(e) => setF({ ...f, linkUrl: e.target.value })} className={input} /></label>
            <label className="space-y-1"><span className="text-xs text-gray-400">Bouton</span>
              <select value={f.callToAction} onChange={(e) => setF({ ...f, callToAction: e.target.value })} className={input}>
                {CALL_TO_ACTIONS.map((c) => <option key={c} value={c}>{CTA_FR[c] ?? c}</option>)}
              </select>
            </label>
          </div>
          <div className="rounded-lg border border-gray-800 px-3 py-2 text-xs"><span className="text-gray-500">Ce qui changera : </span>{diff.length ? <span className="text-gray-200">{diff.join(" ; ")}</span> : <span className="text-gray-500">rien pour le moment</span>}</div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={submit} disabled={!diff.length} className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm disabled:opacity-40">Ajouter aux modifications</button>
            <button type="button" onClick={onCancel} className="text-sm text-gray-400 hover:text-white">Annuler</button>
          </div>
        </>
      )}
    </Shell>
  );
}

function AssetList({ label, items, max, min, maxItems, pins, onChange }: { label: string; items: RsaAsset[]; max: number; min: number; maxItems: number; pins: string[]; onChange: (items: RsaAsset[]) => void }) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-gray-400">{label} ({min}–{maxItems}, {max} caractères)</span>
      {items.map((a, i) => (
        <div key={i} className="flex items-center gap-2">
          <input value={a.text} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} maxLength={max} className={`${input} ${a.text.length > max ? "border-red-500" : ""}`} />
          <span className={`text-[10px] w-10 text-right ${a.text.length > max ? "text-red-300" : "text-gray-500"}`}>{a.text.length}/{max}</span>
          <select value={a.pinnedField ?? ""} onChange={(e) => onChange(items.map((x, j) => (j === i ? (e.target.value ? { ...x, pinnedField: e.target.value } : { text: x.text }) : x)))} className="bg-gray-950 border border-gray-800 rounded-md px-1 py-1 text-[11px] text-gray-300" title="Épingler à une position">
            <option value="">libre</option>
            {pins.map((p) => <option key={p} value={p}>{p.replace("HEADLINE_", "titre ").replace("DESCRIPTION_", "desc. ")}</option>)}
          </select>
          <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-gray-500 hover:text-red-300" aria-label="Retirer"><X className="w-3.5 h-3.5" /></button>
        </div>
      ))}
      {items.length < maxItems && <button type="button" onClick={() => onChange([...items, { text: "" }])} className="text-xs text-gray-400 hover:text-white flex items-center gap-1"><Plus className="w-3 h-3" /> Ajouter</button>}
    </div>
  );
}

export function RsaTextsForm({ adName, current, onCancel, onDone }: { adName: string; current: RsaSpec; onCancel: () => void; onDone: (json: string, label: string) => void }) {
  const [f, setF] = useState<RsaSpec>(() => JSON.parse(JSON.stringify(current)));
  const [error, setError] = useState<string | null>(null);
  const diff = rsaDiff(current, { ...f, headlines: f.headlines.filter((h) => h.text.trim()), descriptions: f.descriptions.filter((d) => d.text.trim()) });
  function submit() {
    const read = readRsa(f);
    if (!read.ok) { setError(read.error); return; }
    if (!diff.length) { setError("Rien n'a changé."); return; }
    onDone(JSON.stringify(read.spec), `Annonce « ${adName} » : nouvelle version — ${diff.join(" ; ")}`);
  }
  return (
    <Shell title={`Textes — « ${adName} »`} onCancel={onCancel}>
      <p className="text-xs text-gray-400">Google Ads ne modifie pas une annonce responsive : une nouvelle annonce est créée dans le même groupe avec ces textes, et celle-ci est mise en pause. Pour revenir en arrière : réactiver celle-ci et mettre la nouvelle en pause.</p>
      <AssetList label="Titres" items={f.headlines} max={RSA_HEADLINE_MAX} min={RSA_HEADLINES.min} maxItems={RSA_HEADLINES.max} pins={RSA_PINS.filter((p) => p.startsWith("HEADLINE"))} onChange={(headlines) => setF({ ...f, headlines })} />
      <AssetList label="Descriptions" items={f.descriptions} max={RSA_DESCRIPTION_MAX} min={RSA_DESCRIPTIONS.min} maxItems={RSA_DESCRIPTIONS.max} pins={RSA_PINS.filter((p) => p.startsWith("DESCRIPTION"))} onChange={(descriptions) => setF({ ...f, descriptions })} />
      <div className="grid sm:grid-cols-3 gap-3 text-sm">
        <label className="space-y-1 sm:col-span-1"><span className="text-xs text-gray-400">URL finale</span><input value={f.finalUrls[0] ?? ""} onChange={(e) => setF({ ...f, finalUrls: [e.target.value] })} className={input} /></label>
        <label className="space-y-1"><span className="text-xs text-gray-400">Chemin 1</span><input value={f.path1} onChange={(e) => setF({ ...f, path1: e.target.value })} maxLength={15} className={input} /></label>
        <label className="space-y-1"><span className="text-xs text-gray-400">Chemin 2</span><input value={f.path2} onChange={(e) => setF({ ...f, path2: e.target.value })} maxLength={15} className={input} /></label>
      </div>
      <div className="rounded-lg border border-gray-800 px-3 py-2 text-xs"><span className="text-gray-500">Ce qui changera : </span>{diff.length ? <span className="text-gray-200">{diff.join(" ; ")}</span> : <span className="text-gray-500">rien pour le moment</span>}</div>
      {error && <p className="text-xs text-red-300">{error}</p>}
      <div className="flex items-center gap-3">
        <button type="button" onClick={submit} disabled={!diff.length} className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm disabled:opacity-40">Ajouter aux modifications</button>
        <button type="button" onClick={onCancel} className="text-sm text-gray-400 hover:text-white">Annuler</button>
      </div>
    </Shell>
  );
}
