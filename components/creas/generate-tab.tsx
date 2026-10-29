"use client";

/**
 * The « Générer » tab of /creas (ex Studio créa, /studio redirects here): a
 * free prompt turned into images (fal.ai or Agnes) or a video (Agnes) for the
 * client selected on the page. References: files, or the client's brand
 * assets in one click. The engine shows its price per image; until the
 * consultant picks one, the cheapest that fits is used (FLUX Schnell without
 * reference, the cheapest edit model with one). Results land in « Créas
 * générées » (origin « studio ») with the price reminder and the daily caps
 * of lib/quotas.ts.
 */

import { useMemo, useRef, useState } from "react";
import { Clapperboard, ImageIcon, ImagePlus, Loader2, Wand2, X } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { prepareImage } from "@/lib/ai-chat-shared";
import { BTN, BTN_PRIMARY, FIELD, aspect, cheapestEngine, enginePrice, priceReminder, usd, when, type Asset, type ClientOption, type Engine, type QuotaInfo } from "./shared";

type Kind = "image" | "video";
type Quality = "fast" | "hd";
type Mode = "free" | "edit" | "product";
interface Ref { name: string; dataUri: string; assetId?: string }

const SCENES: Array<[string, string]> = [["studio", "Studio, fond blanc"], ["lifestyle", "Intérieur lifestyle"], ["outdoor", "Extérieur, lumière naturelle"], ["usage", "En situation d'usage"], ["seasonal", "Saisonnier (hiver, fêtes)"], ["flatlay", "Vue de dessus (flat lay)"], ["custom", "Décor personnalisé…"]];
const IMAGE_RATIOS: Array<[string, string]> = [["1:1", "Carré 1:1 — feed"], ["3:4", "Portrait 3:4 — feed"], ["9:16", "Vertical 9:16 — stories, reels"], ["16:9", "Paysage 16:9 — YouTube, display"], ["4:3", "Paysage 4:3"], ["2:3", "Portrait 2:3"], ["3:2", "Paysage 3:2"]];
const VIDEO_RATIOS: Array<[string, string]> = [["9:16", "Vertical 9:16 — stories, reels"], ["1:1", "Carré 1:1 — feed"], ["3:4", "Portrait 3:4"], ["16:9", "Paysage 16:9 — YouTube"], ["4:3", "Paysage 4:3"]];
const MAX_REFS = 3;
/** List price of a second of HD video (lib/studio.ts VIDEO_QUALITIES.hd), « Rapide » is free. */
const HD_USD_PER_SECOND = 0.04;

async function fileToRef(file: File, assetId?: string): Promise<Ref> {
  const img = await prepareImage(file);
  return { name: file.name, dataUri: `data:${img.mediaType};base64,${img.data}`, ...(assetId ? { assetId } : {}) };
}

export function GenerateTab({ client, engines, quota, brandAssets, recent, source, onSourceUsed, onCreated, onOpen, onQuotaChanged }: {
  client: ClientOption; engines: Engine[]; quota: QuotaInfo | null; brandAssets: Asset[];
  /** The client's latest free generations (origin « studio »), newest first. */
  recent: Asset[];
  /** « Animer en vidéo » from a créa: the video starts from this image. */
  source: Asset | null; onSourceUsed: () => void;
  onCreated: (assets: Asset[]) => void; onOpen: (a: Asset) => void; onQuotaChanged: () => void;
}) {
  const [kind, setKind] = useState<Kind>(source ? "video" : "image");
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState(source ? (VIDEO_RATIOS.some(([r]) => r === source.params.ratio) ? String(source.params.ratio) : "9:16") : "1:1");
  const [size, setSize] = useState<"1K" | "2K">("2K");
  // null = not chosen by the consultant: the cheapest engine that fits.
  const [chosenEngine, setChosenEngine] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("free");
  const [scene, setScene] = useState("studio");
  const [sceneCustom, setSceneCustom] = useState("");
  const [textless, setTextless] = useState(true);
  const [enhance, setEnhance] = useState(true);
  const [variants, setVariants] = useState(1);
  const [seconds, setSeconds] = useState(5);
  const [quality, setQuality] = useState<Quality>("fast");
  const [refs, setRefs] = useState<Ref[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // A new « Animer en vidéo » while the tab is open: switch to video (state adjusted during render, no effect).
  const [seenSource, setSeenSource] = useState<string | null>(source?.id ?? null);
  if ((source?.id ?? null) !== seenSource) {
    setSeenSource(source?.id ?? null);
    if (source) {
      setKind("video");
      setRefs([]);
      setRatio(VIDEO_RATIOS.some(([r]) => r === source.params.ratio) ? String(source.params.ratio) : "9:16");
    }
  }

  const withRefs = kind === "image" && refs.length > 0;
  const sorted = useMemo(() => [...engines].sort((a, b) => a.usd - b.usd || a.label.localeCompare(b.label)), [engines]);
  const chosen = chosenEngine ? engines.find((e) => e.id === chosenEngine) ?? null : null;
  // A text-only engine with references: the cheapest that takes them (the relay would switch to a pricier edit model).
  const engine = chosen && (!withRefs || chosen.refs) ? chosen : cheapestEngine(engines, withRefs);
  const switched = !!chosen && engine?.id !== chosen.id;
  const engineId = engine?.id ?? "agnes-image-2.5-flash";

  const unitUsd = kind === "image" ? engine?.usd ?? 0 : quality === "hd" ? Math.round(HD_USD_PER_SECOND * seconds * 1000) / 1000 : 0;
  const n = kind === "image" ? variants : 1;
  const reminder = priceReminder(quota, unitUsd, n);

  function switchKind(k: Kind) {
    setKind(k);
    setRatio(k === "image" ? "1:1" : "9:16");
    setRefs((r) => (k === "video" ? r.slice(0, 1) : r));
    if (k === "image" && source) onSourceUsed();
    setError(null);
  }

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    try {
      const max = kind === "image" ? MAX_REFS : 1;
      const next = await Promise.all([...files].slice(0, max).map((f) => fileToRef(f)));
      setRefs((r) => (kind === "image" ? [...r, ...next].slice(0, MAX_REFS) : next.slice(0, 1)));
      if (kind === "video" && source) onSourceUsed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // A brand asset (logo, packshot) as a reference: read through the app's own download route (same origin).
  async function addBrandAsset(a: Asset) {
    if (!a.downloadUrl || refs.some((r) => r.assetId === a.id)) return;
    try {
      const res = await fetch(`${a.downloadUrl}?inline=1`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Élément illisible (${res.status})`);
      const blob = await res.blob();
      const ref = await fileToRef(new File([blob], a.prompt || "element", { type: blob.type || "image/png" }), a.id);
      setRefs((r) => (kind === "image" ? [...r, ref].slice(0, MAX_REFS) : [ref]));
      if (kind === "video" && source) onSourceUsed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function generate() {
    if (prompt.trim().length < 3 || busy || reminder?.over) return;
    setBusy(true);
    setError(null);
    try {
      const body = kind === "image"
        ? {
            kind, prompt, ratio, size, engine: engineId.startsWith("fal-ai/") ? engineId : undefined, clientId: client.clientId, images: refs.map((r) => r.dataUri),
            mode: mode === "free" && refs.length ? "edit" : mode, scene: mode === "product" && scene !== "custom" ? scene : undefined,
            sceneCustom: mode === "product" && scene === "custom" ? sceneCustom : undefined, textless, enhance, variants,
          }
        : { kind, prompt, ratio, seconds, quality, enhance, clientId: client.clientId, sourceId: source?.id, image: !source && refs[0] ? refs[0].dataUri : undefined };
      const res = await fetch("/api/studio/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { asset?: Asset; assets?: Asset[]; failed?: number; error?: string };
      if (!res.ok || !j.asset) throw new Error(j.error ?? `Erreur ${res.status}`);
      const created = j.assets ?? [j.asset];
      onCreated(created);
      onQuotaChanged();
      if (kind === "image" && created.length === 1) onOpen(created[0]);
      if (j.failed) setError(`${j.failed} variante(s) sur ${created.length + j.failed} n'ont pas pu être générées.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const tab = (k: Kind, label: string, Icon: typeof ImageIcon) => (
    <button key={k} type="button" onClick={() => switchKind(k)} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border ${kind === k ? "bg-violet-600 border-violet-500 text-white" : "border-gray-800 text-gray-300 hover:text-white"}`}>
      <Icon className="w-4 h-4" /> {label}
    </button>
  );

  return (
    <div className="space-y-4" data-generate-tab>
      <div className="rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {tab("image", "Image", ImageIcon)}
          {tab("video", "Vidéo", Clapperboard)}
          <span className="ml-auto text-xs text-gray-500">Pour <span className="text-gray-200">{client.name}</span> · seuls votre texte et vos images sont envoyés, aucune donnée de compte.</span>
        </div>

        {kind === "video" && source && (
          <div className="flex items-center gap-3 rounded-lg border border-violet-500/40 bg-violet-500/5 p-2">
            {source.url && <img src={source.url} alt="" className="w-14 h-14 object-cover rounded" />}
            <span className="text-xs text-gray-300 flex-1">La vidéo partira de ce visuel (première image). Décrivez le mouvement, la caméra, l&apos;ambiance.</span>
            <button type="button" onClick={onSourceUsed} className="text-gray-500 hover:text-white" aria-label="Retirer"><X className="w-4 h-4" /></button>
          </div>
        )}

        {kind === "image" && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {([["free", "Création libre"], ["edit", "Modifier une image"], ["product", "Photo produit"]] as const).map(([m, l]) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={`px-2.5 py-1 rounded-md border ${mode === m ? "border-violet-500 text-white bg-violet-500/10" : "border-gray-800 text-gray-400 hover:text-white"}`}>{l}</button>
            ))}
            {mode === "product" && (
              <>
                <select value={scene} onChange={(e) => setScene(e.target.value)} className={FIELD}>
                  {SCENES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {scene === "custom" && <input value={sceneCustom} onChange={(e) => setSceneCustom(e.target.value)} placeholder="Ex. : sur un comptoir de cuisine en marbre" className={`${FIELD} min-w-[16rem]`} />}
              </>
            )}
            <span className="text-gray-500">
              {mode === "product" ? "Ajoutez la photo du produit : il est gardé identique, seul le décor change." : mode === "edit" ? "Ajoutez l'image à modifier et dites ce qui change." : ""}
            </span>
          </div>
        )}

        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
          placeholder={kind === "image"
            ? "Ex. : photo produit d'une gourde isotherme sur une plage ensoleillée, lumière douce, espace libre à gauche pour le texte"
            : "Ex. : les vagues roulent en arrière-plan, reflets de soleil sur la gourde, lent travelling avant"}
          className="w-full resize-y bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-violet-500" />

        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Format
            <select value={ratio} onChange={(e) => setRatio(e.target.value)} className={FIELD}>
              {(kind === "image" ? IMAGE_RATIOS : VIDEO_RATIOS).map(([r, l]) => <option key={r} value={r}>{l}</option>)}
            </select>
          </label>
          {kind === "image" ? (
            <>
              <label className="flex flex-col gap-1 text-xs text-gray-400">
                Moteur{chosenEngine ? "" : " (le moins cher qui convient)"}
                <select value={engineId} onChange={(e) => setChosenEngine(e.target.value)} className={`${FIELD} max-w-[22rem]`} data-engine-select
                  title={engine ? `${engine.provider === "fal" ? "fal.ai" : "Agnes"} · ${engine.refs ? "accepte des images de référence" : "texte seul, sans image de référence"} · ${enginePrice(engine)}` : undefined}>
                  {sorted.length
                    ? sorted.map((e) => <option key={e.id} value={e.id} disabled={withRefs && !e.refs}>{e.label} · {enginePrice(e)}{e.refs ? "" : " · sans image de réf."}</option>)
                    : <option value={engineId}>Agnes 2.5 Flash · gratuit</option>}
                </select>
              </label>
              {!engineId.startsWith("fal-ai/") && (
                <label className="flex flex-col gap-1 text-xs text-gray-400">
                  Définition
                  <select value={size} onChange={(e) => setSize(e.target.value as "1K" | "2K")} className={FIELD}>
                    <option value="2K">Haute (2K)</option>
                    <option value="1K">Standard (1K)</option>
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1 text-xs text-gray-400">
                Variantes
                <select value={variants} onChange={(e) => setVariants(Number(e.target.value))} className={FIELD}>
                  {[1, 2, 3, 4].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-xs text-gray-400">
                Durée : {seconds} s
                <input type="range" min={4} max={12} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className="w-40" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-gray-400">
                Qualité
                <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)} className={FIELD}>
                  <option value="fast">Rapide — 720p, gratuit</option>
                  <option value="hd">HD — 1080p, ≈ {usd(HD_USD_PER_SECOND * seconds)}</option>
                </select>
              </label>
            </>
          )}
          <div className="flex flex-col gap-1 text-xs text-gray-400">
            {kind === "image" ? `Images de référence (facultatif, ${MAX_REFS} max)` : "Photo à animer (facultatif)"}
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => fileRef.current?.click()} className={BTN}><ImagePlus className="w-4 h-4" /> Ajouter</button>
              {refs.map((r, i) => (
                <span key={i} className="relative">
                  <img src={r.dataUri} alt={r.name} className="w-9 h-9 object-cover rounded" />
                  <button type="button" onClick={() => setRefs((l) => l.filter((_, j) => j !== i))} className="absolute -top-1.5 -right-1.5 bg-gray-900 rounded-full text-gray-400 hover:text-white" aria-label="Retirer"><X className="w-3 h-3" /></button>
                </span>
              ))}
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple={kind === "image"} className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
          </div>
          <button type="button" onClick={() => void generate()} disabled={busy || prompt.trim().length < 3 || !!reminder?.over} className={`${BTN_PRIMARY} ml-auto px-4 py-2`} data-generate>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
            {busy ? (kind === "image" ? "Génération… (jusqu'à une minute)" : "Lancement…") : kind === "image" ? (variants > 1 ? `Générer ${variants} images` : "Générer l'image") : "Générer la vidéo"}
          </button>
        </div>

        {brandAssets.length > 0 && (kind === "image" || !source) && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
            <span>Éléments de marque de {client.name} :</span>
            {brandAssets.slice(0, 12).map((a) => {
              const used = refs.some((r) => r.assetId === a.id);
              return (
                <button key={a.id} type="button" onClick={() => void addBrandAsset(a)} disabled={used || (kind === "image" && refs.length >= MAX_REFS)} title={used ? "Déjà en référence" : `Ajouter « ${a.prompt} » en référence`}
                  className={`w-9 h-9 rounded border overflow-hidden bg-gray-900 disabled:opacity-40 ${used ? "border-violet-500" : "border-gray-800 hover:border-violet-500/60"}`}>
                  {a.url && <img src={a.url} alt={a.prompt} className="w-full h-full object-contain" />}
                </button>
              );
            })}
          </div>
        )}

        {switched && chosen && <p className="text-[12px] text-amber-300">{chosen.label} ne prend pas d&apos;image de référence : {engine?.label} ({engine ? enginePrice(engine) : ""}) sera utilisé.</p>}
        {reminder && (
          <p className={`text-[12px] ${reminder.over ? "text-rose-300" : reminder.warn ? "text-amber-300" : "text-gray-400"}`} title="Plafonds journaliers posés par les admins (Admin → Quotas)">
            {reminder.over ? "Plafond du jour atteint — " : reminder.warn ? "Proche du plafond — " : ""}{reminder.text}
          </p>
        )}
        <div className="flex flex-wrap gap-4 text-xs text-gray-400">
          <label className="flex items-center gap-1.5" title="Votre demande est réécrite en consigne précise (ce qui reste identique, ce qui change, une seule image) par le modèle texte d'Agnes, gratuit."><input type="checkbox" checked={enhance} onChange={(e) => setEnhance(e.target.checked)} /> Améliorer ma consigne (recommandé, gratuit)</label>
          {kind === "image" && <label className="flex items-center gap-1.5" title="L'IA dessine mal les textes et les logos : posez-les ensuite exactement avec « Textes & logo »."><input type="checkbox" checked={textless} onChange={(e) => setTextless(e.target.checked)} /> Sans texte ni logo dans l&apos;image (je les pose ensuite)</label>}
        </div>
        {kind === "video" && <p className="text-[11px] text-gray-500">Une vidéo prend en général 1 à 3 minutes : elle apparaît dans « Créas générées » dès qu&apos;elle est prête, vous pouvez continuer à travailler.</p>}
        {error && <p className="text-sm text-rose-300">{error}</p>}
      </div>

      {recent.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-gray-400">Dernières générations libres pour {client.name}</div>
          <ul className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {recent.slice(0, 12).map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => onOpen(a)} className="w-full text-left rounded-xl border border-gray-800 hover:border-violet-500/60 overflow-hidden bg-gray-950">
                  <div className="relative bg-gray-900 flex items-center justify-center" style={{ aspectRatio: aspect(a.params.ratio) }}>
                    {a.status === "completed" && a.url
                      ? (a.kind === "video" ? <video src={a.url} className="w-full h-full object-cover" muted loop playsInline onMouseEnter={(e) => void e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} /> : <img src={a.url} alt={a.prompt} className="w-full h-full object-cover" loading="lazy" />)
                      : a.status === "failed" ? <span className="text-xs text-rose-300 px-2 text-center">Échec</span>
                      : <span className="text-xs text-gray-400 flex flex-col items-center gap-1"><Loader2 className="w-4 h-4 animate-spin" />{a.progress ? `${a.progress} %` : "En cours…"}</span>}
                    <span className="absolute top-1 left-1"><Pill className="text-[10px]">{a.kind === "video" ? `Vidéo ${String(a.params.seconds ?? "")} s` : "Image"}</Pill></span>
                  </div>
                  <p className="px-2 py-1.5 text-[10px] text-gray-500 truncate">{a.createdByName} · {when(a.createdAt)}{a.costUsd > 0 ? ` · ${usd(a.costUsd)}` : ""}</p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
