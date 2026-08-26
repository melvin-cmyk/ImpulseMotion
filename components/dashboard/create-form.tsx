"use client";

/**
 * Staff form on /d: create a dashboard by explicitly linking a client login
 * to an ad account (Meta and/or Google). The API grants the matching ACL rows
 * so the client sees the dashboard at their next login.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface ClientOption { id: string; email: string | null; name: string | null }
interface AccountOption { accountId: string; name: string }

const inputCls =
  "px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";

export function CreateDashboardForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [metaAccounts, setMetaAccounts] = useState<AccountOption[]>([]);
  const [googleAccounts, setGoogleAccounts] = useState<AccountOption[]>([]);
  const [userId, setUserId] = useState("");
  const [name, setName] = useState("");
  const [metaId, setMetaId] = useState("");
  const [googleId, setGoogleId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetch("/api/dashboards/clients")
      .then((r) => (r.ok ? r.json() : { clients: [] }))
      .then((j) => setClients(j.clients ?? []))
      .catch(() => {});
    // Account suggestions are best-effort (Meta needs a valid token, Google
    // walks the MCC via the relay) — free text always works.
    fetch("/api/admin/meta/accounts")
      .then((r) => (r.ok ? r.json() : { accounts: [] }))
      .then((j) => setMetaAccounts(j.accounts ?? []))
      .catch(() => {});
    fetch("/api/admin/google-ads/accounts")
      .then((r) => (r.ok ? r.json() : { accounts: [] }))
      .then((j) => setGoogleAccounts(j.accounts ?? []))
      .catch(() => {});
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!userId) { setError("Choisissez un accès client"); return; }
    if (!metaId.trim() && !googleId.trim()) { setError("Renseignez au moins un compte Meta ou Google"); return; }
    setSaving(true);
    const res = await fetch("/api/dashboards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        name: name.trim() || undefined,
        metaAccountId: metaId.trim() || undefined,
        googleCustomerId: googleId.trim() || undefined,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `Erreur ${res.status}`);
      return;
    }
    setOpen(false);
    setName(""); setMetaId(""); setGoogleId("");
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors"
      >
        + Nouveau dashboard
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="bg-gray-900 border border-violet-800/60 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Lier un dashboard à un accès client</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:text-gray-300">Annuler</button>
      </div>
      <div className="flex flex-wrap gap-3">
        <select value={userId} onChange={(e) => setUserId(e.target.value)} className={inputCls + " w-56"}>
          <option value="">Accès client…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name ?? c.email}</option>
          ))}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom (ex: Leroy Merlin)" className={inputCls + " w-52"} />
        <input
          value={metaId} onChange={(e) => setMetaId(e.target.value)}
          placeholder="Compte Meta (act_…)" list="meta-account-options" className={inputCls + " w-56"}
        />
        <datalist id="meta-account-options">
          {metaAccounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.name}</option>)}
        </datalist>
        <input
          value={googleId} onChange={(e) => setGoogleId(e.target.value)}
          placeholder="Customer Google Ads" list="google-account-options" className={inputCls + " w-56"}
        />
        <datalist id="google-account-options">
          {googleAccounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.name}</option>)}
        </datalist>
      </div>
      <p className="text-[11px] text-gray-500">
        L&apos;accès au compte est accordé automatiquement au client (ACL) — il verra ce dashboard à sa prochaine connexion.
      </p>
      {error && <div className="text-xs text-red-400">{error}</div>}
      <button
        type="submit" disabled={saving}
        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-50"
      >
        {saving ? "Création…" : "Créer le dashboard"}
      </button>
    </form>
  );
}
