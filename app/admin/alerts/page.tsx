"use client";

import { useEffect, useState, useCallback } from "react";
import { Section, PageHeader, Pill, Card } from "@/components/ui/surface";

type Rule = {
  id: string;
  userId: string;
  clientId: string | null;
  platform: string;
  metric: string;
  condition: string;
  threshold: number;
  window: string;
  enabled: boolean;
  lastTriggeredAt: string | null;
  user: { email: string | null; name: string | null };
  _count: { events: number };
};

type ClientUser = {
  id: string;
  email: string | null;
  name: string | null;
  adAccounts: { platform: string; accountId: string; label: string | null }[];
};

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

const inputCls =
  "mt-1 w-full px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";
const labelSpanCls = "text-xs text-gray-400";
const primaryBtnCls =
  "px-4 py-2 rounded-lg font-semibold text-sm bg-violet-600 hover:bg-violet-500 text-white transition-colors";
const secondaryBtnCls =
  "px-3 py-2 rounded-lg text-sm font-medium bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/30 transition-colors";

export default function AdminAlertsPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [users, setUsers] = useState<ClientUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [formUserId, setFormUserId] = useState("");
  const [formAccountId, setFormAccountId] = useState("");
  const [formMetric, setFormMetric] = useState("roas");
  const [formCondition, setFormCondition] = useState("below");
  const [formThreshold, setFormThreshold] = useState(2);
  const [formWindow, setFormWindow] = useState("7d");
  const [error, setError] = useState<string | null>(null);
  // TODO (Lot F4): rules are still attached to a login + raw account id; redesign "per dashboard" (client = ad account).

  const load = useCallback(async () => {
    try {
      const [r, u] = await Promise.all([
        fetch("/api/admin/alerts").then((res) => (res.ok ? res.json() : { rules: [] })).catch(() => ({ rules: [] })),
        fetch("/api/admin/users").then((res) => (res.ok ? res.json() : { users: [] })).catch(() => ({ users: [] })),
      ]);
      setRules(Array.isArray(r?.rules) ? r.rules : []);
      setUsers((Array.isArray(u?.users) ? u.users : []).map((x: ClientUser) => ({ ...x, adAccounts: Array.isArray(x.adAccounts) ? x.adAccounts : [] })));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selectedUser = users.find((u) => u.id === formUserId);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/admin/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: formUserId,
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
    setFormUserId("");
    setFormAccountId("");
    load();
  }

  async function handleToggle(r: Rule) {
    await fetch(`/api/admin/alerts/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !r.enabled }),
    });
    load();
  }

  async function handleDelete(id: string) {
    if (!confirm("Supprimer cette règle ?")) return;
    await fetch(`/api/admin/alerts/${id}`, { method: "DELETE" });
    load();
  }

  async function runScan() {
    setError(null);
    try {
      const res = await fetch("/api/cron/alerts");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 401 ? "Scan manuel non autorisé depuis le navigateur (le cron utilise CRON_SECRET) — il tourne automatiquement à 08h UTC." : (data.error ?? `Erreur ${res.status}`));
        return;
      }
      alert(`${data.scanned ?? 0} règle(s) scannée(s), ${data.triggered ?? 0} déclenchée(s).${data.skipped?.length ? `\nIgnorées : ${data.skipped.join(" · ")}` : ""}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan impossible");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Alertes"
        subtitle="Détection proactive d'anomalies (ROAS, CPA, dépenses, fréquence)."
        action={
          <div className="flex gap-2">
            <button onClick={runScan} className={secondaryBtnCls}>
              Scanner maintenant
            </button>
            <button onClick={() => setShowCreate((s) => !s)} className={primaryBtnCls}>
              + Nouvelle règle
            </button>
          </div>
        }
      />

      {showCreate && (
        <Card padded>
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className={labelSpanCls}>Client</span>
                <select
                  value={formUserId}
                  onChange={(e) => { setFormUserId(e.target.value); setFormAccountId(""); }}
                  required
                  className={inputCls}
                >
                  <option value="">— Sélectionner —</option>
                  {users.filter((u) => (u.adAccounts ?? []).length > 0).map((u) => (
                    <option key={u.id} value={u.id}>{u.email ?? u.id}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelSpanCls}>Compte (vide = tous)</span>
                <select
                  value={formAccountId}
                  onChange={(e) => setFormAccountId(e.target.value)}
                  disabled={!selectedUser}
                  className={`${inputCls} disabled:opacity-50`}
                >
                  <option value="">Tous</option>
                  {(selectedUser?.adAccounts ?? []).filter((a) => a.platform === "meta").map((a) => (
                    <option key={a.accountId} value={a.accountId}>{a.label ?? a.accountId}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelSpanCls}>Métrique</span>
                <select value={formMetric} onChange={(e) => setFormMetric(e.target.value)} className={inputCls}>
                  {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className={labelSpanCls}>Condition</span>
                <select value={formCondition} onChange={(e) => setFormCondition(e.target.value)} className={inputCls}>
                  {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className={labelSpanCls}>Seuil</span>
                <input
                  type="number"
                  step="0.1"
                  value={formThreshold}
                  onChange={(e) => setFormThreshold(parseFloat(e.target.value))}
                  required
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className={labelSpanCls}>Fenêtre</span>
                <select value={formWindow} onChange={(e) => setFormWindow(e.target.value)} className={inputCls}>
                  <option value="1d">Hier</option>
                  <option value="7d">7 derniers jours</option>
                  <option value="14d">14 derniers jours</option>
                  <option value="30d">30 derniers jours</option>
                </select>
              </label>
            </div>
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

      {error && <p className="text-sm text-red-400">{error}</p>}

      {loading ? (
        <p className="text-gray-400">Chargement…</p>
      ) : rules.length === 0 ? (
        <Card padded className="text-center text-gray-500 border-dashed space-y-2">
          <p>Aucune règle d&apos;alerte configurée — le cockpit n&apos;affichera donc aucune alerte.</p>
          <p className="text-xs">Exemple : ROAS en dessous de 1,5 sur 7 jours. Les règles ROAS sont ignorées quand le revenu est indisponible.</p>
          <button onClick={() => setShowCreate(true)} className={primaryBtnCls}>+ Créer une première règle</button>
        </Card>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => (
            <Card key={r.id} padded className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Pill className="font-mono">{METRICS.find((m) => m.value === r.metric)?.label ?? r.metric}</Pill>
                  <span className="text-sm text-gray-400">
                    {CONDITIONS.find((c) => c.value === r.condition)?.label ?? r.condition}
                  </span>
                  <span className="font-semibold text-white">
                    {r.threshold}{r.condition === "drop_pct" ? "%" : ""}
                  </span>
                  <Pill tone="violet">{r.window}</Pill>
                  <Pill tone={r.enabled ? "emerald" : "default"}>{r.enabled ? "actif" : "désactivé"}</Pill>
                </div>
                <div className="text-xs mt-1 text-gray-400">
                  {r.user?.email ?? r.userId} · {r.clientId ?? "tous comptes"} · {r._count.events} déclenchement{r._count.events > 1 ? "s" : ""}
                  {r.lastTriggeredAt && <> · dernier : {new Date(r.lastTriggeredAt).toLocaleString("fr-FR")}</>}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => handleToggle(r)} className="text-xs px-2 py-1 rounded text-gray-400 hover:text-white">
                  {r.enabled ? "Désactiver" : "Activer"}
                </button>
                <button onClick={() => handleDelete(r.id)} className="text-xs px-2 py-1 rounded text-red-400 hover:text-red-300">
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
