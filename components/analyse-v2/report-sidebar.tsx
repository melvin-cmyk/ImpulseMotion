"use client";

/**
 * Left column of Analyse Ads v2 — Motion's "Reports" folder: the built-in
 * report templates (same for every client) and the reports the consultants
 * saved for THIS client account. Selecting one applies its configuration.
 */

import { useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { VIEW_TEMPLATES, type ViewConfig } from "@/lib/ads-warehouse/views";

export interface SavedView { id: string; accountKey: string | null; name: string; emoji: string; config: ViewConfig; createdByName: string; updatedAt: string }

interface Props {
  accountKey: string | null;
  saved: SavedView[];
  loading: boolean;
  activeId: string | null;
  dirty: boolean;
  onPick: (id: string, config: ViewConfig) => void;
  onSave: (name: string, emoji: string) => Promise<void>;
  onUpdate: (id: string) => Promise<void>;
  onRename: (id: string, name: string, emoji: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const EMOJIS = ["🏆", "🟢", "🚀", "🪝", "👆", "🖋️", "📊", "🛬", "📽️", "📸", "📅", "🥱", "💬", "🎯", "🧪", "⭐"];

export function ReportSidebar({ accountKey, saved, loading, activeId, dirty, onPick, onSave, onUpdate, onRename, onDelete }: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🏆");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const item = (id: string, em: string, label: string, config: ViewConfig, custom?: SavedView) => (
    <div key={id} className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm cursor-pointer ${activeId === id ? "bg-violet-600/15 text-white" : "text-gray-300 hover:bg-gray-800/60"}`} onClick={() => onPick(id, config)}>
      <span className="w-5 text-center shrink-0">{em}</span>
      {editing === id && custom ? (
        <form className="flex items-center gap-1 flex-1" onClick={(e) => e.stopPropagation()} onSubmit={async (e) => { e.preventDefault(); setBusy(true); await onRename(id, name, emoji); setBusy(false); setEditing(null); }}>
          <select value={emoji} onChange={(e) => setEmoji(e.target.value)} className="bg-gray-900 border border-gray-800 rounded px-1 text-sm">{EMOJIS.map((x) => <option key={x}>{x}</option>)}</select>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="flex-1 min-w-0 bg-gray-900 border border-gray-800 rounded px-1.5 py-0.5 text-xs text-white" />
          <button type="submit" className="text-xs text-violet-300">OK</button>
        </form>
      ) : (
        <>
          <span className="truncate flex-1" title={label}>{label}</span>
          {custom && (
            <span className="hidden group-hover:flex items-center gap-1">
              {activeId === id && dirty && <button type="button" title="Enregistrer les modifications dans ce rapport" onClick={async (e) => { e.stopPropagation(); setBusy(true); await onUpdate(id); setBusy(false); }} className="text-[10px] text-violet-300 hover:text-white">maj</button>}
              <button type="button" title="Renommer" onClick={(e) => { e.stopPropagation(); setEditing(id); setName(custom.name); setEmoji(custom.emoji); }} className="text-gray-500 hover:text-white"><Pencil className="w-3 h-3" /></button>
              <button type="button" title="Supprimer" onClick={async (e) => { e.stopPropagation(); if (confirm(`Supprimer le rapport « ${custom.name} » ?`)) { setBusy(true); await onDelete(id); setBusy(false); } }} className="text-gray-500 hover:text-red-400"><Trash2 className="w-3 h-3" /></button>
            </span>
          )}
        </>
      )}
    </div>
  );

  return (
    <aside className="w-60 shrink-0 border-r border-gray-800 bg-gray-950/60 p-3 space-y-4 overflow-y-auto">
      <div>
        <div className="flex items-center justify-between px-2 mb-1">
          <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Rapports du client</span>
          {accountKey && <button type="button" onClick={() => { setCreating((v) => !v); setName(""); setEmoji("🏆"); }} title="Enregistrer la vue actuelle comme rapport" className="text-gray-400 hover:text-white"><Plus className="w-3.5 h-3.5" /></button>}
        </div>
        {creating && (
          <form className="px-2 pb-2 flex items-center gap-1" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; setBusy(true); await onSave(name.trim(), emoji); setBusy(false); setCreating(false); }}>
            <select value={emoji} onChange={(e) => setEmoji(e.target.value)} className="bg-gray-900 border border-gray-800 rounded px-1 text-sm">{EMOJIS.map((x) => <option key={x}>{x}</option>)}</select>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du rapport" autoFocus className="flex-1 min-w-0 bg-gray-900 border border-gray-800 rounded px-1.5 py-1 text-xs text-white placeholder:text-gray-600" />
            <button type="submit" disabled={busy} className="rounded bg-violet-600 px-2 py-1 text-[11px] text-white disabled:opacity-50">{busy ? <Loader2 className="w-3 h-3 animate-spin" /> : "OK"}</button>
          </form>
        )}
        {loading ? <div className="px-2 text-xs text-gray-500 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Chargement…</div> : saved.length === 0 ? <div className="px-2 text-[11px] text-gray-600">Aucun rapport enregistré pour ce client. Règle la vue, puis « + ».</div> : saved.map((v) => item(v.id, v.emoji, v.name, v.config, v))}
      </div>
      <div>
        <div className="px-2 mb-1 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Modèles</div>
        {VIEW_TEMPLATES.map((t) => item(`tpl:${t.id}`, t.emoji, t.name, t.config))}
      </div>
    </aside>
  );
}
