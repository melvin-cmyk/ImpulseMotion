"use client";

/**
 * Glossaire (Motion's Glossary): the AI tag categories of the client's
 * creatives with their values — creatives, spend over the report's period —
 * and the team's corrections (rename / merge, remove, open the creatives).
 * Plus TagEditor, used in a creative's sheet to fix one creative's tags.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Eye, Loader2, Pencil, Trash2, X } from "lucide-react";
import type { AdsQuery } from "@/lib/ads-warehouse/query";
import type { GlossaryCategory } from "@/lib/ads-warehouse/glossary";
import { GLOSSARY_HELP, GLOSSARY_LABELS, GLOSSARY_REQUIRED, type GlossaryKey } from "@/lib/ads-warehouse/glossary-labels";

async function call<T>(query: AdsQuery, body: Record<string, unknown>): Promise<T> {
  const r = await fetch("/api/ads/glossary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...query, ...body }) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`);
  return j;
}

const money = (v: number, currency: string | null) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: currency || "EUR", maximumFractionDigits: 0 }).format(v);

export function GlossaryPanel({ query, currency, onOpenValue }: { query: AdsQuery; currency: string | null; onOpenValue: (key: GlossaryKey, value: string) => void }) {
  const [cats, setCats] = useState<GlossaryCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qKey = JSON.stringify([query.platforms, query.accountIds, query.range]);
  const load = useCallback(async () => {
    try { setCats((await call<{ categories: GlossaryCategory[] }>(query, { action: "list" })).categories); setError(null); } catch (e) { setError(e instanceof Error ? e.message : "Erreur"); }
  }, [qKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  async function rename(key: GlossaryKey, from: string, to: string) {
    const cat = cats?.find((c) => c.key === key);
    const target = cat?.values.find((v) => v.value.toLowerCase() === to.toLowerCase() && v.value.toLowerCase() !== from.toLowerCase());
    if (target && !confirm(`« ${to} » existe déjà : fusionner « ${from} » dedans ?`)) return;
    try { await call(query, { action: "rename", key, from, to }); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Erreur"); }
  }
  async function remove(key: GlossaryKey, value: string) {
    if (!confirm(`Retirer « ${value} » de toutes les créas du client ?`)) return;
    try { await call(query, { action: "remove", key, value }); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Erreur"); }
  }

  if (!cats) return <div className="py-16 flex items-center justify-center gap-2 text-sm text-gray-400">{error ? <span className="text-red-300">{error}</span> : <><Loader2 className="w-4 h-4 animate-spin" /> Lecture des tags…</>}</div>;
  const untagged = cats.every((c) => !c.values.length);
  return (
    <div className="px-6 pb-10">
      {error && <div className="mb-3 text-xs text-red-300">{error}</div>}
      <p className="mb-4 text-xs text-gray-500">Dépense sur la période du rapport ({query.range.since} → {query.range.until}). Renommer vers une valeur existante fusionne les deux. Les corrections de l&apos;équipe ne sont jamais écrasées par la synchro ni par l&apos;IA.</p>
      {untagged ? <div className="py-16 text-center text-sm text-gray-400">Aucune créa taguée pour ce client : le tagging IA passe chaque nuit sur les créas qui dépensent.</div> : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {cats.filter((c) => c.values.length).map((c) => <CategoryCard key={c.key} cat={c} currency={currency} onRename={(f, t) => void rename(c.key, f, t)} onRemove={(v) => void remove(c.key, v)} onOpen={(v) => onOpenValue(c.key, v)} />)}
        </div>
      )}
    </div>
  );
}

function CategoryCard({ cat, currency, onRename, onRemove, onOpen }: { cat: GlossaryCategory; currency: string | null; onRename: (from: string, to: string) => void; onRemove: (v: string) => void; onOpen: (v: string) => void }) {
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const max = Math.max(1, ...cat.values.map((v) => v.spend));
  const shown = all ? cat.values : cat.values.slice(0, 8);
  const removable = !GLOSSARY_REQUIRED.includes(cat.key);
  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-semibold text-white">{GLOSSARY_LABELS[cat.key]}</div>
        <div className="text-[11px] text-gray-500">{cat.values.length} valeur{cat.values.length > 1 ? "s" : ""}</div>
      </div>
      <div className="text-xs text-gray-500 mb-3">{GLOSSARY_HELP[cat.key]}</div>
      <div className="space-y-0.5">
        {shown.map((v) => (
          <div key={v.value} className="group relative flex items-center gap-2 h-8 rounded-lg px-2 hover:bg-gray-800/60">
            <div className="absolute inset-y-1 left-0 rounded-md bg-violet-500/10" style={{ width: `${Math.max(2, (v.spend / max) * 100)}%` }} />
            {editing === v.value ? (
              <form className="relative flex-1 flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); const t = draft.trim(); if (t && t !== v.value) onRename(v.value, t); setEditing(null); }}>
                <input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus className="flex-1 h-7 rounded-md border border-gray-700 bg-gray-950 px-2 text-sm text-white" />
                <button type="submit" className="p-1 text-emerald-300"><Check className="w-3.5 h-3.5" /></button>
                <button type="button" onClick={() => setEditing(null)} className="p-1 text-gray-500"><X className="w-3.5 h-3.5" /></button>
              </form>
            ) : (
              <>
                <span className="relative flex-1 min-w-0 truncate text-sm text-gray-100" title={v.value}>{v.value}</span>
                <span className="relative text-xs text-gray-400 tabular-nums w-16 text-right">{v.creatives} créa{v.creatives > 1 ? "s" : ""}</span>
                <span className="relative text-xs text-gray-300 tabular-nums w-20 text-right">{money(v.spend, currency)}</span>
                <span className="relative hidden group-hover:flex items-center gap-0.5 text-gray-500">
                  <button type="button" title="Voir les créas" onClick={() => onOpen(v.value)} className="p-1 hover:text-white"><Eye className="w-3.5 h-3.5" /></button>
                  <button type="button" title="Renommer ou fusionner" onClick={() => { setEditing(v.value); setDraft(v.value); }} className="p-1 hover:text-white"><Pencil className="w-3.5 h-3.5" /></button>
                  {removable && <button type="button" title="Retirer de toutes les créas" onClick={() => onRemove(v.value)} className="p-1 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>}
                </span>
              </>
            )}
          </div>
        ))}
      </div>
      {cat.values.length > 8 && <button type="button" onClick={() => setAll((x) => !x)} className="mt-2 text-xs text-gray-400 hover:text-white">{all ? "Réduire" : `Voir les ${cat.values.length} valeurs`}</button>}
    </div>
  );
}

/** Editing the tags of one creative (all its ads), from its sheet. Values are suggested from the client's glossary. */
export function TagEditor({ query, adIds, keys, tags, onSaved, onClose }: { query: AdsQuery; adIds: string[]; keys: GlossaryKey[]; tags: Record<string, string>; onSaved: (key: GlossaryKey, value: string | null) => void; onClose: () => void }) {
  const [cats, setCats] = useState<GlossaryCategory[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(keys.map((k) => [k, tags[k] ?? ""])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void call<{ categories: GlossaryCategory[] }>(query, { action: "list" }).then((j) => setCats(j.categories)).catch(() => setCats([])); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setBusy(true); setError(null);
    try {
      for (const k of keys) {
        const next = draft[k].trim();
        if (next === (tags[k] ?? "")) continue;
        if (!next && GLOSSARY_REQUIRED.includes(k)) throw new Error("« Type d'asset » est obligatoire.");
        await call(query, { action: "set", key: k, adIds, value: next || null });
        onSaved(k, next || null);
      }
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Erreur"); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-2">
      {keys.map((k) => (
        <label key={k} className="flex items-center gap-3 text-xs">
          <span className="w-32 shrink-0 text-gray-500">{GLOSSARY_LABELS[k]}</span>
          <input list={`gl-${k}`} value={draft[k]} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} placeholder="—" className="flex-1 h-7 rounded-md border border-gray-800 bg-gray-900 px-2 text-xs text-white placeholder:text-gray-600" />
          <datalist id={`gl-${k}`}>{cats?.find((c) => c.key === k)?.values.map((v) => <option key={v.value} value={v.value} />)}</datalist>
        </label>
      ))}
      {error && <div className="text-xs text-red-300">{error}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} className="h-7 px-2.5 rounded-md border border-gray-700 text-xs text-gray-300">Annuler</button>
        <button type="button" onClick={() => void save()} disabled={busy} className="h-7 px-2.5 inline-flex items-center gap-1 rounded-md bg-white text-xs font-medium text-gray-900 disabled:opacity-50">{busy && <Loader2 className="w-3 h-3 animate-spin" />}Enregistrer ({adIds.length} annonce{adIds.length > 1 ? "s" : ""})</button>
      </div>
      <p className="text-[11px] text-gray-600">Plusieurs valeurs : sépare-les par « | ».</p>
    </div>
  );
}
