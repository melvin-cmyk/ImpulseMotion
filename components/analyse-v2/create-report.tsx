"use client";

/**
 * Motion's « Create report » modal: three large starting tiles (Top
 * performers, Comparative analysis, Launch analysis), « ou partir d'un
 * modèle » and the templates in sections (Trouver les gagnantes / Trouver les
 * problèmes / Comprendre la performance), then a name. The report is saved for
 * the client and opened.
 */

import { useState } from "react";
import { BarChart3, Loader2, Rocket, Star, X } from "lucide-react";
import { VIEW_TEMPLATES, type ViewConfig, type ViewTemplate } from "@/lib/ads-warehouse/views";

const SECTIONS: Array<{ title: string; ids: string[] }> = [
  { title: "Trouver les gagnantes", ids: ["top", "converters", "scalers", "hooks", "clicks"] },
  { title: "Trouver les problèmes", ids: ["heavies", "cpm", "fatigue"] },
  { title: "Comprendre la performance", ids: ["format", "video", "static", "copy", "landing", "wow", "active", "launches"] },
];

const byId = (id: string) => VIEW_TEMPLATES.find((t) => t.id === id)!;

interface Props {
  current: ViewConfig;
  onClose: () => void;
  onCreate: (name: string, emoji: string, config: ViewConfig) => Promise<void>;
}

export function CreateReportModal({ current, onClose, onCreate }: Props) {
  const top = byId("top");
  const tiles: Array<{ id: string; icon: typeof Star; tint: string; label: string; emoji: string; config: ViewConfig }> = [
    { id: "top", icon: Star, tint: "bg-amber-500/20 text-amber-300", label: "Meilleures créas", emoji: "🏆", config: top.config },
    { id: "compare", icon: BarChart3, tint: "bg-sky-500/20 text-sky-300", label: "Analyse comparative", emoji: "📊", config: { ...top.config, groupBy: "format", view: "bar" } },
    { id: "launch", icon: Rocket, tint: "bg-pink-500/20 text-pink-300", label: "Analyse de lancement", emoji: "🚀", config: byId("launches").config },
  ];
  const [picked, setPicked] = useState<{ name: string; emoji: string; config: ViewConfig } | null>({ name: "", emoji: "🏆", config: current });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const pick = (label: string, emoji: string, config: ViewConfig) => { setPicked({ name: label, emoji, config }); setName(label); };
  const tpl = (t: ViewTemplate) => (
    <button key={t.id} type="button" onClick={() => pick(t.name, t.emoji, t.config)} className={`text-left rounded-xl border p-3 hover:border-ui-line-strong ${picked?.config === t.config ? "border-ui-accent bg-ui-accent-soft" : "border-ui-line"}`}>
      <div className="flex items-center gap-2"><span className="w-7 h-7 rounded-lg bg-ui-raised flex items-center justify-center">{t.emoji}</span><span className="text-sm font-medium text-ui-fg">{t.name}</span></div>
      <div className="mt-1.5 text-xs leading-snug text-ui-fg2 line-clamp-2">{t.description}</div>
    </button>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label="Créer un rapport">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-[860px] max-w-full max-h-[90vh] rounded-xl border border-ui-line bg-ui-bg flex flex-col">
        <div className="flex items-center justify-between px-6 h-16 shrink-0">
          <h2 className="text-lg font-medium text-ui-fg">Créer un rapport</h2>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md text-ui-fg2 hover:text-ui-fg hover:bg-ui-raised" aria-label="Fermer"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4 space-y-5">
          <div className="grid grid-cols-3 gap-3">
            {tiles.map((t) => (
              <button key={t.id} type="button" onClick={() => pick(t.label, t.emoji, t.config)} className={`h-24 rounded-xl border flex flex-col items-start justify-between p-4 hover:border-ui-line-strong ${picked?.config === t.config ? "border-ui-accent bg-ui-accent-soft" : "border-ui-line"}`}>
                <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${t.tint}`}><t.icon className="w-4 h-4" /></span>
                <span className="text-sm font-medium text-ui-fg">{t.label}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 text-xs text-ui-muted"><span className="h-px flex-1 bg-ui-raised" />ou partir d&apos;un modèle<span className="h-px flex-1 bg-ui-raised" /></div>
          {SECTIONS.map((s) => (
            <div key={s.title}>
              <div className="mb-2 text-sm font-medium text-ui-fg2">{s.title}</div>
              <div className="grid grid-cols-3 gap-3">{s.ids.map((id) => tpl(byId(id)))}</div>
            </div>
          ))}
        </div>
        <form className="flex items-center gap-2 px-6 py-4 border-t border-ui-line shrink-0" onSubmit={async (e) => { e.preventDefault(); if (!picked || !name.trim()) return; setBusy(true); try { await onCreate(name.trim(), picked.emoji, picked.config); onClose(); } finally { setBusy(false); } }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={picked?.config === current ? "Nom du rapport (vue actuelle)" : "Nom du rapport"} className="flex-1 h-9 rounded-[10px] border border-ui-line bg-ui-card px-3 text-sm text-ui-fg placeholder:text-ui-muted" />
          <button type="submit" disabled={busy || !name.trim()} className="h-9 inline-flex items-center gap-1.5 rounded-[10px] bg-ui-inverse px-4 text-sm font-medium text-ui-on-inverse hover:opacity-90 disabled:opacity-40">{busy && <Loader2 className="w-4 h-4 animate-spin" />}Créer</button>
        </form>
      </div>
    </div>
  );
}
