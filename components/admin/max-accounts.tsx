"use client";

/**
 * Admin panel: the relay's pool of Claude Max subscriptions. Shows each
 * account's utilisation, adds one from a `claude setup-token` token, removes
 * one. Tokens are only ever sent, never displayed.
 */

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/surface";

interface PoolAccount {
  id: string; label: string; level: number | null;
  fiveHour: { utilization: number; resetsAt: string | null } | null;
  sevenDay: { utilization: number; resetsAt: string | null } | null;
  fallbackActive: boolean; exhaustedUntil: string | null; checkedAt: string | null; error: string | null;
}

function pctOf(w: PoolAccount["fiveHour"]) { return Math.max(0, Math.min(100, Math.round(w?.utilization ?? 0))); }

export function MaxAccountsPanel({ warnPct, switchPct }: { warnPct: number; switchPct: number }) {
  const [accounts, setAccounts] = useState<PoolAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/admin/accounts");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Erreur ${res.status}`);
      setAccounts(Array.isArray(json.accounts) ? json.accounts : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => { void load(); }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || !token.trim() || busy) return;
    setBusy(true); setNotice(null); setError(null);
    try {
      const res = await fetch("/api/admin/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: label.trim(), token: token.trim() }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Erreur ${res.status}`);
      setAccounts(json.accounts ?? []);
      setNotice(`Compte « ${json.account?.label} » ajouté (${Math.round(json.account?.level ?? 0)} % utilisé).`);
      setLabel(""); setToken("");
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, name: string) {
    if (busy) return;
    setBusy(true); setNotice(null); setError(null);
    try {
      const res = await fetch("/api/admin/accounts", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Erreur ${res.status}`);
      setAccounts(json.accounts ?? []);
      setNotice(`Compte « ${name} » retiré.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold text-white">Pool de comptes Claude Max</h2>
      <p className="text-xs text-gray-500">
        Les chats staff partent sur le compte choisi par le consultant tant qu&apos;il a de la marge, sinon sur le compte le moins utilisé, et sur Amazon Bedrock quand tous sont saturés.
        Pour ajouter un compte : sur un Mac connecté à cet abonnement, lancer <code className="text-gray-300">claude setup-token</code> et coller le jeton ci-dessous. Il est vérifié auprès d&apos;Anthropic puis stocké chiffré sur le serveur du relay, jamais réaffiché.
      </p>
      {error && <Card padded><p className="text-sm text-red-400">{error}</p></Card>}
      {notice && <Card padded><p className="text-sm text-emerald-300">{notice}</p></Card>}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {accounts.map((a) => {
          const p5 = pctOf(a.fiveHour); const p7 = pctOf(a.sevenDay);
          const tone = (p: number) => (p >= switchPct ? "bg-red-500" : p >= warnPct ? "bg-amber-400" : "bg-emerald-500");
          return (
            <Card key={a.id} padded>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-white">{a.label}</div>
                  <div className={`text-[11px] mt-0.5 ${a.fallbackActive ? "text-amber-300" : "text-emerald-300"}`}>{a.fallbackActive ? "saturé — hors rotation" : "disponible"}</div>
                </div>
                {a.id !== "host" && (
                  <button type="button" onClick={() => remove(a.id, a.label)} disabled={busy} className="text-[11px] text-gray-500 hover:text-red-400 disabled:opacity-50">Retirer</button>
                )}
              </div>
              <div className="mt-3 space-y-2">
                <div>
                  <div className="flex justify-between text-[11px] text-gray-500"><span>5 heures</span><span className="tabular-nums text-gray-300">{p5} %</span></div>
                  <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden mt-1"><div className={`h-full ${tone(p5)}`} style={{ width: `${p5}%` }} /></div>
                </div>
                <div>
                  <div className="flex justify-between text-[11px] text-gray-500"><span>7 jours</span><span className="tabular-nums text-gray-300">{p7} %</span></div>
                  <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden mt-1"><div className={`h-full ${tone(p7)}`} style={{ width: `${p7}%` }} /></div>
                </div>
              </div>
              <div className="text-[11px] text-gray-600 mt-2">
                {a.error ? `erreur : ${a.error}` : a.checkedAt ? `vérifié à ${new Date(a.checkedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : "pas encore vérifié"}
              </div>
            </Card>
          );
        })}
      </div>
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Libellé
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Max Sung-Min" maxLength={60} className="px-3 py-2 rounded-lg text-sm bg-gray-900 border border-gray-800 text-white focus:border-violet-500 focus:outline-none w-48" />
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1 flex-1 min-w-[260px]">
          Jeton claude setup-token
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="sk-ant-oat01-…" type="password" autoComplete="off" className="px-3 py-2 rounded-lg text-sm bg-gray-900 border border-gray-800 text-white focus:border-violet-500 focus:outline-none font-mono" />
        </label>
        <button type="submit" disabled={busy || !label.trim() || !token.trim()} className="px-3 py-2 rounded-lg text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50">
          {busy ? "Vérification…" : "Ajouter le compte"}
        </button>
      </form>
    </section>
  );
}
