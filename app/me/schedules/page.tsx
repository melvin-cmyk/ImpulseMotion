"use client";

import { useEffect, useState, useCallback } from "react";

type Schedule = {
  id: string;
  clientId: string;
  clientLabel: string | null;
  platform: string;
  frequency: string;
  recipients: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunError: string | null;
  nextRunAt: string | null;
};

type Account = { platform: string; accountId: string; label: string | null };

export default function MeSchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [formAccountId, setFormAccountId] = useState("");
  const [formFrequency, setFormFrequency] = useState<"monthly" | "weekly">("monthly");
  const [formRecipients, setFormRecipients] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, a] = await Promise.all([
      fetch("/api/me/schedules").then((r) => r.json()),
      fetch("/api/me/accounts").then((r) => r.json()),
    ]);
    setSchedules(s.schedules ?? []);
    setAccounts(a.accounts ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const account = accounts.find((a) => a.accountId === formAccountId);
    const res = await fetch("/api/me/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: formAccountId,
        clientLabel: account?.label ?? null,
        platform: account?.platform ?? "meta",
        frequency: formFrequency,
        recipients: formRecipients,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Création échouée");
      return;
    }
    setFormAccountId("");
    setFormRecipients("");
    setShowCreate(false);
    load();
  }

  async function handleToggle(s: Schedule) {
    await fetch(`/api/me/schedules/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    load();
  }

  async function handleDelete(id: string) {
    if (!confirm("Supprimer cette planification ?")) return;
    await fetch(`/api/me/schedules/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="p-6 space-y-4 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Mes rapports planifiés</h1>
          <p className="text-sm text-gray-400 mt-1">
            Rapports automatiques pour les comptes que tu gères.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="px-4 py-2 rounded-lg font-semibold text-sm bg-gradient-to-br from-violet-600 to-purple-600 text-white"
        >
          + Nouvelle planification
        </button>
      </div>

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="p-5 rounded-xl space-y-3 bg-gray-900 border border-gray-800"
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-gray-400">Compte</span>
              <select
                value={formAccountId}
                onChange={(e) => setFormAccountId(e.target.value)}
                required
                className="mt-1 w-full px-3 py-2 rounded-lg text-sm bg-black/40 border border-gray-800 text-white"
              >
                <option value="">— Sélectionner —</option>
                {accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    [{a.platform}] {a.label ?? a.accountId}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-gray-400">Fréquence</span>
              <select
                value={formFrequency}
                onChange={(e) => setFormFrequency(e.target.value as "monthly" | "weekly")}
                className="mt-1 w-full px-3 py-2 rounded-lg text-sm bg-black/40 border border-gray-800 text-white"
              >
                <option value="monthly">Mensuel</option>
                <option value="weekly">Hebdomadaire</option>
              </select>
            </label>
            <label className="block col-span-2">
              <span className="text-xs text-gray-400">Destinataires (emails)</span>
              <input
                value={formRecipients}
                onChange={(e) => setFormRecipients(e.target.value)}
                required
                placeholder="moi@exemple.com, client@exemple.com"
                className="mt-1 w-full px-3 py-2 rounded-lg text-sm bg-black/40 border border-gray-800 text-white"
              />
            </label>
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-400">
              Annuler
            </button>
            <button type="submit" className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-gradient-to-br from-violet-600 to-purple-600 text-white">
              Créer
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="text-gray-400">Chargement…</p>
      ) : schedules.length === 0 ? (
        <div className="text-center py-12 text-gray-500 border border-dashed border-gray-800 rounded-2xl">
          Aucune planification pour l'instant.
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <div key={s.id} className="p-4 rounded-xl bg-gray-900 border border-gray-800 flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-white">{s.clientLabel ?? s.clientId}</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-violet-500/15 text-violet-300">{s.frequency}</span>
                  {s.enabled ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300">actif</span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400">désactivé</span>
                  )}
                </div>
                <div className="text-xs mt-1 text-gray-500">→ {s.recipients}</div>
                <div className="text-xs mt-0.5 text-gray-600">
                  Prochain : {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString("fr-FR") : "—"}
                  {s.lastRunAt && <> · Dernier : {new Date(s.lastRunAt).toLocaleString("fr-FR")}</>}
                  {s.lastRunError && <span className="text-red-400"> · Erreur : {s.lastRunError}</span>}
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => handleToggle(s)} className="text-xs px-2 py-1 text-gray-400 hover:text-white">
                  {s.enabled ? "Désactiver" : "Activer"}
                </button>
                <button onClick={() => handleDelete(s.id)} className="text-xs px-2 py-1 text-red-400 hover:text-red-300">
                  Supprimer
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
