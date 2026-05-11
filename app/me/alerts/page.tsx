"use client";

import { useEffect, useState, useCallback } from "react";

type Rule = {
  id: string;
  clientId: string | null;
  platform: string;
  metric: string;
  condition: string;
  threshold: number;
  window: string;
  enabled: boolean;
  lastTriggeredAt: string | null;
  _count: { events: number };
};

type Account = { platform: string; accountId: string; label: string | null };

const METRICS = [
  { value: "roas", label: "ROAS" },
  { value: "cpa", label: "CPA" },
  { value: "ctr", label: "CTR" },
  { value: "spend", label: "Dépenses" },
  { value: "frequency", label: "Fréquence" },
];
const CONDITIONS = [
  { value: "below", label: "en dessous de" },
  { value: "above", label: "au-dessus de" },
  { value: "drop_pct", label: "chute > x% vs période précédente" },
];

export default function MeAlertsPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [formAccountId, setFormAccountId] = useState("");
  const [formMetric, setFormMetric] = useState("roas");
  const [formCondition, setFormCondition] = useState("below");
  const [formThreshold, setFormThreshold] = useState(2);
  const [formWindow, setFormWindow] = useState("7d");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [r, a] = await Promise.all([
      fetch("/api/me/alerts").then((res) => res.json()),
      fetch("/api/me/accounts").then((res) => res.json()),
    ]);
    setRules(r.rules ?? []);
    setAccounts(a.accounts ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/me/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: formAccountId || null,
        platform: "meta",
        metric: formMetric,
        condition: formCondition,
        threshold: formThreshold,
        window: formWindow,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Création échouée");
      return;
    }
    setShowCreate(false);
    setFormAccountId("");
    load();
  }

  async function handleToggle(r: Rule) {
    await fetch(`/api/me/alerts/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !r.enabled }),
    });
    load();
  }

  async function handleDelete(id: string) {
    if (!confirm("Supprimer cette règle ?")) return;
    await fetch(`/api/me/alerts/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="p-6 space-y-4 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Mes alertes</h1>
          <p className="text-sm text-gray-400 mt-1">
            Détection proactive d'anomalies sur tes comptes.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="px-4 py-2 rounded-lg font-semibold text-sm bg-gradient-to-br from-violet-600 to-purple-600 text-white"
        >
          + Nouvelle règle
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="p-5 rounded-xl space-y-3 bg-gray-900 border border-gray-800">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-gray-400">Compte (vide = tous mes comptes)</span>
              <select
                value={formAccountId}
                onChange={(e) => setFormAccountId(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg text-sm bg-black/40 border border-gray-800 text-white"
              >
                <option value="">Tous</option>
                {accounts.filter((a) => a.platform === "meta").map((a) => (
                  <option key={a.accountId} value={a.accountId}>{a.label ?? a.accountId}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-gray-400">Métrique</span>
              <select
                value={formMetric}
                onChange={(e) => setFormMetric(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg text-sm bg-black/40 border border-gray-800 text-white"
              >
                {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-gray-400">Condition</span>
              <select
                value={formCondition}
                onChange={(e) => setFormCondition(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg text-sm bg-black/40 border border-gray-800 text-white"
              >
                {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-gray-400">Seuil</span>
              <input
                type="number"
                step="0.1"
                value={formThreshold}
                onChange={(e) => setFormThreshold(parseFloat(e.target.value))}
                required
                className="mt-1 w-full px-3 py-2 rounded-lg text-sm bg-black/40 border border-gray-800 text-white"
              />
            </label>
            <label className="block col-span-2">
              <span className="text-xs text-gray-400">Fenêtre</span>
              <select
                value={formWindow}
                onChange={(e) => setFormWindow(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg text-sm bg-black/40 border border-gray-800 text-white"
              >
                <option value="1d">Hier</option>
                <option value="7d">7 derniers jours</option>
                <option value="14d">14 derniers jours</option>
                <option value="30d">30 derniers jours</option>
              </select>
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
      ) : rules.length === 0 ? (
        <div className="text-center py-12 text-gray-500 border border-dashed border-gray-800 rounded-2xl">
          Aucune règle. Exemple : ROAS en dessous de 1.5 sur 7 jours.
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => (
            <div key={r.id} className="p-4 rounded-xl bg-gray-900 border border-gray-800 flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-gray-800">
                    {METRICS.find((m) => m.value === r.metric)?.label ?? r.metric}
                  </span>
                  <span className="text-sm text-gray-400">
                    {CONDITIONS.find((c) => c.value === r.condition)?.label ?? r.condition}
                  </span>
                  <span className="font-semibold text-white">{r.threshold}{r.condition === "drop_pct" ? "%" : ""}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">{r.window}</span>
                  {r.enabled ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 ml-2">actif</span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400 ml-2">désactivé</span>
                  )}
                </div>
                <div className="text-xs mt-1 text-gray-500">
                  {r.clientId ?? "tous mes comptes"} · {r._count.events} déclenchement{r._count.events > 1 ? "s" : ""}
                  {r.lastTriggeredAt && <> · dernier : {new Date(r.lastTriggeredAt).toLocaleString("fr-FR")}</>}
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => handleToggle(r)} className="text-xs px-2 py-1 text-gray-400 hover:text-white">
                  {r.enabled ? "Désactiver" : "Activer"}
                </button>
                <button onClick={() => handleDelete(r.id)} className="text-xs px-2 py-1 text-red-400 hover:text-red-300">
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
