"use client";

/**
 * Motion's custom groups of a comparative report (« Comparing A, B, +1 »):
 * each group = a name + words searched in the ad name (or campaign / ad set,
 * or both). First matching group wins; the rest is « Autres ».
 */

import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import type { CustomGroup } from "@/lib/ads-warehouse/query";

interface Props { initial: CustomGroup[]; onClose: () => void; onApply: (groups: CustomGroup[]) => void }

export function GroupsEditor({ initial, onClose, onApply }: Props) {
  const [groups, setGroups] = useState<Array<{ name: string; words: string; field: NonNullable<CustomGroup["field"]> }>>(
    initial.length ? initial.map((g) => ({ name: g.name, words: g.contains.join(", "), field: g.field ?? "name" })) : [{ name: "", words: "", field: "name" }, { name: "", words: "", field: "name" }],
  );
  const set = (i: number, p: Partial<(typeof groups)[number]>) => setGroups((gs) => gs.map((g, j) => (j === i ? { ...g, ...p } : g)));
  const valid = groups.filter((g) => g.name.trim() && g.words.trim());
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label="Groupes personnalisés">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-[640px] max-w-full rounded-2xl border border-gray-800 bg-gray-950">
        <div className="flex items-center justify-between px-5 h-14 border-b border-gray-800">
          <h2 className="text-base font-semibold text-white">Groupes personnalisés</h2>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800" aria-label="Fermer"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3 max-h-[60vh] overflow-y-auto">
          <p className="text-sm text-gray-400">Compare des groupes que tu définis : une annonce va dans le premier groupe dont un mot apparaît (sans tenir compte des majuscules). Le reste est regroupé dans « Autres ».</p>
          {groups.map((g, i) => (
            <div key={i} className="flex items-center gap-2">
              <input value={g.name} onChange={(e) => set(i, { name: e.target.value })} placeholder={`Groupe ${i + 1} (ex. Témoignage)`} className="w-40 h-9 rounded-[10px] border border-gray-800 bg-gray-900 px-2.5 text-sm text-white placeholder:text-gray-600" />
              <select value={g.field} onChange={(e) => set(i, { field: e.target.value as NonNullable<CustomGroup["field"]> })} className="h-9 rounded-[10px] border border-gray-800 bg-gray-900 px-2 text-sm text-gray-200">
                <option value="name">Nom d&apos;annonce contient</option>
                <option value="campaign">Campagne / ad set contient</option>
                <option value="any">L&apos;un ou l&apos;autre contient</option>
              </select>
              <input value={g.words} onChange={(e) => set(i, { words: e.target.value })} placeholder="mots séparés par des virgules" className="flex-1 min-w-0 h-9 rounded-[10px] border border-gray-800 bg-gray-900 px-2.5 text-sm text-white placeholder:text-gray-600" />
              <button type="button" onClick={() => setGroups((gs) => gs.filter((_, j) => j !== i))} className="p-1.5 text-gray-500 hover:text-red-400" aria-label="Retirer"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          {groups.length < 20 && <button type="button" onClick={() => setGroups((gs) => [...gs, { name: "", words: "", field: "name" }])} className="inline-flex items-center gap-1.5 text-sm text-gray-300 hover:text-white"><Plus className="w-4 h-4" />Ajouter un groupe</button>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-800">
          <button type="button" onClick={onClose} className="h-9 rounded-[10px] border border-gray-800 px-3 text-sm text-gray-200 hover:border-gray-700">Annuler</button>
          <button type="button" disabled={valid.length === 0} onClick={() => onApply(valid.map((g) => ({ name: g.name.trim(), contains: g.words.split(",").map((w) => w.trim()).filter(Boolean), field: g.field })))} className="h-9 rounded-[10px] bg-white px-4 text-sm font-medium text-gray-900 hover:bg-gray-200 disabled:opacity-40">Comparer {valid.length || ""} groupe{valid.length > 1 ? "s" : ""}</button>
        </div>
      </div>
    </div>
  );
}
