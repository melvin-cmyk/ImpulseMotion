"use client";

/** Notes tab of the drawer: consultant note + custom tags per ad, stored in AdAnnotation (shared by the whole team). */

import { useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";

interface Ann { note: string; tags: string[]; updatedByName: string; updatedAt: string | null }
const SUGGESTED = ["Gagnante", "À suivre", "À couper", "À itérer", "Nouveau hook", "Test"];

export function AdNotes({ platform, adId }: { platform: string; adId: string }) {
  const [state, setState] = useState<{ key: string; ann: Ann } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const key = `${platform}:${adId}`;
  const ann = state && state.key === key ? state.ann : null;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/ads/annotations?platform=${platform}&adId=${adId}`).then((r) => (r.ok ? r.json() : { note: "", tags: [], updatedByName: "", updatedAt: null })).then((a: Ann) => { if (!cancelled) setState({ key, ann: a }); }).catch(() => { if (!cancelled) setState({ key, ann: { note: "", tags: [], updatedByName: "", updatedAt: null } }); });
    return () => { cancelled = true; };
  }, [platform, adId, key]);

  async function save(next: Partial<Ann>) {
    if (!ann) return;
    setSaving(true);
    const merged = { ...ann, ...next };
    try {
      const r = await fetch("/api/ads/annotations", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform, adId, note: merged.note, tags: merged.tags }) });
      if (r.ok) setState({ key, ann: { ...merged, updatedAt: new Date().toISOString() } });
    } finally { setSaving(false); }
  }

  if (!ann) return <div className="text-xs text-ui-muted flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Chargement…</div>;
  const note = draft ?? ann.note;
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[10px] text-ui-muted mb-1">Tags personnalisés</div>
        <div className="flex flex-wrap gap-1.5 items-center">
          {ann.tags.map((t) => <span key={t} className="inline-flex items-center gap-1 rounded-md bg-ui-accent-soft text-ui-accent-ink px-2 py-0.5 text-[11px]">{t}<button type="button" onClick={() => save({ tags: ann.tags.filter((x) => x !== t) })} className="hover:text-ui-fg"><X className="w-3 h-3" /></button></span>)}
          <form className="inline-flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); const t = tagInput.trim(); if (t && !ann.tags.includes(t)) void save({ tags: [...ann.tags, t] }); setTagInput(""); }}>
            <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="Ajouter…" className="w-24 bg-ui-card border border-ui-line rounded-md px-1.5 py-0.5 text-[11px] text-ui-fg placeholder:text-ui-muted" />
            <button type="submit" className="text-ui-fg2 hover:text-ui-fg"><Plus className="w-3.5 h-3.5" /></button>
          </form>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">{SUGGESTED.filter((s) => !ann.tags.includes(s)).map((s) => <button key={s} type="button" onClick={() => save({ tags: [...ann.tags, s] })} className="rounded-md border border-ui-line px-1.5 py-0.5 text-[10px] text-ui-muted hover:text-ui-fg hover:border-ui-line-strong">+ {s}</button>)}</div>
      </div>
      <div>
        <div className="text-[10px] text-ui-muted mb-1">Note de l&apos;équipe</div>
        <textarea value={note} onChange={(e) => setDraft(e.target.value)} rows={6} placeholder="Ce qu'on a appris de cette créa, ce qu'on veut tester ensuite…" className="w-full bg-ui-card border border-ui-line rounded-lg px-3 py-2 text-xs text-ui-fg placeholder:text-ui-muted focus:outline-none focus:border-ui-accent" />
        <div className="flex items-center justify-between mt-1">
          <span className="text-[10px] text-ui-muted">{ann.updatedAt ? `Modifié ${new Date(ann.updatedAt).toLocaleString("fr-FR")}${ann.updatedByName ? ` par ${ann.updatedByName}` : ""}` : "Aucune note"}</span>
          {draft !== null && draft !== ann.note && <button type="button" disabled={saving} onClick={async () => { await save({ note: draft }); setDraft(null); }} className="rounded-md bg-ui-accent hover:brightness-110 px-2.5 py-1 text-[11px] text-ui-on-accent disabled:opacity-50">{saving ? "Enregistrement…" : "Enregistrer la note"}</button>}
        </div>
      </div>
    </div>
  );
}
