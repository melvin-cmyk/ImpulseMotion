"use client";

/**
 * Form on /d: create the dashboard of a client. The client is picked in the
 * list of the agency's clients that have none yet — its accounts come with
 * it. Opening the dashboard to the client's own people (by email) is kept to
 * the admins; unknown emails get a login, shown once afterwards.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { InviteList } from "@/components/dashboard/members-manager";

interface InviteResult { email: string; role: string; created: boolean; tempPassword?: string; error?: string }
interface AvailableClient { id: string; name: string; metaAccountId: string | null; googleCustomerId: string | null; tiktokAdvertiserId?: string }

const inputCls =
  "px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";

export function CreateDashboardForm() {
  const router = useRouter();
  const canInviteClients = useSession().data?.baseRole === "admin";
  const [open, setOpen] = useState(false);
  const [available, setAvailable] = useState<AvailableClient[] | null>(null);
  const [picked, setPicked] = useState("");
  const [manual, setManual] = useState(false);
  const [clients, setClients] = useState("");
  const [invites, setInvites] = useState<InviteResult[]>([]);
  const [name, setName] = useState("");
  const [metaId, setMetaId] = useState("");
  const [googleId, setGoogleId] = useState("");
  const [tiktokId, setTikTokId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetch("/api/clients/available")
      .then((r) => (r.ok ? r.json() : { clients: [] }))
      .then((j) => setAvailable(j.clients ?? []))
      .catch(() => setAvailable([]));
  }, [open]);

  function pick(id: string) {
    setPicked(id);
    const c = available?.find((x) => x.id === id);
    setName(c?.name ?? "");
    setMetaId(c?.metaAccountId ?? "");
    setGoogleId(c?.googleCustomerId ?? "");
    setTikTokId(c?.tiktokAdvertiserId ?? "");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!metaId.trim() && !googleId.trim() && !tiktokId.trim()) { setError(manual ? "Renseignez au moins un compte Meta, Google ou TikTok Ads" : "Choisissez un client"); return; }
    setSaving(true);
    const res = await fetch("/api/dashboards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clients: canInviteClients ? clients : undefined,
        name: name.trim() || undefined,
        metaAccountId: metaId.trim() || undefined,
        googleCustomerId: googleId.trim() || undefined,
        tiktokAdvertiserId: tiktokId.trim() || undefined,
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
    setName(""); setMetaId(""); setGoogleId(""); setTikTokId(""); setClients(""); setPicked(""); setManual(false);
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

  const chosen = available?.find((c) => c.id === picked) ?? null;

  return (
    <form onSubmit={submit} className="bg-gray-900 border border-violet-800/60 rounded-xl p-4 space-y-3 w-full max-w-2xl">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Nouveau dashboard</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:text-gray-300">Annuler</button>
      </div>

      {!manual ? (
        <div className="space-y-2">
          <label className="flex flex-col gap-1 text-[11px] text-gray-400">
            Client
            <select value={picked} onChange={(e) => pick(e.target.value)} className={inputCls} disabled={available === null}>
              <option value="">{available === null ? "Chargement des clients…" : available.length ? "Choisir un client" : "Tous les clients ont déjà un dashboard"}</option>
              {(available ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({[c.metaAccountId && "Meta", c.googleCustomerId && "Google", c.tiktokAdvertiserId && "TikTok"].filter(Boolean).join(" + ")})
                </option>
              ))}
            </select>
          </label>
          {chosen && (
            <label className="flex flex-col gap-1 text-[11px] text-gray-400">
              Nom du dashboard
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
            </label>
          )}
          <button type="button" onClick={() => { setManual(true); setPicked(""); }} className="text-[11px] text-gray-500 underline hover:text-gray-300">
            Le client n&apos;est pas dans la liste : saisir les comptes à la main
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom (ex: Leroy Merlin)" className={inputCls + " w-52"} />
            <input value={metaId} onChange={(e) => setMetaId(e.target.value)} placeholder="Compte Meta (act_…)" className={inputCls + " w-56"} />
            <input value={googleId} onChange={(e) => setGoogleId(e.target.value)} placeholder="Customer Google Ads" className={inputCls + " w-56"} />
            <input value={tiktokId} onChange={(e) => setTikTokId(e.target.value)} inputMode="numeric" placeholder="Compte TikTok Ads (identifiant)" className={inputCls + " w-56 font-mono"} />
          </div>
          <p className="text-[11px] text-gray-500">Le compte TikTok Ads est retrouvé chez TikTok à la création ; d&apos;autres comptes TikTok se rattachent ensuite depuis la fiche client (Sources de données).</p>
          <button type="button" onClick={() => { setManual(false); setName(""); setMetaId(""); setGoogleId(""); setTikTokId(""); }} className="text-[11px] text-gray-500 underline hover:text-gray-300">
            Revenir à la liste des clients
          </button>
        </div>
      )}

      {canInviteClients && (
        <label className="flex flex-col gap-1 text-[11px] text-gray-400">
          Ouvrir au client (emails, séparés par une virgule) — facultatif
          <input
            value={clients} onChange={(e) => setClients(e.target.value)}
            placeholder="contact@marque.fr" className={inputCls}
          />
          <span className="text-gray-500">Email inconnu → compte créé, mot de passe temporaire affiché une seule fois après la création.</span>
        </label>
      )}
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
