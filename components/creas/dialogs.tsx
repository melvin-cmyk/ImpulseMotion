"use client";

/**
 * Dialogs of Créas: add a template (file / capture / link / Meta Ad Library),
 * « Copier à la marque » (references + brand assets + price), « Plus comme
 * ça », and a brand asset upload. Each shows the price before generating.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Loader2, Search, Wand2, X } from "lucide-react";
import { prepareImage } from "@/lib/ai-chat-shared";
import { BTN, BTN_PRIMARY, FIELD, priceReminder, type Asset, type ClientOption, type Engine, type QuotaInfo, type Template } from "./shared";

async function fileToDataUri(file: File): Promise<string> {
  const img = await prepareImage(file);
  return `data:${img.mediaType};base64,${img.data}`;
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className={`bg-gray-950 border border-gray-800 rounded-2xl w-full ${wide ? "max-w-4xl" : "max-w-2xl"} max-h-[92vh] overflow-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 sticky top-0 bg-gray-950 z-10">
          <span className="text-sm text-white font-semibold">{title}</span>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white" aria-label="Fermer"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-4">{children}</div>
      </div>
    </div>
  );
}

export function PriceLine({ quota, unitUsd, n }: { quota: QuotaInfo | null; unitUsd: number; n: number }) {
  const r = priceReminder(quota, unitUsd, n);
  if (!r) return null;
  return <p className={`text-[12px] ${r.over ? "text-rose-300" : r.warn ? "text-amber-300" : "text-gray-400"}`}>{r.over ? "Plafond du jour atteint — " : r.warn ? "Proche du plafond — " : ""}{r.text}</p>;
}

// ── Add a template ────────────────────────────────────────────────────────

interface LibraryAd { id: string; pageName: string; bodies: string[]; titles: string[]; snapshotUrl: string | null; startedAt: string | null; platforms: string[]; euReach: number | null }

export function AddTemplateDialog({ client, clients, onClose, onCreated }: { client: ClientOption | null; clients: ClientOption[]; onClose: () => void; onCreated: (t: Template) => void }) {
  const [mode, setMode] = useState<"file" | "link" | "library">("file");
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [tags, setTags] = useState("");
  const [owner, setOwner] = useState<string>(client?.clientId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [library, setLibrary] = useState<{ ads: LibraryAd[]; error?: string; configured: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Paste a screenshot (⌘V) anywhere in the dialog.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (!file) return;
      e.preventDefault();
      try { setDataUri(await fileToDataUri(file)); setMode("file"); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  async function search() {
    if (!q.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/creas/ad-library?q=${encodeURIComponent(q.trim())}`);
      setLibrary((await res.json()) as { ads: LibraryAd[]; error?: string; configured: boolean });
    } catch { setLibrary({ ads: [], error: "Recherche impossible.", configured: false }); }
    finally { setSearching(false); }
  }

  async function create(extra?: { title?: string; body?: string; sourceRef?: string; sourceUrl?: string; brand?: string; source?: string }) {
    setBusy(true); setError(null);
    try {
      const body = {
        source: extra?.source ?? (brand.trim() && owner ? "competitor" : "upload"), clientId: owner || undefined, name: name.trim() || undefined, brand: (extra?.brand ?? brand).trim() || undefined,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        ...(mode === "file" && dataUri ? { image: dataUri } : {}), ...(mode === "link" && imageUrl.trim() ? { imageUrl: imageUrl.trim() } : {}), ...extra,
      };
      const res = await fetch("/api/creas/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { template?: Template; error?: string };
      if (!res.ok || !j.template) throw new Error(j.error ?? `Erreur ${res.status}`);
      onCreated(j.template);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const tab = (m: typeof mode, l: string) => <button key={m} type="button" onClick={() => setMode(m)} className={`px-2.5 py-1 rounded-md border text-xs ${mode === m ? "border-violet-500 text-white bg-violet-500/10" : "border-gray-800 text-gray-400 hover:text-white"}`}>{l}</button>;

  return (
    <Modal title="Ajouter un template" onClose={onClose}>
      <div className="flex flex-wrap gap-2">{tab("file", "Fichier ou capture")}{tab("link", "Lien d'une image")}{tab("library", "Bibliothèque publicitaire Meta")}</div>

      {mode === "file" && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => fileRef.current?.click()} className={BTN}><ImagePlus className="w-4 h-4" /> Choisir une image</button>
            <span className="text-xs text-gray-500">ou collez une capture d&apos;écran (⌘V / Ctrl+V) — une pub vue dans la bibliothèque Meta, TikTok, un site…</span>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { try { setDataUri(await fileToDataUri(f)); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } } }} />
          </div>
          {dataUri && <img src={dataUri} alt="" className="max-h-64 rounded-lg border border-gray-800" />}
        </div>
      )}
      {mode === "link" && <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://… (adresse directe de l'image)" className={`${FIELD} w-full`} />}
      {mode === "library" && (
        <div className="space-y-2">
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void search(); }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Marque ou mot-clé (ex. Naturalia, matelas, cours particuliers)" className={`${FIELD} flex-1`} />
            <button type="submit" className={BTN} disabled={searching}>{searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Chercher</button>
          </form>
          {library?.error && <p className="text-xs text-amber-300 whitespace-pre-wrap">{library.error}</p>}
          {library && !library.error && !library.ads.length && <p className="text-xs text-gray-500">Aucune publicité active trouvée pour « {q} » en France.</p>}
          {!!library?.ads.length && (
            <ul className="divide-y divide-gray-800 border border-gray-800 rounded-lg max-h-72 overflow-auto">
              {library.ads.map((ad) => (
                <li key={ad.id} className="p-2.5 flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white">{ad.pageName} <span className="text-[11px] text-gray-500">· {ad.platforms.join(", ")}{ad.startedAt ? ` · depuis le ${new Date(ad.startedAt).toLocaleDateString("fr-FR")}` : ""}{ad.euReach ? ` · ${ad.euReach.toLocaleString("fr-FR")} pers. UE` : ""}</span></div>
                    {ad.titles[0] && <div className="text-xs text-gray-300">{ad.titles[0]}</div>}
                    {ad.bodies[0] && <div className="text-[11px] text-gray-500 line-clamp-2">{ad.bodies[0]}</div>}
                    {ad.snapshotUrl && <a href={ad.snapshotUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-violet-300 hover:text-white">Voir la pub (capture à coller ensuite) →</a>}
                  </div>
                  <button type="button" disabled={busy} onClick={() => void create({ source: "competitor", brand: ad.pageName, title: ad.titles[0], body: ad.bodies[0], sourceRef: `adlib:${ad.id}`, sourceUrl: ad.snapshotUrl ?? undefined })} className={BTN}>Garder</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-gray-400">Nom (facultatif)<input value={name} onChange={(e) => setName(e.target.value)} placeholder="L'IA propose un nom d'après l'accroche" className={FIELD} /></label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">Marque d&apos;origine (concurrent)<input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Ex. Emma, Back Market…" className={FIELD} /></label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">Pour
          <select value={owner} onChange={(e) => setOwner(e.target.value)} className={FIELD}>
            <option value="">Toute l&apos;agence (partagé)</option>
            {clients.map((c) => <option key={c.clientId} value={c.clientId}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">Tags (virgules)<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ugc, promo, avant-après" className={FIELD} /></label>
      </div>
      {error && <p className="text-sm text-rose-300">{error}</p>}
      {mode !== "library" && (
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className={BTN}>Annuler</button>
          <button type="button" onClick={() => void create()} disabled={busy || (mode === "file" ? !dataUri : !imageUrl.trim())} className={BTN_PRIMARY}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} {busy ? "Lecture par l'IA…" : "Garder et lire avec l'IA"}</button>
        </div>
      )}
    </Modal>
  );
}

// ── Copy to the brand ─────────────────────────────────────────────────────

export function CopyDialog({ template, client, clients, engines, quota, brandAssets, onClose, onDone }: { template: Template; client: ClientOption | null; clients: ClientOption[]; engines: Engine[]; quota: QuotaInfo | null; brandAssets: Asset[]; onClose: () => void; onDone: (assets: Asset[], message: string) => void }) {
  const [target, setTarget] = useState(client?.clientId ?? template.clientId ?? "");
  const [instructions, setInstructions] = useState("");
  const [n, setN] = useState(2);
  const refEngines = useMemo(() => engines.filter((e) => e.refs), [engines]);
  const [chosenEngine, setEngine] = useState<string>(refEngines[0]?.id ?? "agnes-image-2.5-flash");
  // The engines arrive after the dialog: fall back to the first one accepting references until a choice is made.
  const engine = refEngines.some((e) => e.id === chosenEngine) ? chosenEngine : refEngines[0]?.id ?? chosenEngine;
  const [ratio, setRatio] = useState("1:1");
  const [textless, setTextless] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [extra, setExtra] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const unit = engines.find((e) => e.id === engine)?.usd ?? 0;
  const over = priceReminder(quota, unit, n)?.over ?? false;
  const myAssets = brandAssets.filter((a) => a.clientId === target);

  async function run() {
    if (!target || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/creas/templates/${template.id}/copy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: target, instructions, n, engine: engine.startsWith("fal-ai/") ? engine : undefined, ratio, textless, assetIds: picked, assets: extra }) });
      const j = (await res.json().catch(() => ({}))) as { assets?: Asset[]; failed?: number; cost?: number; engine?: string; error?: string };
      if (!res.ok || !j.assets) throw new Error(j.error ?? `Erreur ${res.status}`);
      onDone(j.assets, `${j.assets.length} visuel${j.assets.length > 1 ? "s" : ""} généré${j.assets.length > 1 ? "s" : ""}${j.failed ? ` (${j.failed} en échec)` : ""}${j.engine === "agnes" && engine.startsWith("fal-ai/") ? " — moteur Agnes utilisé (la clé fal n'autorise pas encore ce modèle)" : ""}.`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`Copier « ${template.name} » à la marque`} onClose={onClose} wide>
      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <div className="space-y-2">
          {template.image ? <img src={template.image} alt="" className="w-full rounded-lg border border-gray-800" /> : <div className="aspect-square rounded-lg border border-gray-800 bg-gray-900 flex items-center justify-center text-xs text-gray-500">Sans image</div>}
          {template.analysis.brief && <p className="text-[11px] text-gray-400 leading-snug line-clamp-6" title={template.analysis.brief}>{template.analysis.brief}</p>}
        </div>
        <div className="space-y-3">
          <label className="flex flex-col gap-1 text-xs text-gray-400">Client
            <select value={target} onChange={(e) => { setTarget(e.target.value); setPicked([]); }} className={FIELD}>
              <option value="">Choisir…</option>
              {clients.map((c) => <option key={c.clientId} value={c.clientId}>{c.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">Ce que vous voulez (facultatif)
            <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} placeholder="Ex. : mettre en avant le pack découverte, ambiance hiver, garder le badge « -30 % »" className={`${FIELD} resize-y`} />
          </label>
          <div className="space-y-1">
            <div className="text-xs text-gray-400">Éléments de marque (2 max) — logo, produit : gardés tels quels dans l&apos;image</div>
            <div className="flex flex-wrap items-center gap-2">
              {myAssets.map((a) => (
                <button key={a.id} type="button" onClick={() => setPicked((p) => (p.includes(a.id) ? p.filter((x) => x !== a.id) : p.length + extra.length < 2 ? [...p, a.id] : p))} className={`relative rounded-md overflow-hidden border-2 ${picked.includes(a.id) ? "border-violet-500" : "border-transparent"}`} title={a.prompt}>
                  {a.url && <img src={a.url} alt={a.prompt} className="w-14 h-14 object-cover" />}
                </button>
              ))}
              {extra.map((d, i) => <span key={i} className="relative"><img src={d} alt="" className="w-14 h-14 object-cover rounded-md border-2 border-violet-500" /><button type="button" onClick={() => setExtra((l) => l.filter((_, j) => j !== i))} className="absolute -top-1.5 -right-1.5 bg-gray-900 rounded-full text-gray-400 hover:text-white"><X className="w-3 h-3" /></button></span>)}
              <button type="button" onClick={() => fileRef.current?.click()} disabled={picked.length + extra.length >= 2} className={BTN}><ImagePlus className="w-4 h-4" /> Ajouter</button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { try { setExtra((l) => [...l, ""].slice(0, 2)); const d = await fileToDataUri(f); setExtra((l) => l.map((x) => (x === "" ? d : x))); } catch (err) { setExtra((l) => l.filter(Boolean)); setError(err instanceof Error ? err.message : String(err)); } } }} />
              {!myAssets.length && !extra.length && <span className="text-[11px] text-gray-500">Aucun élément de marque enregistré pour ce client (onglet « Éléments de marque »).</span>}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-gray-400">Moteur
              <select value={engine} onChange={(e) => setEngine(e.target.value)} className={`${FIELD} max-w-[260px]`}>
                {refEngines.map((e) => <option key={e.id} value={e.id}>{e.label}{e.usd ? ` · ${e.usd} $` : " · gratuit"}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-400">Format
              <select value={ratio} onChange={(e) => setRatio(e.target.value)} className={FIELD}>
                {[["1:1", "Carré 1:1"], ["3:4", "Portrait 3:4"], ["9:16", "Vertical 9:16"], ["16:9", "Paysage 16:9"], ["4:3", "Paysage 4:3"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-400">Visuels
              <select value={n} onChange={(e) => setN(Number(e.target.value))} className={FIELD}>{[1, 2, 3, 4].map((k) => <option key={k} value={k}>{k}</option>)}</select>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-400 pb-2"><input type="checkbox" checked={textless} onChange={(e) => setTextless(e.target.checked)} /> Sans texte ni logo (posés ensuite)</label>
          </div>
          <PriceLine quota={quota} unitUsd={unit} n={n} />
          {error && <p className="text-sm text-rose-300">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className={BTN}>Annuler</button>
            <button type="button" onClick={() => void run()} disabled={busy || !target || over} className={BTN_PRIMARY}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} {busy ? "Génération… (jusqu'à une minute)" : `Générer ${n} visuel${n > 1 ? "s" : ""}`}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── More like this ────────────────────────────────────────────────────────

export function VariationDialog({ asset, engines, quota, onClose, onDone }: { asset: Asset; engines: Engine[]; quota: QuotaInfo | null; onClose: () => void; onDone: (assets: Asset[], message: string) => void }) {
  const refEngines = useMemo(() => engines.filter((e) => e.refs), [engines]);
  const [engine, setEngine] = useState<string>(refEngines[0]?.id ?? "agnes-image-2.5-flash");
  const [n, setN] = useState(2);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unit = engines.find((e) => e.id === engine)?.usd ?? 0;
  const over = priceReminder(quota, unit, n)?.over ?? false;
  async function run() {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/creas/variations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetId: asset.id, n, instructions, engine: engine.startsWith("fal-ai/") ? engine : undefined }) });
      const j = (await res.json().catch(() => ({}))) as { assets?: Asset[]; failed?: number; error?: string };
      if (!res.ok || !j.assets) throw new Error(j.error ?? `Erreur ${res.status}`);
      onDone(j.assets, `${j.assets.length} variante${j.assets.length > 1 ? "s" : ""} générée${j.assets.length > 1 ? "s" : ""}${j.failed ? ` (${j.failed} en échec)` : ""}.`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="Plus comme ça" onClose={onClose}>
      <div className="flex gap-4">
        {asset.url && <img src={asset.url} alt="" className="w-32 h-32 object-cover rounded-lg border border-gray-800 shrink-0" />}
        <div className="flex-1 space-y-3">
          <label className="flex flex-col gap-1 text-xs text-gray-400">Ce qui change (facultatif)<textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} placeholder="Ex. : autre décor, plus lumineux, produit vu de plus près" className={`${FIELD} resize-y`} /></label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-gray-400">Moteur<select value={engine} onChange={(e) => setEngine(e.target.value)} className={`${FIELD} max-w-[260px]`}>{refEngines.map((e) => <option key={e.id} value={e.id}>{e.label}{e.usd ? ` · ${e.usd} $` : " · gratuit"}</option>)}</select></label>
            <label className="flex flex-col gap-1 text-xs text-gray-400">Variantes<select value={n} onChange={(e) => setN(Number(e.target.value))} className={FIELD}>{[1, 2, 3, 4].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
          </div>
          <PriceLine quota={quota} unitUsd={unit} n={n} />
          {error && <p className="text-sm text-rose-300">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className={BTN}>Annuler</button>
            <button type="button" onClick={() => void run()} disabled={busy || over} className={BTN_PRIMARY}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} {busy ? "Génération…" : `Générer ${n} variante${n > 1 ? "s" : ""}`}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Brand asset upload ────────────────────────────────────────────────────

export function BrandAssetUpload({ clientId, onCreated }: { clientId: string; onCreated: (a: Asset) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError(null);
    try {
      for (const f of Array.from(files).slice(0, 6)) {
        const image = await fileToDataUri(f);
        const res = await fetch("/api/studio/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "asset", image, name: f.name.replace(/\.[a-z0-9]+$/i, ""), clientId }) });
        const j = (await res.json().catch(() => ({}))) as { asset?: Asset; error?: string };
        if (!res.ok || !j.asset) throw new Error(j.error ?? `Erreur ${res.status}`);
        onCreated(j.asset);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex items-center gap-3">
      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className={BTN}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />} Ajouter un logo, un produit…</button>
      <input ref={fileRef} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
      {error && <span className="text-xs text-rose-300">{error}</span>}
    </div>
  );
}
