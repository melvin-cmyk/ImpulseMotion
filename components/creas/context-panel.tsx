"use client";

/**
 * The client's statics context document, in the fabrique's first step: what
 * the copywriter-AI will read (HQ brief and files, warehouse winners and
 * untried angles, comments when open, past feedback), with its sources.
 * The consultant can read it, refresh it from the sources, edit it and save
 * it — and, ticked, mirror it in HQ: the box says beforehand what will be
 * written where (house rule for every HQ write).
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { CONTEXT_SOURCE_LABEL, type FactoryContextView } from "@/lib/creas/model";
import { BTN, BTN_PRIMARY, FIELD, when, type ClientOption } from "./shared";

export function ContextPanel({ client }: { client: ClientOption }) {
  const [ctx, setCtx] = useState<FactoryContextView | null>(null);
  const [busy, setBusy] = useState<"load" | "fresh" | "save" | null>("load");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [mirror, setMirror] = useState(true);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async (fresh: boolean) => {
    setBusy(fresh ? "fresh" : "load"); setStatus(null);
    try {
      const res = await fetch(`/api/creas/context?client=${encodeURIComponent(client.clientId)}${fresh ? "&fresh=1" : ""}`, { cache: "no-store" });
      const j = (await res.json().catch(() => ({}))) as { context?: FactoryContextView; error?: string };
      if (!res.ok || !j.context) throw new Error(j.error ?? `Erreur ${res.status}`);
      setCtx(j.context); setDraft(null);
    } catch (e) { setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  }, [client.clientId]);
  // Loaded once the panel is on screen (queued: no synchronous state change inside the effect).
  useEffect(() => { queueMicrotask(() => void load(false)); }, [load]);

  async function save() {
    if (!ctx) return;
    setBusy("save"); setStatus(null);
    try {
      const res = await fetch("/api/creas/context", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: client.clientId, md: draft ?? ctx.md, sources: ctx.sources, mirror: mirror && !!ctx.hqTarget }) });
      const j = (await res.json().catch(() => ({}))) as { context?: FactoryContextView; hq?: { ok: boolean; written?: string; error?: string } | null; error?: string };
      if (!res.ok || !j.context) throw new Error(j.error ?? `Erreur ${res.status}`);
      setCtx(j.context); setDraft(null);
      setStatus(j.hq ? (j.hq.ok ? { ok: true, text: `Enregistré, et écrit dans HQ : ${j.hq.written}` } : { ok: false, text: `Enregistré dans ImpulseMotion, PAS dans HQ : ${j.hq.error}` }) : { ok: true, text: "Enregistré dans ImpulseMotion (HQ non modifié)." });
    } catch (e) { setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3 space-y-2 text-xs" data-factory-context>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-200">Contexte client lu par l&apos;IA</span>
        {busy === "load" || busy === "fresh" ? <span className="text-gray-500 inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> {busy === "fresh" ? "Relecture des sources (HQ, entrepôt)… jusqu'à 45 s" : "Chargement…"}</span>
          : ctx && <span className="text-gray-500">{ctx.stored ? `version enregistrée${ctx.updatedAt ? ` le ${when(ctx.updatedAt)}` : ""}` : "assemblé à l'instant, pas encore enregistré"}</span>}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={() => setOpen((v) => !v)} className="text-gray-400 hover:text-white" disabled={!ctx}>{open ? "Masquer" : "Voir / modifier"}</button>
          <button type="button" onClick={() => void load(true)} className="text-gray-400 hover:text-white inline-flex items-center gap-1" disabled={!!busy} title="Relire HQ, l'entrepôt et les retours"><RefreshCw className="w-3 h-3" /> Relire les sources</button>
        </div>
      </div>
      {ctx && (
        <ul className="flex flex-wrap gap-1.5" data-factory-context-sources>
          {ctx.sources.length === 0 && <li className="text-amber-300">Aucune source : ni brief HQ, ni entrepôt. Les copys resteront génériques.</li>}
          {ctx.sources.map((s, i) => <li key={`${s.kind}-${i}`} title={s.ref} className={`px-2 py-0.5 rounded-full border ${s.note ? "border-amber-500/40 text-amber-200" : "border-gray-700 text-gray-300"}`}>{CONTEXT_SOURCE_LABEL[s.kind] ?? s.kind}{s.note ? ` (${s.note})` : ""} · {s.chars.toLocaleString("fr-FR")} car.</li>)}
        </ul>
      )}
      {ctx?.warnings.map((w) => <p key={w} className="text-amber-300">{w}</p>)}
      {open && ctx && (
        <div className="space-y-2">
          <textarea value={draft ?? ctx.md} onChange={(e) => setDraft(e.target.value)} rows={14} className={`${FIELD} w-full font-mono text-[11px] resize-y`} data-factory-context-md />
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-2.5 space-y-1 text-[11px] text-sky-100" data-factory-context-hq>
            <p className="font-medium">Ce qui se passe à l&apos;enregistrement</p>
            <ol className="list-decimal list-inside space-y-0.5 text-sky-100/80">
              <li>Le document est gardé dans ImpulseMotion : toutes les prochaines fabriques de {client.name} le liront.</li>
              {ctx.hqTarget
                ? <li><label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} /> Écrire aussi une copie dans HQ :</label> <code className="text-sky-200">{ctx.hqTarget}</code> (statut « brouillon », signé de votre nom ; refusé si le fichier a changé dans HQ entre-temps).</li>
                : <li>Ce client n&apos;a pas de dossier HQ rattaché : rien n&apos;est écrit dans HQ.</li>}
            </ol>
            {ctx.hqPath && <p className="text-sky-100/70">Dernière copie HQ : {ctx.hqPath}</p>}
          </div>
          <div className="flex justify-end gap-2">
            {draft !== null && <button type="button" onClick={() => setDraft(null)} className={BTN}>Annuler mes modifications</button>}
            <button type="button" onClick={() => void save()} disabled={!!busy} className={BTN_PRIMARY} data-factory-context-save>{busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Enregistrer{mirror && ctx.hqTarget ? " (+ HQ)" : ""}</button>
          </div>
        </div>
      )}
      {status && <p className={status.ok ? "text-emerald-300" : "text-rose-300"} data-factory-context-status>{status.text}</p>}
    </div>
  );
}
