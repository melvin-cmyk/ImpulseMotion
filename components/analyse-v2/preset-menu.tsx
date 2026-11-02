"use client";

/**
 * Motion's column presets: built-in presets, the team's saved presets
 * (apply, set as default ★, rename, delete) and « Enregistrer les colonnes
 * actuelles ». The default preset gives its columns to every report that has
 * no columns of its own.
 */

import { useState } from "react";
import { Check, ChevronDown, Columns3, Pencil, Star, Trash2 } from "lucide-react";
import type { MetricKey } from "@/lib/ads-warehouse/query";
import { PRESETS } from "@/lib/ads-warehouse/metrics-ui";
import { MenuItem, MenuLabel, PILL, Popover } from "./pill";

export interface TeamPreset { id: string; name: string; metrics: MetricKey[]; columns: MetricKey[]; isDefault: boolean; createdByName: string }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Props {
  columns: MetricKey[] | undefined;
  metrics: MetricKey[];
  team: TeamPreset[];
  onApply: (columns: MetricKey[] | undefined, metrics?: MetricKey[]) => void;
  onReload: () => void;
}

export function PresetMenu({ columns, metrics, team, onApply, onReload }: Props) {
  const [name, setName] = useState("");
  const [asDefault, setAsDefault] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const current = team.find((p) => same(p.columns, columns)) ?? PRESETS.find((p) => same(p.keys, columns));
  const label = current ? ("label" in current ? current.label : current.name) : columns ? "Personnalisé" : (team.find((p) => p.isDefault)?.name ?? "Personnalisé");

  async function save() {
    if (!name.trim() || !columns?.length && !metrics.length) return;
    const res = await fetch("/api/ads/presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), metrics, columns: columns?.length ? columns : metrics, isDefault: asDefault }) });
    if (res.ok) { setName(""); setAsDefault(false); onReload(); }
  }
  const patch = async (id: string, body: Record<string, unknown>) => { await fetch(`/api/ads/presets/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); onReload(); };
  const remove = async (id: string) => { await fetch(`/api/ads/presets/${id}`, { method: "DELETE" }); onReload(); };

  return (
    <Popover width={320} trigger={({ toggle }) => <button type="button" onClick={toggle} className={PILL}><Columns3 className="w-4 h-4 text-gray-400" />{label}<ChevronDown className="w-3.5 h-3.5 text-gray-500" /></button>}>
      {(close) => (<div className="max-h-[460px] overflow-y-auto">
        <MenuItem active={!columns} onClick={() => { onApply(undefined); close(); }}>Colonnes par défaut{team.some((p) => p.isDefault) ? ` (${team.find((p) => p.isDefault)!.name})` : ""}</MenuItem>
        {team.length > 0 && <MenuLabel>Préréglages de l&apos;équipe</MenuLabel>}
        {team.map((p) => editing === p.id ? (
          <form key={p.id} className="flex items-center gap-1 px-1.5 py-1" onSubmit={async (e) => { e.preventDefault(); await patch(p.id, { name: editName }); setEditing(null); }}>
            <input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus className="flex-1 h-7 rounded-md border border-gray-700 bg-gray-900 px-2 text-sm text-white" />
            <button type="submit" className="p-1 text-gray-300 hover:text-white"><Check className="w-4 h-4" /></button>
          </form>
        ) : (
          <div key={p.id} className={`group h-8 flex items-center gap-1 rounded-lg pl-2.5 pr-1 text-sm ${same(p.columns, columns) ? "bg-gray-800 text-white" : "text-gray-200 hover:bg-gray-800/70"}`}>
            <button type="button" onClick={() => { onApply(p.columns, p.metrics.length ? p.metrics : undefined); close(); }} className="flex-1 min-w-0 truncate text-left" title={p.createdByName ? `par ${p.createdByName}` : undefined}>{p.name}</button>
            <button type="button" onClick={() => void patch(p.id, { isDefault: !p.isDefault })} title={p.isDefault ? "Préréglage par défaut de l'équipe" : "Définir par défaut"} className={`p-1 ${p.isDefault ? "text-amber-300" : "text-gray-600 opacity-0 group-hover:opacity-100 hover:text-amber-300"}`}><Star className={`w-3.5 h-3.5 ${p.isDefault ? "fill-amber-300" : ""}`} /></button>
            <button type="button" onClick={() => { setEditing(p.id); setEditName(p.name); }} title="Renommer" className="p-1 text-gray-600 opacity-0 group-hover:opacity-100 hover:text-white"><Pencil className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={() => { if (confirm(`Supprimer le préréglage « ${p.name} » ?`)) void remove(p.id); }} title="Supprimer" className="p-1 text-gray-600 opacity-0 group-hover:opacity-100 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        ))}
        <MenuLabel>Modèles</MenuLabel>
        {PRESETS.map((p) => <MenuItem key={p.id} active={same(p.keys, columns)} onClick={() => { onApply(p.keys, p.keys.slice(0, 6)); close(); }}>{p.label}</MenuItem>)}
        <div className="border-t border-gray-800 mt-1 p-2 space-y-1.5">
          <div className="text-xs text-gray-400">Enregistrer les colonnes et métriques actuelles</div>
          <div className="flex gap-1.5">
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} placeholder="Nom du préréglage" className="flex-1 h-8 rounded-lg border border-gray-800 bg-gray-900 px-2 text-sm text-white placeholder:text-gray-600" />
            <button type="button" onClick={() => void save()} disabled={!name.trim()} className="h-8 rounded-lg bg-white px-2.5 text-xs font-medium text-gray-900 disabled:opacity-40">Enregistrer</button>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer"><input type="checkbox" className="accent-violet-500" checked={asDefault} onChange={(e) => setAsDefault(e.target.checked)} />Par défaut pour toute l&apos;équipe</label>
        </div>
      </div>)}
    </Popover>
  );
}
