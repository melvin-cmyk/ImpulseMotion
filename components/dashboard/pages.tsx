"use client";

/**
 * Dashboard pages (tabs): the tab strip everyone sees, plus the staff-only
 * controls in edit mode — add a page (empty, or composed by the AI from a
 * one-line brief), rename or delete the active one.
 */

import { useState } from "react";
import { Loader2, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { DEFAULT_PAGE_ID, DEFAULT_PAGE_NAME, type DashboardPageInfo } from "@/lib/dashboard-types";

export const FIRST_PAGE_LABEL = DEFAULT_PAGE_NAME;

export function PageTabs({
  pages, activePageId, editing, onSelect, onAdd, onRename, onDelete,
}: {
  pages: DashboardPageInfo[];
  activePageId: string | null;
  editing: boolean;
  onSelect: (pageId: string) => void;
  onAdd: () => void;
  onRename: (page: DashboardPageInfo) => void;
  onDelete: (page: DashboardPageInfo) => void;
}) {
  if (pages.length === 0 && !editing) return null;
  const active = pages.find((p) => p.id === activePageId) ?? pages[0] ?? null;
  return (
    <div className="flex items-center gap-1 flex-wrap border-b border-gray-800 pb-1">
      {pages.length === 0 && (
        <span className="px-3 py-1.5 text-xs font-semibold text-white border-b-2 border-violet-500">{FIRST_PAGE_LABEL}</span>
      )}
      {pages.map((p) => {
        const isActive = active?.id === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            className={`px-3 py-1.5 text-xs font-semibold border-b-2 transition-colors ${
              isActive ? "text-white border-violet-500" : "text-gray-400 border-transparent hover:text-white"
            }`}
            title={p.intent ?? undefined}
          >
            {p.name}
          </button>
        );
      })}
      {editing && (
        <div className="flex items-center gap-1 ml-1">
          {active && active.id !== DEFAULT_PAGE_ID && (
            <>
              <button type="button" onClick={() => onRename(active)} className="p-1.5 rounded-md text-gray-500 hover:text-white hover:bg-gray-800" title="Renommer la page">
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button type="button" onClick={() => onDelete(active)} className="p-1.5 rounded-md text-gray-500 hover:text-red-300 hover:bg-gray-800" title="Supprimer la page (ses widgets reviennent sur la première page)">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200"
          >
            <Plus className="w-3.5 h-3.5" /> Page
          </button>
        </div>
      )}
    </div>
  );
}

/** Create a page: empty, or composed by the AI from the brief. */
export function PageForm({ dashboardId, onDone, onCancel }: { dashboardId: string; onDone: (pageId: string, note?: string | null) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [useAi, setUseAi] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (useAi && brief.trim().length < 8) { setError("Décrivez la page en une phrase au moins."); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(useAi ? { ai: true, brief: brief.trim(), name: name.trim() || undefined } : { name: name.trim() || "Nouvelle page", intent: brief.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);
      onDone(body.page.id, body.note ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  const inputCls = "w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500";
  return (
    <form onSubmit={submit} className="rounded-2xl border border-gray-800 bg-gray-900/60 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2"><Sparkles className="w-4 h-4 text-violet-400" /> Nouvelle page</h3>
        <label className="text-xs text-gray-400 inline-flex items-center gap-2">
          <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} className="accent-violet-500" />
          Composer avec l&apos;IA
        </label>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="block">
          <span className="block text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-1">Nom {useAi && <span className="normal-case tracking-normal font-normal text-gray-600">(optionnel, l&apos;IA en propose un)</span>}</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} placeholder="Ex. : Google Ads" className={inputCls} disabled={busy} />
        </label>
        <label className="block md:col-span-2">
          <span className="block text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-1">{useAi ? "Ce que vous voulez voir sur cette page" : "Description (optionnel)"}</span>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value.slice(0, 1500))}
            rows={2}
            placeholder="Ex. : uniquement Google Ads — coût, conversions et CPA du mois, courbe quotidienne des conversions, tableau des campagnes, mots-clés et termes de recherche"
            className={`${inputCls} resize-y`}
            disabled={busy}
          />
        </label>
      </div>
      {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-900/40 rounded-lg px-3 py-2">{error}</div>}
      <div className="flex items-center gap-2 justify-end">
        <button type="button" onClick={onCancel} disabled={busy} className="px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white">Annuler</button>
        <button type="submit" disabled={busy} className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white">
          {busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {useAi ? "L'IA compose la page…" : "Création…"}</> : useAi ? "Composer la page" : "Créer la page"}
        </button>
      </div>
    </form>
  );
}
