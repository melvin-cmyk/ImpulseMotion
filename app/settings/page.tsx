"use client";

/**
 * Réglages — real account info (from the session), password change, and the
 * live status of the data integrations (Meta System User token, Google Ads via
 * the MCP relay). No mock data, no OAuth buttons for providers that don't exist.
 */

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Check, Loader2, AlertCircle, KeyRound, Plug } from "lucide-react";
import { Card, PageHeader, Pill, Section } from "@/components/ui/surface";

type IntegrationStatus = { state: "loading" | "ok" | "error"; detail: string };

function useIntegration(url: string, count: (json: unknown) => number, label: (n: number) => string): IntegrationStatus {
  const [status, setStatus] = useState<IntegrationStatus>({ state: "loading", detail: "Vérification…" });
  useEffect(() => {
    fetch(url)
      .then(async (r) => {
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((json as { error?: string }).error ?? `Erreur ${r.status}`);
        const n = count(json);
        setStatus(n > 0 ? { state: "ok", detail: label(n) } : { state: "error", detail: "Aucun compte accessible" });
      })
      .catch((e) => setStatus({ state: "error", detail: e instanceof Error ? e.message : "Indisponible" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return status;
}

function IntegrationRow({ name, description, status, initial, color }: { name: string; description: string; status: IntegrationStatus; initial: string; color: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold text-sm shrink-0 ${color}`}>{initial}</div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">{name}</div>
          <div className="text-xs text-gray-500 truncate">{description}</div>
        </div>
      </div>
      <div className="shrink-0 inline-flex items-center gap-2 text-xs">
        {status.state === "loading" && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-500" />}
        {status.state === "ok" && <Check className="w-3.5 h-3.5 text-emerald-400" />}
        {status.state === "error" && <AlertCircle className="w-3.5 h-3.5 text-amber-400" />}
        <span className={status.state === "ok" ? "text-emerald-300" : status.state === "error" ? "text-amber-300" : "text-gray-500"}>{status.detail}</span>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { data: session } = useSession();
  const isStaff = session?.role === "admin" || session?.role === "consultant";

  const meta = useIntegration(
    "/api/meta/accounts",
    (j) => (Array.isArray(j) ? j.length : Array.isArray((j as { accounts?: unknown[] }).accounts) ? (j as { accounts: unknown[] }).accounts.length : 0),
    (n) => `Token System User actif · ${n} compte${n > 1 ? "s" : ""}`,
  );
  const google = useIntegration(
    isStaff ? "/api/admin/google-ads/accounts" : "/api/me/accounts",
    (j) => (Array.isArray((j as { accounts?: unknown[] }).accounts) ? (j as { accounts: Array<{ platform?: string }> }).accounts.filter((a) => !a.platform || a.platform === "google").length : 0),
    (n) => `Relay MCP joignable · ${n} compte${n > 1 ? "s" : ""}`,
  );

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwState, setPwState] = useState<{ busy: boolean; msg: string | null; ok: boolean }>({ busy: false, msg: null, ok: false });

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) { setPwState({ busy: false, msg: "Les deux nouveaux mots de passe diffèrent.", ok: false }); return; }
    setPwState({ busy: true, msg: null, ok: false });
    const res = await fetch("/api/me/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current, next }) });
    const j = await res.json().catch(() => ({}));
    if (res.ok) { setPwState({ busy: false, msg: "Mot de passe mis à jour.", ok: true }); setCurrent(""); setNext(""); setConfirm(""); }
    else setPwState({ busy: false, msg: j.error ?? `Erreur ${res.status}`, ok: false });
  }

  const inputCls = "w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500";

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <PageHeader title="Réglages" subtitle="Votre compte et l'état des connexions aux plateformes publicitaires." />

      <Section title={<span className="flex items-center gap-2"><Plug className="w-4 h-4 text-violet-400" /> Intégrations</span>}>
        <div className="divide-y divide-gray-800">
          <IntegrationRow name="Meta Ads" description="Token System User partagé (Business Manager Impulse) — accès par compte géré dans Utilisateurs & accès." status={meta} initial="f" color="bg-blue-600" />
          <IntegrationRow name="Google Ads" description="Accès via le relay MCP (mcp-google-ads) — aucune OAuth côté utilisateur." status={google} initial="G" color="bg-emerald-600" />
        </div>
        <div className="px-4 py-3 text-xs text-gray-500 border-t border-gray-800">
          L&apos;IA (rapports, chat, analyse créas) passe par le relay Impulse (Claude). Aucune clé API n&apos;est stockée dans l&apos;application.
        </div>
      </Section>

      <Card padded>
        <h2 className="text-sm font-semibold text-white mb-3">Compte</h2>
        <dl className="grid grid-cols-3 gap-y-2 text-sm">
          <dt className="text-gray-500">Nom</dt><dd className="col-span-2 text-white">{session?.user?.name ?? "—"}</dd>
          <dt className="text-gray-500">Email</dt><dd className="col-span-2 text-white">{session?.user?.email ?? "—"}</dd>
          <dt className="text-gray-500">Rôle</dt><dd className="col-span-2"><Pill tone="violet">{session?.role ?? "client"}</Pill></dd>
        </dl>
      </Card>

      <Card padded>
        <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2"><KeyRound className="w-4 h-4 text-violet-400" /> Changer le mot de passe</h2>
        <form onSubmit={changePassword} className="space-y-3 max-w-sm">
          <input type="password" autoComplete="current-password" placeholder="Mot de passe actuel" value={current} onChange={(e) => setCurrent(e.target.value)} className={inputCls} required />
          <input type="password" autoComplete="new-password" placeholder="Nouveau mot de passe (10 caractères min.)" value={next} onChange={(e) => setNext(e.target.value)} className={inputCls} required minLength={10} />
          <input type="password" autoComplete="new-password" placeholder="Confirmer le nouveau mot de passe" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputCls} required />
          {pwState.msg && <div className={`text-xs ${pwState.ok ? "text-emerald-400" : "text-red-400"}`}>{pwState.msg}</div>}
          <button type="submit" disabled={pwState.busy} className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-semibold">
            {pwState.busy ? "Mise à jour…" : "Mettre à jour"}
          </button>
        </form>
      </Card>
    </div>
  );
}
