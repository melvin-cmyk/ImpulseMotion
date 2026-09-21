"use client";

/**
 * Admin form on /d: create a dashboard on an ad account (Meta and/or Google)
 * and attach the people allowed in it by email — consultants and clients.
 * Unknown emails get a login; their temp passwords are shown once afterwards.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { InviteList } from "@/components/dashboard/members-manager";

interface InviteResult { email: string; role: string; created: boolean; tempPassword?: string; error?: string }
interface AccountOption { accountId: string; name: string }

const inputCls =
  "px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";

export function CreateDashboardForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [metaAccounts, setMetaAccounts] = useState<AccountOption[]>([]);
  const [googleAccounts, setGoogleAccounts] = useState<AccountOption[]>([]);
  const [consultants, setConsultants] = useState("");
  const [clients, setClients] = useState("");
  const [invites, setInvites] = useState<InviteResult[]>([]);
  const [name, setName] = useState("");
  const [metaId, setMetaId] = useState("");
  const [googleId, setGoogleId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
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
    if (!metaId.trim() && !googleId.trim()) { setError("Renseignez au moins un compte Meta ou Google"); return; }
    setSaving(true);
    const res = await fetch("/api/dashboards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        consultants,
        clients,
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
    const body = await res.json().catch(() => ({}));
    setInvites(body.invites ?? []);
    setOpen(false);
    setName(""); setMetaId(""); setGoogleId(""); setConsultants(""); setClients("");
    router.refresh();
  }

  if (!open) {
    const failed = invites.filter((i) => i.error);
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors"
        >
          + Nouveau dashboard
        </button>
        <InviteList invites={invites.flatMap((i) => (i.tempPassword ? [{ email: i.email, tempPassword: i.tempPassword }] : []))} />
        {failed.map((i) => (
          <p key={i.email} className="text-xs text-red-400">{i.email} : {i.error}</p>
        ))}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="bg-gray-900 border border-violet-800/60 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Nouveau dashboard — espace cloisonné</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:text-gray-300">Annuler</button>
      </div>
      <div className="flex flex-wrap gap-3">
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
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-[11px] text-gray-400">
          Consultants (emails, séparés par une virgule)
          <input
            value={consultants} onChange={(e) => setConsultants(e.target.value)}
            placeholder="sarah@impulse-analytics.com" className={inputCls + " w-80"}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-gray-400">
          Clients (emails, séparés par une virgule)
          <input
            value={clients} onChange={(e) => setClients(e.target.value)}
            placeholder="contact@marque.fr" className={inputCls + " w-80"}
          />
        </label>
      </div>
      <p className="text-[11px] text-gray-500">
        Seules ces personnes (et les admins) verront ce dashboard et ses données. Email inconnu → compte créé,
        mot de passe temporaire affiché une seule fois après la création.
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
