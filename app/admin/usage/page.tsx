"use client";

/**
 * Admin — Bedrock usage per client, by month, to bill by usage.
 * Only the private client bots run on Bedrock, so this is their ledger.
 * "Facturable" = messages sent by client logins; staff tests are shown apart.
 * The coefficient (margin) is a local display helper, kept in this browser.
 */

import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { PageHeader, Card, Kpi, Pill } from "@/components/ui/surface";

type Totals = { messages: number; inputTokens: number; outputTokens: number; cacheTokens: number; costUsd: number };
type ClientUsage = {
  key: string;
  clientName: string;
  clientKey: string | null;
  billable: Totals;
  staff: Totals;
  users: Array<{ email: string; role: string } & Totals>;
};

const COEF_KEY = "im:usage:coef";
const usd = (n: number) => n.toLocaleString("fr-FR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = (n: number) => n.toLocaleString("fr-FR");

// The coefficient lives in localStorage; read through an external store so the
// server render (1) and the browser value never fight during hydration.
const coefListeners = new Set<() => void>();
function subscribeCoef(cb: () => void) {
  coefListeners.add(cb);
  window.addEventListener("storage", cb);
  return () => { coefListeners.delete(cb); window.removeEventListener("storage", cb); };
}
function readCoef(): number {
  const n = Number(window.localStorage.getItem(COEF_KEY));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function AdminUsagePage() {
  const [month, setMonth] = useState(currentMonth);
  const [clients, setClients] = useState<ClientUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const coef = useSyncExternalStore(subscribeCoef, readCoef, () => 1);
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/admin/usage?month=${month}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
        setClients(data.clients ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Erreur"))
      .finally(() => setLoading(false));
  }, [month]);

  const total = useMemo(
    () =>
      clients.reduce(
        (t, c) => ({
          messages: t.messages + c.billable.messages,
          cost: t.cost + c.billable.costUsd,
          staffCost: t.staffCost + c.staff.costUsd,
        }),
        { messages: 0, cost: 0, staffCost: 0 },
      ),
    [clients],
  );

  function updateCoef(v: string) {
    const n = Number(v.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) return;
    window.localStorage.setItem(COEF_KEY, String(n));
    coefListeners.forEach((cb) => cb());
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Consommation IA"
        subtitle="Ce qui tourne sur Amazon Bedrock — les bots privés des clients — par client et par mois, pour facturer à l'usage."
        action={
          <div className="flex items-center gap-2">
            <input
              type="month" value={month} max={currentMonth()} onChange={(e) => {
                if (!e.target.value) return;
                setLoading(true);
                setError(null);
                setMonth(e.target.value);
              }}
              className="px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none"
            />
            <a
              href={`/api/admin/usage?month=${month}&format=csv`}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors"
            >
              Export CSV
            </a>
          </div>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Kpi label="Messages facturables" value={int(total.messages)} sub="envoyés par des comptes clients" />
        <Kpi label="Coût Bedrock facturable" value={usd(total.cost)} sub={`tests staff à part : ${usd(total.staffCost)}`} accent="emerald" />
        <Kpi label="À facturer" value={usd(total.cost * coef)} sub={`coût × ${coef.toLocaleString("fr-FR")}`} accent="amber" />
      </div>

      <Card padded>
        <label className="flex items-center gap-3 text-sm text-gray-300 flex-wrap">
          Coefficient de refacturation
          <input
            type="number" min="0.1" step="0.1" defaultValue={coef} key={coef} onBlur={(e) => updateCoef(e.target.value)}
            className="w-24 px-3 py-1.5 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none"
          />
          <span className="text-xs text-gray-500">
            Coût au prix catalogue du modèle (USD). La facture AWS reste la référence. Réglage conservé dans ce navigateur.
          </span>
        </label>
      </Card>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading && <p className="text-sm text-gray-500">Chargement…</p>}
      {!loading && !error && clients.length === 0 && (
        <Card padded>
          <p className="text-sm text-gray-400">Aucune consommation Bedrock ce mois-ci.</p>
          <p className="text-xs text-gray-500 mt-1">Le suivi démarre à la première réponse d&apos;un bot client.</p>
        </Card>
      )}

      {clients.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-800">
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium text-right">Messages</th>
                <th className="px-4 py-3 font-medium text-right">Tokens entrée</th>
                <th className="px-4 py-3 font-medium text-right">Tokens sortie</th>
                <th className="px-4 py-3 font-medium text-right">Tokens cache</th>
                <th className="px-4 py-3 font-medium text-right">Coût</th>
                <th className="px-4 py-3 font-medium text-right">À facturer</th>
                <th className="px-4 py-3 font-medium text-right">Tests staff</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <Fragment key={c.key}>
                  <tr
                    onClick={() => setOpenKey(openKey === c.key ? null : c.key)}
                    className="border-b border-gray-800/60 hover:bg-gray-800/40 cursor-pointer"
                  >
                    <td className="px-4 py-3 text-white font-medium">
                      {c.clientName}
                      {c.clientKey && <span className="ml-2 text-xs text-gray-500">{c.clientKey}</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-300">{int(c.billable.messages)}</td>
                    <td className="px-4 py-3 text-right text-gray-300">{int(c.billable.inputTokens)}</td>
                    <td className="px-4 py-3 text-right text-gray-300">{int(c.billable.outputTokens)}</td>
                    <td className="px-4 py-3 text-right text-gray-300">{int(c.billable.cacheTokens)}</td>
                    <td className="px-4 py-3 text-right text-gray-300">{usd(c.billable.costUsd)}</td>
                    <td className="px-4 py-3 text-right text-amber-300 font-semibold">{usd(c.billable.costUsd * coef)}</td>
                    <td className="px-4 py-3 text-right text-gray-500">{usd(c.staff.costUsd)}</td>
                  </tr>
                  {openKey === c.key &&
                    c.users.map((u) => (
                      <tr key={`${c.key}:${u.email}`} className="border-b border-gray-800/40 bg-gray-950/60 text-xs">
                        <td className="px-4 py-2 pl-8 text-gray-400">
                          {u.email} <Pill tone={u.role === "client" ? "blue" : "default"} className="ml-1">{u.role === "client" ? "client" : `${u.role} · non facturé`}</Pill>
                        </td>
                        <td className="px-4 py-2 text-right text-gray-400">{int(u.messages)}</td>
                        <td className="px-4 py-2 text-right text-gray-400">{int(u.inputTokens)}</td>
                        <td className="px-4 py-2 text-right text-gray-400">{int(u.outputTokens)}</td>
                        <td className="px-4 py-2 text-right text-gray-400">{int(u.cacheTokens)}</td>
                        <td className="px-4 py-2 text-right text-gray-400">{usd(u.costUsd)}</td>
                        <td className="px-4 py-2" colSpan={2} />
                      </tr>
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
