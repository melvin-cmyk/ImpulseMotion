"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, TrendingUp, TrendingDown, ArrowRight } from "lucide-react";

type PortfolioClient = {
  userId: string;
  email: string | null;
  name: string | null;
  totalSpend: number;
  avgRoas: number;
  alertCount: number;
  accounts: Array<{
    accountId: string;
    label: string | null;
    platform: string;
    spend: number;
    roas: number;
    ctr: number;
    frequency: number;
    fetchOk: boolean;
  }>;
};

type AlertEvent = {
  id: string;
  clientId: string;
  metric: string;
  value: number;
  threshold: number;
  message: string;
  triggeredAt: string;
  acknowledged: boolean;
  userId: string;
};

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}

export default function PortfolioPage() {
  const [data, setData] = useState<{ clients: PortfolioClient[]; summary: { clientCount: number; totalSpend: number; openAlerts: number; range: { since: string; until: string } } } | null>(null);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/portfolio").then((r) => {
        if (r.status === 403) throw new Error("Réservé aux admins");
        if (!r.ok) throw new Error("Erreur de chargement");
        return r.json();
      }),
      fetch("/api/alerts/events?acknowledged=false").then((r) => r.json()),
    ])
      .then(([p, e]) => {
        setData(p);
        setEvents(e.events ?? []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function ackEvent(id: string) {
    await fetch("/api/alerts/events", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, acknowledged: true }),
    });
    setEvents((evs) => evs.filter((e) => e.id !== id));
  }

  if (loading) return <div className="p-6 text-gray-400">Chargement du portfolio…</div>;
  if (error) return <div className="p-6 text-red-400">{error}</div>;
  if (!data) return null;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Portfolio</h1>
        <p className="text-sm text-gray-400 mt-1">
          Vue d'ensemble sur les {data.summary.clientCount} client(s) — dépenses 30 derniers jours ({data.summary.range.since} → {data.summary.range.until}).
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Clients actifs</p>
          <p className="text-2xl font-bold text-white mt-1">{data.summary.clientCount}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Dépenses totales 30j</p>
          <p className="text-2xl font-bold text-white mt-1">{fmtMoney(data.summary.totalSpend)}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
          <div className="flex items-center gap-2">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Alertes ouvertes</p>
            {data.summary.openAlerts > 0 && <AlertCircle className="w-4 h-4 text-amber-400" />}
          </div>
          <p className={`text-2xl font-bold mt-1 ${data.summary.openAlerts > 0 ? "text-amber-400" : "text-white"}`}>
            {data.summary.openAlerts}
          </p>
        </div>
      </div>

      {/* Recent alerts */}
      {events.length > 0 && (
        <div className="bg-gray-900 border border-amber-900/40 rounded-2xl p-4">
          <h2 className="text-sm font-semibold text-amber-300 mb-3 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> Alertes récentes
          </h2>
          <div className="space-y-2">
            {events.slice(0, 8).map((ev) => (
              <div key={ev.id} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                <div>
                  <p className="text-sm text-white">{ev.message}</p>
                  <p className="text-xs text-gray-500">{ev.clientId} · {new Date(ev.triggeredAt).toLocaleString("fr-FR")}</p>
                </div>
                <button onClick={() => ackEvent(ev.id)} className="text-xs text-gray-400 hover:text-white">
                  Acquitter
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Clients table */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-950/50 border-b border-gray-800">
            <tr>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide">Client</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide">Comptes</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide">Dépenses 30j</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide">ROAS moyen</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide">Alertes</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wide"></th>
            </tr>
          </thead>
          <tbody>
            {data.clients.map((c) => (
              <tr key={c.userId} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/30">
                <td className="px-4 py-3">
                  <div className="font-medium text-white">{c.name ?? c.email ?? c.userId}</div>
                  {c.name && <div className="text-xs text-gray-500">{c.email}</div>}
                </td>
                <td className="text-right px-4 py-3 text-gray-300">{c.accounts.length}</td>
                <td className="text-right px-4 py-3 font-semibold text-white">{fmtMoney(c.totalSpend)}</td>
                <td className="text-right px-4 py-3">
                  {c.avgRoas > 0 ? (
                    <span className={`inline-flex items-center gap-1 ${c.avgRoas >= 2 ? "text-emerald-400" : "text-amber-400"}`}>
                      {c.avgRoas >= 2 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {c.avgRoas.toFixed(2)}x
                    </span>
                  ) : (
                    <span className="text-gray-600">—</span>
                  )}
                </td>
                <td className="text-right px-4 py-3">
                  {c.alertCount > 0 ? (
                    <span className="inline-flex items-center gap-1 text-amber-400">
                      <AlertCircle className="w-3 h-3" />
                      {c.alertCount}
                    </span>
                  ) : (
                    <span className="text-gray-600">—</span>
                  )}
                </td>
                <td className="text-right px-4 py-3">
                  <Link
                    href={`/deck?userId=${c.userId}`}
                    className="inline-flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300"
                  >
                    Deck <ArrowRight className="w-3 h-3" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Per-client accounts detail */}
      <div className="space-y-3">
        {data.clients.filter((c) => c.accounts.length > 0).map((c) => (
          <details key={c.userId} className="bg-gray-900 border border-gray-800 rounded-2xl">
            <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-white hover:bg-gray-800/40">
              {c.name ?? c.email} · {c.accounts.length} compte{c.accounts.length > 1 ? "s" : ""}
            </summary>
            <table className="w-full text-sm">
              <thead className="bg-gray-950/30">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Compte</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Spend</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">ROAS</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">CTR</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Fréq.</th>
                </tr>
              </thead>
              <tbody>
                {c.accounts.map((a) => (
                  <tr key={a.accountId} className="border-t border-gray-800">
                    <td className="px-4 py-2">
                      <span className={a.fetchOk ? "text-gray-300" : "text-gray-600 italic"}>
                        {a.label ?? a.accountId}
                      </span>
                      {!a.fetchOk && <span className="text-xs text-amber-500 ml-2">(hors BM)</span>}
                    </td>
                    <td className="text-right px-4 py-2 text-gray-300">{fmtMoney(a.spend)}</td>
                    <td className="text-right px-4 py-2 text-gray-300">{a.roas > 0 ? `${a.roas.toFixed(2)}x` : "—"}</td>
                    <td className="text-right px-4 py-2 text-gray-300">{a.ctr > 0 ? `${a.ctr.toFixed(2)}%` : "—"}</td>
                    <td className="text-right px-4 py-2 text-gray-300">{a.frequency > 0 ? a.frequency.toFixed(2) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))}
      </div>
    </div>
  );
}
