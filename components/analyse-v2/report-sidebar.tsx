"use client";

/**
 * Left column of Analyse Ads — Motion's workspace sidebar, same order:
 * client switcher (Motion's workspace pill) · Leaderboard · Opportunités ·
 * Concurrents (Motion's Inspo) · « Créer un rapport » · « Dossiers » header
 * (search + new) · « Rapports » folder with the client's saved reports, then
 * the « Modèles » folder (built-in reports). One line per report: type icon +
 * truncated name; the emoji is shown in the page title only (like Motion).
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FolderPlus, Lightbulb, MessagesSquare, Shapes, Loader2, Pencil, PlusCircle, Search, Swords, Trash2, Trophy, X } from "lucide-react";
import { AccountPicker } from "@/components/account-picker";
import { VIEW_TEMPLATES, type ViewConfig } from "@/lib/ads-warehouse/views";

export interface SavedView { id: string; accountKey: string | null; name: string; emoji: string; config: ViewConfig; createdByName: string; updatedAt: string }

export type AnalyseSection = "ads" | "leaderboard" | "themes" | "formats" | "opportunities" | "competitors";

interface Props {
  clientLabel: string | null;
  section: AnalyseSection;
  onSection: (s: AnalyseSection) => void;
  accountKey: string | null;
  saved: SavedView[];
  loading: boolean;
  activeId: string | null;
  onPick: (id: string, config: ViewConfig) => void;
  onCreate: () => void;
  onRename: (id: string, name: string, emoji: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

/** Motion's report-type icon: a small tinted square (top performing) or a bar icon (comparative). */
function TypeIcon({ config }: { config: ViewConfig }) {
  const comparative = config.groupBy !== "creative" && config.groupBy !== "ad";
  return comparative
    ? <span className="w-[18px] h-[18px] rounded-[5px] bg-sky-500/15 text-sky-300 flex items-center justify-center shrink-0"><svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor"><rect x="2" y="8" width="3" height="6" rx="1" /><rect x="6.5" y="4" width="3" height="10" rx="1" /><rect x="11" y="6" width="3" height="8" rx="1" /></svg></span>
    : <span className="w-[18px] h-[18px] rounded-[5px] bg-violet-500/15 flex items-center justify-center shrink-0"><span className="w-2 h-2 rounded-[2px] border border-violet-300" /></span>;
}

export function ReportSidebar({ clientLabel, section, onSection, accountKey, saved, loading, activeId, onPick, onCreate, onRename, onDelete }: Props) {
  const [openReports, setOpenReports] = useState(true);
  const [openTemplates, setOpenTemplates] = useState(true);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase());
  const savedShown = useMemo(() => saved.filter((v) => match(v.name)), [saved, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const templatesShown = useMemo(() => VIEW_TEMPLATES.filter((t) => match(t.name)), [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const nav = (id: AnalyseSection, Icon: typeof Trophy, label: string) => (
    <button key={id} type="button" onClick={() => onSection(id)} className={`w-full h-9 flex items-center gap-2.5 rounded-[10px] px-2 text-sm ${section === id ? "bg-gray-800 text-white" : "text-gray-300 hover:bg-gray-800/60"}`}>
      <Icon className="w-4 h-4 text-gray-400" />{label}
    </button>
  );

  const row = (id: string, label: string, config: ViewConfig, custom?: SavedView) => {
    const active = section === "ads" && activeId === id;
    if (editing === id && custom) {
      return (
        <form key={id} className="flex items-center gap-1 pl-7 pr-1 py-1" onSubmit={async (e) => { e.preventDefault(); await onRename(id, name.trim() || custom.name, custom.emoji); setEditing(null); }}>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="flex-1 min-w-0 h-7 rounded-md border border-gray-700 bg-gray-900 px-2 text-sm text-white" />
          <button type="button" onClick={() => setEditing(null)} className="p-1 text-gray-500 hover:text-white"><X className="w-3.5 h-3.5" /></button>
        </form>
      );
    }
    return (
      <div key={id} onClick={() => { onSection("ads"); onPick(id, config); }} className={`group h-9 flex items-center gap-2 rounded-[10px] pl-7 pr-2 text-sm cursor-pointer ${active ? "bg-gray-800 text-white" : "text-gray-300 hover:bg-gray-800/60"}`}>
        <TypeIcon config={config} />
        <span className="flex-1 min-w-0 truncate" title={label}>{label}</span>
        {custom && (
          <span className="hidden group-hover:flex items-center gap-1">
            <button type="button" title="Renommer" onClick={(e) => { e.stopPropagation(); setEditing(id); setName(custom.name); }} className="text-gray-500 hover:text-white"><Pencil className="w-3.5 h-3.5" /></button>
            <button type="button" title="Supprimer" onClick={async (e) => { e.stopPropagation(); if (confirm(`Supprimer le rapport « ${custom.name} » ?`)) await onDelete(id); }} className="text-gray-500 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
          </span>
        )}
      </div>
    );
  };

  return (
    <aside className="w-[250px] shrink-0 border-r border-gray-800 bg-gray-950 flex flex-col min-h-0">
      <div className="p-3 pb-2"><AccountPicker variant="workspace" label={clientLabel} /></div>
      <nav className="px-3 space-y-0.5">
        {nav("leaderboard", Trophy, "Leaderboard")}
        {nav("themes", MessagesSquare, "Thèmes de message")}
        {nav("formats", Shapes, "Formats visuels")}
        {nav("opportunities", Lightbulb, "Opportunités")}
        {nav("competitors", Swords, "Concurrents")}
        <button type="button" onClick={onCreate} disabled={!accountKey} className="w-full h-9 flex items-center gap-2.5 rounded-[10px] px-2 text-sm font-semibold text-white hover:bg-gray-800/60 disabled:opacity-40">
          <PlusCircle className="w-4 h-4" />Créer un rapport
        </button>
      </nav>

      <div className="mt-4 px-3 flex items-center justify-between h-8">
        <span className="px-2 text-sm font-medium text-gray-500">Dossiers</span>
        <span className="flex items-center gap-1">
          <button type="button" onClick={() => { setSearching((v) => !v); setQ(""); }} title="Rechercher un rapport" className="p-1 rounded-md text-gray-500 hover:text-white"><Search className="w-4 h-4" /></button>
          <button type="button" onClick={onCreate} disabled={!accountKey} title="Nouveau rapport" className="p-1 rounded-md text-gray-500 hover:text-white disabled:opacity-40"><FolderPlus className="w-4 h-4" /></button>
        </span>
      </div>
      {searching && <div className="px-3 pb-1"><input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Rechercher…" className="w-full h-8 rounded-[10px] border border-gray-800 bg-gray-900 px-2.5 text-sm text-white placeholder:text-gray-600" /></div>}

      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-3 pb-4">
        <button type="button" onClick={() => setOpenReports((v) => !v)} className="w-full h-9 flex items-center gap-1.5 px-2 text-sm text-gray-500 hover:text-gray-300">
          {openReports ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}Rapports
        </button>
        {openReports && (loading
          ? <div className="pl-7 h-9 flex items-center gap-1.5 text-sm text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" />Chargement…</div>
          : savedShown.length === 0
            ? <div className="pl-7 pr-2 py-1.5 text-xs text-gray-600">{accountKey ? "Aucun rapport enregistré pour ce client : « Créer un rapport »." : "Choisis un client."}</div>
            : savedShown.map((v) => row(v.id, v.name, v.config, v)))}
        <button type="button" onClick={() => setOpenTemplates((v) => !v)} className="w-full h-9 flex items-center gap-1.5 px-2 text-sm text-gray-500 hover:text-gray-300">
          {openTemplates ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}Modèles
        </button>
        {openTemplates && templatesShown.map((t) => row(`tpl:${t.id}`, t.name, t.config))}
      </div>
    </aside>
  );
}
