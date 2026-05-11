"use client";

import { useEffect, useState, useCallback } from "react";
import { Section, PageHeader, Pill, Card } from "@/components/ui/surface";

type Schedule = {
  id: string;
  userId: string;
  clientId: string;
  clientLabel: string | null;
  platform: string;
  frequency: string;
  recipients: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunError: string | null;
  nextRunAt: string | null;
  user: { email: string | null; name: string | null };
};

type ClientUser = {
  id: string;
  email: string | null;
  name: string | null;
  adAccounts: { platform: string; accountId: string; label: string | null }[];
};

const inputCls =
  "mt-1 w-full px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";
const labelCls = "block";
const labelSpanCls = "text-xs text-gray-400";
const primaryBtnCls =
  "px-4 py-2 rounded-lg font-semibold text-sm bg-violet-600 hover:bg-violet-500 text-white transition-colors";
const secondaryBtnCls =
  "px-3 py-2 rounded-lg text-sm font-medium bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/30 transition-colors";

export default function AdminSchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [users, setUsers] = useState<ClientUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [formUserId, setFormUserId] = useState("");
  const [formAccountId, setFormAccountId] = useState("");
  const [formFrequency, setFormFrequency] = useState<"monthly" | "weekly">("monthly");
  const [formRecipients, setFormRecipients] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, u] = await Promise.all([
      fetch("/api/admin/schedules").then((r) => r.json()),
      fetch("/api/admin/users").then((r) => r.json()),
    ]);
    setSchedules(s.schedules ?? []);
    setUsers(u.users ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selectedUser = users.find((u) => u.id === formUserId);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const account = selectedUser?.adAccounts.find((a) => a.accountId === formAccountId);
    const res = await fetch("/api/admin/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: formUserId,
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
    setFormUserId("");
    setFormAccountId("");
    setFormRecipients("");
    setShowCreate(false);
    load();
  }

  async function handleToggle(s: Schedule) {
    await fetch(`/api/admin/schedules/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    load();
  }

  async function handleDelete(id: string) {
    if (!confirm("Supprimer cette planification ?")) return;
    await fetch(`/api/admin/schedules/${id}`, { method: "DELETE" });
    load();
  }

  async function runNow() {
    const res = await fetch("/api/cron/reports");
    const data = await res.json();
    alert(`${data.processed ?? 0} rapport(s) traité(s).`);
    load();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rapports planifiés"
        subtitle="Génération automatique des rapports mensuels/hebdo par client."
        action={
          <div className="flex gap-2">
            <button onClick={runNow} className={secondaryBtnCls}>
              Exécuter maintenant
            </button>
            <button onClick={() => setShowCreate((s) => !s)} className={primaryBtnCls}>
              + Nouvelle planification
            </button>
          </div>
        }
      />

      {showCreate && (
        <Card padded>
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className={labelCls}>
                <span className={labelSpanCls}>Client</span>
                <select
                  value={formUserId}
                  onChange={(e) => { setFormUserId(e.target.value); setFormAccountId(""); }}
                  required
                  className={inputCls}
                >
                  <option value="">— Sélectionner —</option>
                  {users.filter((u) => u.adAccounts.length > 0).map((u) => (
                    <option key={u.id} value={u.id}>{u.email ?? u.id}</option>
                  ))}
                </select>
              </label>
              <label className={labelCls}>
                <span className={labelSpanCls}>Compte publicitaire</span>
                <select
                  value={formAccountId}
                  onChange={(e) => setFormAccountId(e.target.value)}
                  required
                  disabled={!selectedUser}
                  className={`${inputCls} disabled:opacity-50`}
                >
                  <option value="">— Sélectionner —</option>
                  {selectedUser?.adAccounts.map((a) => (
                    <option key={a.accountId} value={a.accountId}>
                      [{a.platform}] {a.label ?? a.accountId}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelCls}>
                <span className={labelSpanCls}>Fréquence</span>
                <select
                  value={formFrequency}
                  onChange={(e) => setFormFrequency(e.target.value as "monthly" | "weekly")}
                  className={inputCls}
                >
                  <option value="monthly">Mensuel (1er du mois 07:00 UTC)</option>
                  <option value="weekly">Hebdomadaire (lundi 07:00 UTC)</option>
                </select>
              </label>
              <label className={labelCls}>
                <span className={labelSpanCls}>Destinataires (emails séparés par virgule)</span>
                <input
                  value={formRecipients}
                  onChange={(e) => setFormRecipients(e.target.value)}
                  required
                  placeholder="client@example.com, melvin@impulse-analytics.com"
                  className={inputCls}
                />
              </label>
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white">
                Annuler
              </button>
              <button type="submit" className={primaryBtnCls.replace("py-2", "py-1.5")}>
                Créer
              </button>
            </div>
          </form>
        </Card>
      )}

      {loading ? (
        <p className="text-gray-400">Chargement…</p>
      ) : schedules.length === 0 ? (
        <Card padded className="text-center text-gray-500 border-dashed">
          Aucune planification. Clique sur "Nouvelle planification" pour démarrer.
        </Card>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <Card key={s.id} padded className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-white">{s.clientLabel ?? s.clientId}</span>
                  <Pill tone="violet">{s.frequency}</Pill>
                  <Pill tone={s.enabled ? "emerald" : "default"}>{s.enabled ? "actif" : "désactivé"}</Pill>
                </div>
                <div className="text-xs mt-1 text-gray-400">
                  {s.user.email} · → {s.recipients}
                </div>
                <div className="text-xs mt-0.5 text-gray-500">
                  Prochain : {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString("fr-FR") : "—"}
                  {s.lastRunAt && <> · Dernier : {new Date(s.lastRunAt).toLocaleString("fr-FR")}</>}
                  {s.lastRunError && <span className="text-red-400"> · Erreur : {s.lastRunError}</span>}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => handleToggle(s)} className="text-xs px-2 py-1 rounded text-gray-400 hover:text-white">
                  {s.enabled ? "Désactiver" : "Activer"}
                </button>
                <button onClick={() => handleDelete(s.id)} className="text-xs px-2 py-1 rounded text-red-400 hover:text-red-300">
                  Supprimer
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
