"use client";

/**
 * Global Cockpit — admin panel: for each client of the budget sheet, its
 * model (CPA / ROAS / branding) and the ad accounts attached to it. Accounts
 * are first matched by name; what an admin sets here is never overwritten.
 * Changes show at the next build (« Actualiser »).
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";

interface ConfigAccount { platform: string; accountId: string; name: string; currency: string | null; label: string | null; mode: string | null; source: string; enabled: boolean }
interface ConfigClient {
  key: string; name: string; sheetName: string; sheetNames: string[]; team: string | null; currency: string | null;
  budget: { meta: number | null; google: number | null }; targetRoas: number | null; targetCpl: number | null;
  otherPlatforms: string[]; kpiMode: string | null; defaultMode: string | null; hidden: boolean; accounts: ConfigAccount[];
}
interface FreeAccount { platform: "meta" | "google"; accountId: string; name: string; currency: string | null }
interface Config { month: string; clients: ConfigClient[]; free: FreeAccount[]; warnings: string[] }

const select = "rounded-lg border border-gray-800 bg-gray-950 px-2 py-1 text-xs text-gray-200 focus:border-violet-500 focus:outline-none";
const amount = (v: number | null, ccy: string | null) => (v === null ? "—" : `${Math.round(v).toLocaleString("fr-FR")} ${ccy ?? ""}`.trim());

export function CockpitConfig({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/cockpit/global/config", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Erreur ${res.status}`);
      setConfig(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch("/api/cockpit/global/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Erreur ${res.status}`);
      setChanged(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const q = filter.trim().toLowerCase();
  const clients = (config?.clients ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.sheetNames.some((n) => n.toLowerCase().includes(q)));

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-modal="true" aria-labelledby="cockpit-config-title" className="fixed inset-y-0 right-0 z-50 flex w-full max-w-3xl flex-col border-l border-gray-800 bg-gray-950 shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-gray-800 px-5 py-4">
          <div>
            <h2 id="cockpit-config-title" className="text-lg font-semibold text-white">Clients et comptes</h2>
            <p className="text-xs text-gray-400">Les clients viennent de la feuille des budgets{config ? ` (${config.month})` : ""}. Rattachez à chacun ses comptes Meta et Google Ads et choisissez son modèle.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white"><X className="h-4 w-4" /></button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {error && <p className="rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-200">{error}</p>}
          {changed && <p className="rounded-lg border border-violet-900/50 bg-violet-950/30 px-3 py-2 text-xs text-violet-200">Modifications enregistrées. Cliquez sur « Actualiser » dans le cockpit pour les voir dans les chiffres.</p>}
          {config?.warnings.map((w) => <p key={w} className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">{w}</p>)}
          {!config && !error && <p className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /> Lecture de la feuille et des comptes…</p>}

          {config && (
            <>
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrer les clients" aria-label="Filtrer les clients" className={`${select} w-full py-1.5`} />
              {clients.map((c) => (
                <section key={c.key} className={`rounded-xl border border-gray-800 bg-gray-900/60 p-3 ${c.hidden ? "opacity-60" : ""}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-white">{c.name}</h3>
                      <p className="text-[11px] text-gray-500">
                        Feuille : {c.sheetNames.join(", ")}{c.team ? ` · ${c.team}` : ""} · budget Meta {amount(c.budget.meta, c.currency)} · Google {amount(c.budget.google, c.currency)}
                        {c.targetRoas ? ` · objectif ROAS ${c.targetRoas}` : ""}{c.targetCpl ? ` · objectif CPL ${c.targetCpl}` : ""}
                        {c.otherPlatforms.length ? ` · non suivis ici : ${c.otherPlatforms.join(", ")}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <select value={c.kpiMode ?? ""} disabled={busy} onChange={(e) => save({ client: { key: c.key, kpiMode: e.target.value || null } })} className={select} aria-label={`Modèle de ${c.name}`}>
                        <option value="">Modèle : automatique{c.defaultMode ? ` (${c.defaultMode.toUpperCase()})` : ""}</option>
                        <option value="cpa">CPA</option><option value="roas">ROAS</option><option value="brand">Branding</option>
                      </select>
                      <label className="flex items-center gap-1 text-[11px] text-gray-400">
                        <input type="checkbox" checked={c.hidden} disabled={busy} onChange={(e) => save({ client: { key: c.key, hidden: e.target.checked } })} /> masquer
                      </label>
                    </div>
                  </div>

                  <ul className="mt-2 space-y-1">
                    {c.accounts.map((a) => (
                      <li key={`${a.platform}:${a.accountId}`} className={`flex flex-wrap items-center gap-2 rounded-lg border border-gray-800 px-2 py-1.5 text-xs ${a.enabled ? "text-gray-200" : "text-gray-500"}`}>
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${a.platform === "meta" ? "bg-blue-500/20 text-blue-300" : "bg-emerald-500/20 text-emerald-300"}`}>{a.platform === "meta" ? "Meta" : "Google"}</span>
                        <span className="min-w-0 flex-1 truncate">{a.name} <span className="text-gray-600">· {a.accountId}{a.currency ? ` · ${a.currency}` : ""} · {a.source === "manual" ? "réglé à la main" : "rapproché par nom"}</span></span>
                        <select value={a.mode ?? ""} disabled={busy} onChange={(e) => save({ account: { platform: a.platform, accountId: a.accountId, mode: e.target.value || null } })} className={select} aria-label={`Modèle du compte ${a.name}`}>
                          <option value="">modèle du client</option><option value="cpa">CPA</option><option value="roas">ROAS</option><option value="brand">Branding</option>
                        </select>
                        <button type="button" disabled={busy} onClick={() => save({ account: { platform: a.platform, accountId: a.accountId, enabled: !a.enabled } })} className="rounded border border-gray-800 px-2 py-1 text-[11px] text-gray-300 hover:border-gray-700">
                          {a.enabled ? "Retirer" : "Réactiver"}
                        </button>
                      </li>
                    ))}
                    {!c.accounts.length && <li className="text-xs text-amber-300">Aucun compte rattaché.</li>}
                  </ul>

                  <select value="" disabled={busy || !config.free.length} onChange={(e) => {
                    const [platform, accountId] = e.target.value.split(":");
                    if (platform && accountId) void save({ account: { platform, accountId, clientKey: c.key } });
                  }} className={`${select} mt-2 w-full`} aria-label={`Rattacher un compte à ${c.name}`}>
                    <option value="">+ Rattacher un compte disponible…</option>
                    {config.free.map((f) => <option key={`${f.platform}:${f.accountId}`} value={`${f.platform}:${f.accountId}`}>{f.platform === "meta" ? "Meta" : "Google"} · {f.name} ({f.accountId}{f.currency ? `, ${f.currency}` : ""})</option>)}
                  </select>
                </section>
              ))}
              <p className="text-[11px] text-gray-500">
                {config.free.length} compte(s) accessibles à l&apos;agence ne sont rattachés à aucun client. Un compte absent de la liste n&apos;est pas partagé avec l&apos;agence : demandez l&apos;accès côté Meta Business ou Google Ads.
              </p>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
