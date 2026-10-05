"use client";

/**
 * Studio créa — a consultant describes a visual or a video for a client's ads,
 * Agnes AI generates it (through the relay), it lands in the gallery of the
 * team: preview, download, « Animer en vidéo », reuse the prompt.
 *
 * Images come back at once; videos are followed every few seconds until they
 * are ready (GET /api/studio/assets/[id]).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard, Download, ImageIcon, ImagePlus, Loader2, RotateCcw, Send, Trash2, Type, Wand2, X } from "lucide-react";
import { TextEditor } from "@/components/studio/text-editor";
import { Card, PageHeader, Pill, Section } from "@/components/ui/surface";
import { prepareImage } from "@/lib/ai-chat-shared";

type Kind = "image" | "video";
type Quality = "fast" | "hd";
type Mode = "free" | "edit" | "product";
const SCENES: Array<[string, string]> = [["studio", "Studio, fond blanc"], ["lifestyle", "Intérieur lifestyle"], ["outdoor", "Extérieur, lumière naturelle"], ["usage", "En situation d'usage"], ["seasonal", "Saisonnier (hiver, fêtes)"], ["flatlay", "Vue de dessus (flat lay)"], ["custom", "Décor personnalisé…"]];

interface Asset {
  id: string; kind: Kind; status: string; progress: number; prompt: string; model: string;
  clientId: string | null; clientName: string; createdByName: string; createdAt: string; mine: boolean;
  params: { ratio?: string; size?: string; seconds?: number; quality?: Quality; fromImage?: boolean; references?: number; mode?: Mode; promptSent?: string; note?: string; enhanced?: boolean; composite?: boolean; textless?: boolean };
  url: string | null; downloadUrl: string | null; hasCopy: boolean; error: string | null; costUsd: number; sourceId: string | null;
}
interface Client { id: string; name: string }
interface Ref { name: string; dataUri: string }

const IMAGE_RATIOS: Array<[string, string]> = [["1:1", "Carré 1:1 — feed"], ["3:4", "Portrait 3:4 — feed"], ["9:16", "Vertical 9:16 — stories, reels"], ["16:9", "Paysage 16:9 — YouTube, display"], ["4:3", "Paysage 4:3"], ["2:3", "Portrait 2:3"], ["3:2", "Paysage 3:2"]];
const VIDEO_RATIOS: Array<[string, string]> = [["9:16", "Vertical 9:16 — stories, reels"], ["1:1", "Carré 1:1 — feed"], ["3:4", "Portrait 3:4"], ["16:9", "Paysage 16:9 — YouTube"], ["4:3", "Paysage 4:3"]];

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const when = (iso: string) => new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const pending = (a: Asset) => a.status === "queued" || a.status === "in_progress";
const aspect = (r?: string) => { const [w, h] = (r ?? "1:1").split(":").map(Number); return w && h ? `${w} / ${h}` : "1 / 1"; };

async function toDataUri(file: File): Promise<Ref> {
  const img = await prepareImage(file);
  return { name: file.name, dataUri: `data:${img.mediaType};base64,${img.data}` };
}

export function StudioPage() {
  const [kind, setKind] = useState<Kind>("image");
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("1:1");
  const [size, setSize] = useState<"1K" | "2K">("2K");
  const [mode, setMode] = useState<Mode>("free");
  const [scene, setScene] = useState("studio");
  const [sceneCustom, setSceneCustom] = useState("");
  const [textless, setTextless] = useState(true);
  const [enhance, setEnhance] = useState(true);
  const [variants, setVariants] = useState(2);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [seconds, setSeconds] = useState(5);
  const [quality, setQuality] = useState<Quality>("fast");
  const [refs, setRefs] = useState<Ref[]>([]);
  const [source, setSource] = useState<Asset | null>(null);
  const [clientId, setClientId] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [hd, setHd] = useState<{ usedToday: number; perDay: number; usdPerSecond: number } | null>(null);
  const [filter, setFilter] = useState<{ mine: boolean; clientId: string; kind: "" | Kind }>({ mine: false, clientId: "", kind: "" });
  const [open, setOpen] = useState<Asset | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (filter.mine) q.set("mine", "1");
    if (filter.clientId) q.set("clientId", filter.clientId);
    const res = await fetch(`/api/studio/assets?${q}`);
    const j = await res.json().catch(() => ({}));
    if (res.ok) { setAssets(j.assets ?? []); setHd(j.hd ?? null); }
    else setError(j.error ?? `Erreur ${res.status}`);
  }, [filter.mine, filter.clientId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    fetch("/api/pilot/clients").then((r) => (r.ok ? r.json() : { clients: [] })).then((j) => setClients((j.clients ?? []).map((c: Client) => ({ id: c.id, name: c.name })))).catch(() => {});
  }, []);

  // Videos in progress: asked again every 6 seconds.
  const inProgress = useMemo(() => (assets ?? []).filter(pending).map((a) => a.id), [assets]);
  useEffect(() => {
    if (!inProgress.length) return;
    const t = setInterval(async () => {
      const fresh = await Promise.all(inProgress.map((id) => fetch(`/api/studio/assets/${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
      setAssets((list) => (list ?? []).map((a) => fresh.find((f) => f?.asset?.id === a.id)?.asset ?? a));
    }, 6000);
    return () => clearInterval(t);
  }, [inProgress]);

  function switchKind(k: Kind) {
    setKind(k);
    setRatio(k === "image" ? "1:1" : "9:16");
    setError(null);
  }

  function animate(a: Asset) {
    setKind("video");
    setSource(a);
    setRefs([]);
    setRatio(VIDEO_RATIOS.some(([r]) => r === a.params.ratio) ? a.params.ratio! : "9:16");
    setPrompt("");
    setClientId(a.clientId ?? "");
    setOpen(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function reuse(a: Asset) {
    switchKind(a.kind);
    setPrompt(a.prompt);
    if (a.params.ratio) setRatio(a.params.ratio);
    setClientId(a.clientId ?? "");
    setOpen(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    try {
      const max = kind === "image" ? 3 : 1;
      const next = await Promise.all([...files].slice(0, max).map(toDataUri));
      setRefs((r) => (kind === "image" ? [...r, ...next].slice(0, 3) : next.slice(0, 1)));
      if (kind === "video") setSource(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function generate() {
    if (prompt.trim().length < 3 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = kind === "image"
        ? {
            kind, prompt, ratio, size, clientId: clientId || undefined, images: refs.map((r) => r.dataUri),
            mode: mode === "free" && refs.length ? "edit" : mode, scene: mode === "product" && scene !== "custom" ? scene : undefined,
            sceneCustom: mode === "product" && scene === "custom" ? sceneCustom : undefined, textless, enhance, variants,
          }
        : { kind, prompt, ratio, seconds, quality, enhance, clientId: clientId || undefined, sourceId: source?.id, image: !source && refs[0] ? refs[0].dataUri : undefined };
      const res = await fetch("/api/studio/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.asset) throw new Error(j.error ?? `Erreur ${res.status}`);
      const created: Asset[] = j.assets ?? [j.asset];
      setAssets((list) => [...created, ...(list ?? [])]);
      if (kind === "image" && created.length === 1) setOpen(created[0]);
      if (j.failed) setError(`${j.failed} variante(s) sur ${created.length + j.failed} n'ont pas pu être générées.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: Asset) {
    if (!confirm("Retirer cette création du Studio ?")) return;
    const res = await fetch(`/api/studio/assets/${a.id}`, { method: "DELETE" });
    if (res.ok) { setAssets((list) => (list ?? []).filter((x) => x.id !== a.id)); setOpen(null); }
  }

  const shown = (assets ?? []).filter((a) => !filter.kind || a.kind === filter.kind);
  const hdCost = hd ? Math.round(hd.usdPerSecond * seconds * 100) / 100 : 0;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
      <PageHeader
        title="Studio créa"
        subtitle="Générez des visuels et des vidéos publicitaires pour vos clients (Agnes AI). Seuls votre texte et les images que vous ajoutez sont envoyés — aucune donnée de compte."
      />

      <Card padded>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {(["image", "video"] as const).map((k) => (
              <button key={k} type="button" onClick={() => switchKind(k)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border ${kind === k ? "bg-violet-600 border-violet-500 text-white" : "border-gray-800 text-gray-300 hover:text-white"}`}>
                {k === "image" ? <ImageIcon className="w-4 h-4" /> : <Clapperboard className="w-4 h-4" />} {k === "image" ? "Image" : "Vidéo"}
              </button>
            ))}
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="ml-auto bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-sm text-white max-w-[16rem]">
              <option value="">Client (facultatif)</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {kind === "video" && source && (
            <div className="flex items-center gap-3 rounded-lg border border-violet-500/40 bg-violet-500/5 p-2">
              {source.url && <img src={source.url} alt="" className="w-14 h-14 object-cover rounded" />}
              <span className="text-xs text-gray-300 flex-1">La vidéo partira de ce visuel (première image). Décrivez le mouvement, la caméra, l&apos;ambiance.</span>
              <button type="button" onClick={() => setSource(null)} className="text-gray-500 hover:text-white" aria-label="Retirer"><X className="w-4 h-4" /></button>
            </div>
          )}

          {kind === "image" && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {([["free", "Création libre"], ["edit", "Modifier une image"], ["product", "Photo produit"]] as const).map(([m, l]) => (
                <button key={m} type="button" onClick={() => setMode(m)} className={`px-2.5 py-1 rounded-md border ${mode === m ? "border-violet-500 text-white bg-violet-500/10" : "border-gray-800 text-gray-400 hover:text-white"}`}>{l}</button>
              ))}
              {mode === "product" && (
                <>
                  <select value={scene} onChange={(e) => setScene(e.target.value)} className="bg-gray-950 border border-gray-800 rounded-md px-2 py-1 text-gray-200">
                    {SCENES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  {scene === "custom" && <input value={sceneCustom} onChange={(e) => setSceneCustom(e.target.value)} placeholder="Ex. : sur un comptoir de cuisine en marbre" className="bg-gray-950 border border-gray-800 rounded-md px-2 py-1 text-gray-200 min-w-[16rem]" />}
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
              <select value={ratio} onChange={(e) => setRatio(e.target.value)} className="bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-sm text-white">
                {(kind === "image" ? IMAGE_RATIOS : VIDEO_RATIOS).map(([r, l]) => <option key={r} value={r}>{l}</option>)}
              </select>
            </label>
            {kind === "image" ? (
              <>
              <label className="flex flex-col gap-1 text-xs text-gray-400">
                Définition
                <select value={size} onChange={(e) => setSize(e.target.value as "1K" | "2K")} className="bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-sm text-white">
                  <option value="2K">Haute (2K)</option>
                  <option value="1K">Standard (1K)</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-gray-400">
                Variantes
                <select value={variants} onChange={(e) => setVariants(Number(e.target.value))} className="bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-sm text-white">
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
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
                  <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)} className="bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-sm text-white">
                    <option value="fast">Rapide — 720p, gratuit</option>
                    <option value="hd">HD — 1080p, ≈ {hdCost.toFixed(2)} $</option>
                  </select>
                </label>
              </>
            )}
            <div className="flex flex-col gap-1 text-xs text-gray-400">
              {kind === "image" ? "Images de référence (facultatif, 3 max)" : "Photo à animer (facultatif)"}
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-gray-800 text-gray-300 hover:text-white">
                  <ImagePlus className="w-4 h-4" /> Ajouter
                </button>
                {refs.map((r, i) => (
                  <span key={i} className="relative">
                    <img src={r.dataUri} alt={r.name} className="w-9 h-9 object-cover rounded" />
                    <button type="button" onClick={() => setRefs((l) => l.filter((_, j) => j !== i))} className="absolute -top-1.5 -right-1.5 bg-gray-900 rounded-full text-gray-400 hover:text-white"><X className="w-3 h-3" /></button>
                  </span>
                ))}
              </div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple={kind === "image"} className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
            </div>
            <button type="button" onClick={() => void generate()} disabled={busy || prompt.trim().length < 3}
              className="ml-auto flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white font-medium">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              {busy ? (kind === "image" ? "Génération… (jusqu'à une minute)" : "Lancement…") : kind === "image" ? "Générer l'image" : "Générer la vidéo"}
            </button>
          </div>
          <div className="flex flex-wrap gap-4 text-xs text-gray-400">
            <label className="flex items-center gap-1.5" title="Votre demande est réécrite en consigne précise (ce qui reste identique, ce qui change, une seule image) par le modèle texte d'Agnes, gratuit."><input type="checkbox" checked={enhance} onChange={(e) => setEnhance(e.target.checked)} /> Améliorer ma consigne (recommandé)</label>
            {kind === "image" && <label className="flex items-center gap-1.5" title="L'IA dessine mal les textes et les logos : posez-les ensuite exactement avec « Textes & logo »."><input type="checkbox" checked={textless} onChange={(e) => setTextless(e.target.checked)} /> Sans texte ni logo dans l&apos;image (je les pose ensuite)</label>}
          </div>
          {kind === "video" && quality === "hd" && hd && <p className="text-[11px] text-gray-500">HD utilisée sur 24 h par l&apos;équipe : {hd.usedToday} s sur {hd.perDay} s.</p>}
          {kind === "video" && <p className="text-[11px] text-gray-500">Une vidéo prend en général 1 à 3 minutes : elle apparaît dans la galerie dès qu&apos;elle est prête, vous pouvez continuer à travailler.</p>}
          {error && <p className="text-sm text-red-300">{error}</p>}
        </div>
      </Card>

      <Section title="Galerie de l'équipe">
        <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
          {([["", "Tout"], ["image", "Images"], ["video", "Vidéos"]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setFilter((f) => ({ ...f, kind: k }))} className={`px-2.5 py-1 rounded-md border ${filter.kind === k ? "border-violet-500 text-white" : "border-gray-800 text-gray-400 hover:text-white"}`}>{l}</button>
          ))}
          <label className="flex items-center gap-1.5 text-gray-400 ml-2"><input type="checkbox" checked={filter.mine} onChange={(e) => setFilter((f) => ({ ...f, mine: e.target.checked }))} /> Les miennes</label>
          <select value={filter.clientId} onChange={(e) => setFilter((f) => ({ ...f, clientId: e.target.value }))} className="bg-gray-950 border border-gray-800 rounded-md px-2 py-1 text-gray-200">
            <option value="">Tous les clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {assets === null ? (
          <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture…</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-gray-500">Rien pour le moment. Décrivez un visuel ci-dessus pour commencer.</p>
        ) : (
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {shown.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => setOpen(a)} className="w-full text-left rounded-xl border border-gray-800 hover:border-violet-500/60 overflow-hidden bg-gray-950">
                  <div className="relative bg-gray-900 flex items-center justify-center" style={{ aspectRatio: aspect(a.params.ratio) }}>
                    {a.status === "completed" && a.url ? (
                      a.kind === "image"
                        ? <img src={a.url} alt={a.prompt} className="w-full h-full object-cover" loading="lazy" />
                        : <video src={a.url} className="w-full h-full object-cover" muted loop playsInline onMouseEnter={(e) => void e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} />
                    ) : a.status === "failed" ? (
                      <span className="text-xs text-red-300 px-3 text-center">Échec : {a.error ?? "génération impossible"}</span>
                    ) : (
                      <span className="text-xs text-gray-400 flex flex-col items-center gap-1"><Loader2 className="w-5 h-5 animate-spin" /> Vidéo en cours{a.progress ? ` · ${a.progress} %` : "…"}</span>
                    )}
                    <span className="absolute top-1.5 left-1.5"><Pill className="text-[10px]">{a.kind === "image" ? (a.params.composite ? "Avec textes" : "Image") : `Vidéo ${a.params.seconds ?? ""} s`}</Pill></span>
                  </div>
                  <div className="px-2.5 py-2 space-y-0.5">
                    <p className="text-xs text-gray-200 line-clamp-2">{a.prompt}</p>
                    <p className="text-[10px] text-gray-500">{a.clientName || "Sans client"} · {a.createdByName} · {when(a.createdAt)}</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {editing && (
        <TextEditor
          asset={editing}
          onClose={() => setEditing(null)}
          onSaved={(a) => { setAssets((list) => [a as Asset, ...(list ?? [])]); setEditing(null); setOpen(a as Asset); }}
        />
      )}

      {open && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setOpen(null)}>
          <div className="bg-gray-950 border border-gray-800 rounded-2xl max-w-4xl w-full max-h-[92vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <span className="text-sm text-white font-semibold">{open.kind === "image" ? "Image" : "Vidéo"} · {open.clientName || "Sans client"}</span>
              <button type="button" onClick={() => setOpen(null)} className="text-gray-400 hover:text-white" aria-label="Fermer"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-3">
              {open.status === "completed" && open.url ? (
                open.kind === "image"
                  ? <img src={open.url} alt={open.prompt} className="max-h-[60vh] mx-auto rounded-lg" />
                  : <video src={open.url} controls autoPlay loop className="max-h-[60vh] mx-auto rounded-lg" />
              ) : <p className="text-sm text-gray-400">{open.status === "failed" ? `Échec : ${open.error}` : "En cours de génération…"}</p>}
              <p className="text-sm text-gray-200 whitespace-pre-wrap">{open.prompt}</p>
              {open.params.note && <p className="text-xs text-violet-300">Compris : {open.params.note}</p>}
              {open.params.promptSent && open.params.promptSent !== open.prompt && (
                <details className="text-xs text-gray-500"><summary className="cursor-pointer hover:text-gray-300">Consigne envoyée à Agnes</summary><p className="mt-1 whitespace-pre-wrap">{open.params.promptSent}</p></details>
              )}
              <p className="text-xs text-gray-500">
                {open.createdByName} · {when(open.createdAt)} · format {open.params.ratio}
                {open.kind === "video" ? ` · ${open.params.seconds} s · ${open.params.quality === "hd" ? "HD 1080p" : "720p"}` : ` · ${open.params.size}`}
                {open.costUsd > 0 ? ` · ≈ ${open.costUsd.toFixed(2)} $` : " · gratuit"}
                {open.hasCopy ? " · copie conservée" : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                {open.downloadUrl && <a href={open.downloadUrl} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm"><Download className="w-4 h-4" /> Télécharger</a>}
                {open.kind === "image" && open.status === "completed" && <button type="button" onClick={() => setEditing(open)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-violet-500/60 text-violet-200 hover:text-white text-sm"><Type className="w-4 h-4" /> Textes & logo</button>}
                {open.kind === "image" && open.status === "completed" && <a href={`/pilotage?studioAsset=${open.id}`} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-violet-500/60 text-violet-200 hover:text-white text-sm"><Send className="w-4 h-4" /> Pousser sur Meta</a>}
                {open.kind === "image" && open.status === "completed" && <button type="button" onClick={() => animate(open)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-700 text-gray-200 hover:text-white text-sm"><Clapperboard className="w-4 h-4" /> Animer en vidéo</button>}
                <button type="button" onClick={() => reuse(open)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-700 text-gray-200 hover:text-white text-sm"><RotateCcw className="w-4 h-4" /> Réutiliser le texte</button>
                {open.mine && <button type="button" onClick={() => void remove(open)} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-red-300 hover:text-red-200 text-sm"><Trash2 className="w-4 h-4" /> Retirer</button>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
