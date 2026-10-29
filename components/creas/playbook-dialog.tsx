"use client";

/**
 * « Étudier une marque » (Créas › Templates & concurrents): the brand's ads
 * in the Meta Ad Library, each read by the AI, grouped into recurring
 * formats (lib/creas/playbook.ts). The consultant ticks the ads to keep →
 * templates of the client tagged « playbook:<marque> » and their format.
 */

import { useMemo, useState } from "react";
import { BookOpen, Check, Loader2, RefreshCw } from "lucide-react";
import { Modal } from "./dialogs";
import { BTN, BTN_PRIMARY, FIELD, type ClientOption } from "./shared";
import type { Playbook } from "@/lib/creas/playbook-doc";

const proxied = (url: string) => `/api/media/proxy-image?url=${encodeURIComponent(url)}`;

export function PlaybookDialog({ client, onClose, onKept }: { client: ClientOption | null; onClose: () => void; onKept: (count: number) => void }) {
  const [brand, setBrand] = useState("");
  const [country, setCountry] = useState("FR");
  const [limit, setLimit] = useState(18);
  const [busy, setBusy] = useState<"study" | "keep" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [format, setFormat] = useState<string | null>(null);
  const [showDoc, setShowDoc] = useState(false);

  async function study(fresh = false) {
    if (brand.trim().length < 2 || busy) return;
    setBusy("study"); setError(null); setPicked([]); setFormat(null);
    try {
      const res = await fetch("/api/creas/playbook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brand: brand.trim(), country, limit, fresh }) });
      const j = (await res.json().catch(() => ({}))) as { playbook?: Playbook; error?: string };
      if (!res.ok || !j.playbook) throw new Error(j.error ?? `Erreur ${res.status}`);
      setPlaybook(j.playbook);
      // The polyvalent formats are pre-ticked: one ad of each (the first one shown).
      const poly = j.playbook.formats.filter((f) => f.verdict === "polyvalent");
      setPicked(poly.map((f) => f.libraryIds[0]).filter(Boolean).slice(0, 6));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function keep() {
    if (!playbook || !picked.length || busy) return;
    setBusy("keep"); setError(null);
    try {
      const res = await fetch("/api/creas/playbook/keep", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brand: playbook.brand, country: playbook.country, libraryIds: picked, ...(client ? { clientId: client.clientId } : {}) }) });
      const j = (await res.json().catch(() => ({}))) as { kept?: Array<{ id: string }>; failed?: Array<{ libraryId: string; error: string }>; error?: string };
      if (!res.ok || !j.kept) throw new Error(j.error ?? `Erreur ${res.status}`);
      if (j.failed?.length) setError(`${j.failed.length} non gardée${j.failed.length > 1 ? "s" : ""} : ${j.failed[0].error}`);
      onKept(j.kept.length);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const shown = useMemo(() => (playbook ? playbook.candidates.filter((c) => !format || c.format === format) : []), [playbook, format]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < 12 ? [...p, id] : p));

  return (
    <Modal title="Étudier une marque (bibliothèque Meta)" onClose={onClose} wide>
      <div className="space-y-3" data-playbook>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void study(); }}>
          <label className="flex flex-col gap-1 text-xs text-gray-400 flex-1 min-w-[12rem]">Marque
            <input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Ex. : Acadomia, Huel, La Fourche" className={FIELD} data-playbook-brand />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">Pays
            <input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))} className={`${FIELD} w-16`} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">Pubs lues
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className={FIELD}>{[12, 18, 24, 30].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </label>
          <button type="submit" className={BTN_PRIMARY} disabled={!!busy || brand.trim().length < 2} data-playbook-study>{busy === "study" ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookOpen className="w-4 h-4" />} {busy === "study" ? "Lecture des pubs… (1 à 2 min)" : "Étudier"}</button>
        </form>
        <p className="text-[11px] text-gray-500">Les pubs de la marque (actives, puis passées en complément) sont cherchées dans la bibliothèque Meta, puis chaque pub avec image est lue par l&apos;IA (environ 0,02 $ la pub). L&apos;étude est gardée 7 jours.</p>
        {error && <p className="text-sm text-rose-300 whitespace-pre-wrap">{error}</p>}
        {playbook && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-gray-300">{playbook.analysed} pubs lues sur {playbook.total} · {new Date(playbook.at).toLocaleDateString("fr-FR")}</span>
              <button type="button" onClick={() => void study(true)} className="text-gray-400 hover:text-white inline-flex items-center gap-1" disabled={!!busy}><RefreshCw className="w-3 h-3" /> Refaire</button>
              <button type="button" onClick={() => setShowDoc((v) => !v)} className="text-gray-400 hover:text-white">{showDoc ? "Masquer" : "Voir"} le playbook</button>
            </div>
            {showDoc && <pre className="text-[11px] text-gray-300 whitespace-pre-wrap bg-gray-900 border border-gray-800 rounded-lg p-3 max-h-60 overflow-auto">{playbook.md}</pre>}
            <div className="flex flex-wrap gap-1.5" data-playbook-formats>
              <button type="button" onClick={() => setFormat(null)} className={`px-2 py-1 rounded-full border text-[11px] ${!format ? "border-violet-500 text-white" : "border-gray-800 text-gray-400"}`}>Tous ({playbook.candidates.length})</button>
              {playbook.formats.map((f) => (
                <button key={f.label} type="button" onClick={() => setFormat(f.label)} title={f.structure} className={`px-2 py-1 rounded-full border text-[11px] ${format === f.label ? "border-violet-500 text-white" : "border-gray-800 text-gray-300"}`}>
                  {f.label} · {f.count} ({f.share} %){f.verdict === "polyvalent" ? " · polyvalent" : ""}
                </button>
              ))}
            </div>
            <ul className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 max-h-[50vh] overflow-auto">
              {shown.map((c) => { const on = picked.includes(c.libraryId); const n = playbook.candidates.indexOf(c) + 1; return (
                <li key={c.libraryId}>
                  <button type="button" onClick={() => toggle(c.libraryId)} aria-pressed={on} data-playbook-ad={c.libraryId} className={`relative w-full text-left rounded-lg overflow-hidden border-2 ${on ? "border-violet-500" : "border-gray-800 hover:border-gray-600"}`}>
                    <div className="aspect-[4/5] bg-gray-900">{c.image && <img src={proxied(c.image)} alt="" className="w-full h-full object-cover" loading="lazy" />}</div>
                    <span className={`absolute top-1.5 left-1.5 w-5 h-5 rounded-md inline-flex items-center justify-center text-[10px] ${on ? "bg-violet-600 text-white" : "bg-black/60 text-gray-200"}`}>{on ? <Check className="w-3.5 h-3.5" /> : n}</span>
                    <div className="p-1.5 space-y-0.5 text-[10px]">
                      <p className="text-gray-200">{c.format}{c.video ? " · vidéo" : ""}</p>
                      {c.analysis.hook && <p className="text-gray-400 line-clamp-2">{c.analysis.hook}</p>}
                    </div>
                  </button>
                </li>
              ); })}
            </ul>
            <div className="flex items-center justify-end gap-2">
              <span className="text-xs text-gray-500 mr-auto">{picked.length} cochée{picked.length > 1 ? "s" : ""} (12 max) · gardées comme templates {client ? `de ${client.name}` : "de l'agence"}, avec le tag « playbook:{playbook.brand.toLowerCase()} » et leur format</span>
              <button type="button" onClick={onClose} className={BTN}>Fermer</button>
              <button type="button" onClick={() => void keep()} disabled={!picked.length || !!busy} className={BTN_PRIMARY} data-playbook-keep>{busy === "keep" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Garder {picked.length || ""} comme templates</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
