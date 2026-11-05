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
  pages, activePageId, editing, onSelect, onAdd, onRename, onDelete, extraTabs = [],
}: {
  pages: DashboardPageInfo[];
  activePageId: string | null;
  editing: boolean;
  onSelect: (pageId: string) => void;
  onAdd: () => void;
  onRename: (page: DashboardPageInfo) => void;
  onDelete: (page: DashboardPageInfo) => void;
  /** Tabs that are not pages of widgets (staff « Historique & impact »); one active hides the page highlight. */
  extraTabs?: Array<{ id: string; label: string; active: boolean; onSelect: () => void }>;
}) {
  if (pages.length === 0 && !editing && extraTabs.length === 0) return null;
  const extraActive = extraTabs.some((t) => t.active);
  const active = extraActive ? null : pages.find((p) => p.id === activePageId) ?? pages[0] ?? null;
  return (
    <div className="flex items-center gap-1 flex-wrap border-b border-ui-line pb-1">
      {pages.length === 0 && (
        extraActive
          ? <button type="button" onClick={() => onSelect(DEFAULT_PAGE_ID)} className="px-3 py-1.5 text-xs font-medium text-ui-fg2 border-b-2 border-transparent hover:text-ui-fg">{FIRST_PAGE_LABEL}</button>
          : <span className="px-3 py-1.5 text-xs font-medium text-ui-fg border-b-2 border-ui-accent">{FIRST_PAGE_LABEL}</span>
      )}
      {pages.map((p) => {
        const isActive = active?.id === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              isActive ? "text-ui-fg border-ui-accent" : "text-ui-fg2 border-transparent hover:text-ui-fg"
            }`}
            title={p.intent ?? undefined}
          >
            {p.name}
          </button>
        );
      })}
      {extraTabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={t.onSelect}
          className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${t.active ? "text-ui-fg border-ui-accent" : "text-ui-fg2 border-transparent hover:text-ui-fg"}`}
        >
          {t.label}
        </button>
      ))}
      {editing && !extraActive && (
        <div className="flex items-center gap-1 ml-1">
          {active && active.id !== DEFAULT_PAGE_ID && (
            <>
              <button type="button" onClick={() => onRename(active)} className="p-1.5 rounded-md text-ui-muted hover:text-ui-fg hover:bg-ui-raised" title="Renommer la page">
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button type="button" onClick={() => onDelete(active)} className="p-1.5 rounded-md text-ui-muted hover:text-ui-neg hover:bg-ui-raised" title="Supprimer la page (ses widgets reviennent sur la première page)">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-ui-raised hover:bg-ui-line-strong text-ui-fg"
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

  const inputCls = "w-full bg-ui-bg border border-ui-line rounded-lg px-3 py-2 text-sm text-ui-fg focus:outline-none focus:border-ui-accent";
  return (
    <form onSubmit={submit} className="rounded-xl border border-ui-line bg-ui-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-ui-fg flex items-center gap-2"><Sparkles className="w-4 h-4 text-ui-accent-ink" /> Nouvelle page</h3>
        <label className="text-xs text-ui-fg2 inline-flex items-center gap-2">
          <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} className="accent-ui-accent" />
          Composer avec l&apos;IA
        </label>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="block">
          <span className="block text-[11px] text-ui-muted font-medium mb-1">Nom {useAi && <span className="normal-case tracking-normal font-normal text-ui-muted">(optionnel, l&apos;IA en propose un)</span>}</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} placeholder="Ex. : Google Ads" className={inputCls} disabled={busy} />
        </label>
        <label className="block md:col-span-2">
          <span className="block text-[11px] text-ui-muted font-medium mb-1">{useAi ? "Ce que vous voulez voir sur cette page" : "Description (optionnel)"}</span>
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
      {error && <div className="text-xs text-ui-neg bg-red-500/10 border border-red-900/40 rounded-lg px-3 py-2">{error}</div>}
      <div className="flex items-center gap-2 justify-end">
        <button type="button" onClick={onCancel} disabled={busy} className="px-3 py-1.5 rounded-lg text-xs text-ui-fg2 hover:text-ui-fg">Annuler</button>
        <button type="submit" disabled={busy} className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-medium bg-ui-accent hover:brightness-110 disabled:opacity-50 text-ui-on-accent">
          {busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {useAi ? "L'IA compose la page…" : "Création…"}</> : useAi ? "Composer la page" : "Créer la page"}
        </button>
      </div>
    </form>
  );
}
