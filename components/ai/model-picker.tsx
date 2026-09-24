"use client";

/**
 * Model + reasoning-effort selectors shared by the staff AI surfaces, plus
 * the Claude Max account of the pool when the relay has more than one
 * (`auto` = the relay picks the account with the most room).
 */

import { useEffect, useState } from "react";
import { EFFORT_OPTIONS, MODEL_OPTIONS, type AiEffort, type AiModel, type AiPrefs } from "@/lib/ai-chat-shared";

interface AccountOption { id: string; label: string; level: number | null; fallbackActive: boolean; usageVisible?: boolean | null; fiveHour?: number | null; sevenDay?: number | null }

export function ModelPicker({ prefs, onChange, disabled, idPrefix = "ai" }: {
  prefs: AiPrefs;
  onChange: (patch: Partial<AiPrefs>) => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  useEffect(() => {
    fetch("/api/relay/accounts")
      .then((r) => (r.ok ? r.json() : { accounts: [] }))
      .then((j) => setAccounts(Array.isArray(j.accounts) ? j.accounts : []))
      .catch(() => {});
  }, []);

  const cls = "min-w-0 px-2 py-1 rounded-md text-[11px] bg-gray-900 border border-gray-800 text-gray-300 focus:border-violet-500 focus:outline-none disabled:opacity-60";
  const account = prefs.account ?? "auto";
  return (
    <div className="flex gap-2" title="Changer de modèle en cours de conversation redémarre la session côté IA (l'historique est renvoyé). Changer de compte Max est transparent.">
      <label className="sr-only" htmlFor={`${idPrefix}-model`}>Modèle</label>
      <select id={`${idPrefix}-model`} value={prefs.model} disabled={disabled} onChange={(e) => onChange({ model: e.target.value as AiModel })} className={`flex-1 ${cls}`}>
        {MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>)}
      </select>
      <label className="sr-only" htmlFor={`${idPrefix}-effort`}>Réflexion</label>
      <select id={`${idPrefix}-effort`} value={prefs.effort} disabled={disabled} onChange={(e) => onChange({ effort: e.target.value as AiEffort })} className={`flex-1 ${cls}`}>
        {EFFORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>)}
      </select>
      {accounts.length > 1 && (
        <>
          <label className="sr-only" htmlFor={`${idPrefix}-account`}>Compte Claude Max</label>
          <select id={`${idPrefix}-account`} value={account} disabled={disabled} onChange={(e) => onChange({ account: e.target.value })} className={`flex-1 ${cls}`} title="Compte Claude Max qui répond ; « Auto » prend celui qui a le plus de marge">
            <option value="auto">Compte : auto</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {a.usageVisible === false ? " — usage non visible" : a.level !== null ? ` — 5 h ${Math.round(a.fiveHour ?? 0)} % · 7 j ${Math.round(a.sevenDay ?? 0)} %` : ""}
                {a.fallbackActive ? " (saturé)" : ""}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}
