"use client";

/** Model + reasoning-effort selectors shared by the staff AI surfaces. */

import { EFFORT_OPTIONS, MODEL_OPTIONS, type AiEffort, type AiModel, type AiPrefs } from "@/lib/ai-chat-shared";

export function ModelPicker({ prefs, onChange, disabled, idPrefix = "ai" }: {
  prefs: AiPrefs;
  onChange: (patch: Partial<AiPrefs>) => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const cls = "min-w-0 px-2 py-1 rounded-md text-[11px] bg-gray-900 border border-gray-800 text-gray-300 focus:border-violet-500 focus:outline-none disabled:opacity-60";
  return (
    <div className="flex gap-2" title="Changer de modèle en cours de conversation redémarre la session côté IA (l'historique est renvoyé).">
      <label className="sr-only" htmlFor={`${idPrefix}-model`}>Modèle</label>
      <select id={`${idPrefix}-model`} value={prefs.model} disabled={disabled} onChange={(e) => onChange({ model: e.target.value as AiModel })} className={`flex-1 ${cls}`}>
        {MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>)}
      </select>
      <label className="sr-only" htmlFor={`${idPrefix}-effort`}>Réflexion</label>
      <select id={`${idPrefix}-effort`} value={prefs.effort} disabled={disabled} onChange={(e) => onChange({ effort: e.target.value as AiEffort })} className={`flex-1 ${cls}`}>
        {EFFORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>)}
      </select>
    </div>
  );
}
