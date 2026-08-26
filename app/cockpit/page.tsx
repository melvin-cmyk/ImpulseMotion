"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  TrendingUp,
  TrendingDown,
  ArrowRight,
  FileText,
  Activity,
  Users,
  DollarSign,
  GitCompareArrows,
  Sparkles,
  Loader2,
  Target,
  AlertTriangle,
} from "lucide-react";
import { Section, Kpi, PageHeader, Pill } from "@/components/ui/surface";

type Account = {
  accountId: string;
  label: string | null;
  platform: string;
  spend: number;
  roas: number;
  ctr: number;
  frequency: number;
  fetchOk: boolean;
};

type Client = {
  userId: string;
  email: string | null;
  name: string | null;
  accounts: Account[];
  totalSpend: number;
  avgRoas: number;
  alertCount: number;
};

type AlertEvent = {
  id: string;
  clientId: string;
  metric: string;
  value: number;
  threshold: number;
  message: string;
  triggeredAt: string;
  userId: string;
  recommendations?: string | null;
  rule?: { metric: string; condition: string; threshold: number; window: string };
};

type Report = {
  id: string;
  clientId: string;
  clientName: string;
  platform: string;
  period: string;
  startDate: string;
  endDate: string;
  createdAt: string;
};

type UrgentAccount = Account & { clientUserId: string; clientLabel: string | null };

type Pacing = {
  accountId: string;
  monthlyTarget: number;
  currency: string;
  mtdSpend: number;
  daysElapsed: number;
  daysInMonth: number;
  daysRemaining: number;
  dailyRunRate: number;
  projectedSpend: number;
  pacingPct: number;
  status: "on_track" | "under" | "over" | "critical_under" | "critical_over";
};

type PacingItem = {
  id: string;
  accountId: string;
  monthlyTarget: number;
  currency: string;
  pacing: Pacing | null;
};

type CockpitData = {
  summary: {
    clientCount: number;
    accountCount: number;
    totalSpend: number;
    openAlerts: number;
    urgentAccountCount: number;
    range: { since: string; until: string };
    isAdmin: boolean;
  };
  clients: Client[];
  alerts: AlertEvent[];
  recentReports: Report[];
  urgentAccounts: UrgentAccount[];
  pacing: PacingItem[];
};

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `il y a ${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `il y a ${hours}h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days}j`;
}

type ChangeEvent = {
  kind: string;
  severity: "info" | "warning" | "critical" | "positive";
  accountId: string;
  accountLabel?: string | null;
  metric?: string;
  before?: number;
  after?: number;
  deltaPct?: number;
  title: string;
  detail: string;
};

export default function CockpitPage() {
  const [data, setData] = useState<CockpitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<ChangeEvent[] | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [recommendingId, setRecommendingId] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<Record<string, string>>({});

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/cockpit");
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      const json = await res.json();
      setData(json);
      // Hydrate any cached recommendations
      const cached: Record<string, string> = {};
      for (const ev of json.alerts ?? []) {
        if (ev.recommendations) cached[ev.id] = ev.recommendations;
      }
      setRecommendations(cached);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function loadChanges() {
    setChangesLoading(true);
    try {
      const res = await fetch("/api/changes");
      const json = await res.json();
      setChanges(json.events ?? []);
    } catch {
      setChanges([]);
    } finally {
      setChangesLoading(false);
    }
  }

  async function ackEvent(id: string) {
    await fetch("/api/alerts/events", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, acknowledged: true }),
    });
    load();
  }

  async function generatePlan(eventId: string) {
    setRecommendingId(eventId);
    try {
      const res = await fetch(`/api/alerts/events/${eventId}/recommend`, { method: "POST" });
      const json = await res.json();
      if (json.recommendations) {
        setRecommendations((m) => ({ ...m, [eventId]: json.recommendations }));
      } else if (json.error) {
        setRecommendations((m) => ({ ...m, [eventId]: `Erreur : ${json.error}` }));
      }
    } catch (e) {
      setRecommendations((m) => ({ ...m, [eventId]: `Erreur : ${e instanceof Error ? e.message : "inconnue"}` }));
    } finally {
      setRecommendingId(null);
    }
  }

  if (loading) return <div className="p-6 text-gray-400">Chargement du cockpit…</div>;
  if (error) return <div className="p-6 text-red-400">{error}</div>;
  if (!data) return null;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Cockpit"
        subtitle={
          <>
            {data.summary.isAdmin ? "Vue agence" : "Vue consultant"} · 30 derniers jours · {data.summary.range.since} → {data.summary.range.until}
          </>
        }
        action={
          <button onClick={load} className="text-xs text-gray-400 hover:text-white">Rafraîchir</button>
        }
      />

      {/* KPI row */}
      <div className="grid grid-cols-4 gap-3">
        <Kpi
          label={data.summary.isAdmin ? "Accès clients" : "Comptes"}
          value={data.summary.isAdmin ? data.summary.clientCount : data.summary.accountCount}
          icon={<Users className="w-4 h-4" />}
          accent="violet"
        />
        <Kpi
          label="Dépenses 30j"
          value={fmtMoney(data.summary.totalSpend)}
          icon={<DollarSign className="w-4 h-4" />}
          accent="emerald"
        />
        <Kpi
          label="Alertes ouvertes"
          value={<span className={data.summary.openAlerts > 0 ? "text-amber-400" : undefined}>{data.summary.openAlerts}</span>}
          icon={<AlertCircle className="w-4 h-4" />}
          accent={data.summary.openAlerts > 0 ? "amber" : "gray"}
        />
        <Kpi
          label="Rapports récents"
          value={data.recentReports.length}
          icon={<FileText className="w-4 h-4" />}
          accent="blue"
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Alerts column */}
        <div className="col-span-2 space-y-4">
          {/* Urgent accounts */}
          {data.urgentAccounts.length > 0 && (
            <section className="bg-gray-900 border border-amber-900/40 rounded-2xl">
              <header className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-amber-300 flex items-center gap-2">
                  <Activity className="w-4 h-4" /> Comptes en alerte
                </h2>
                <span className="text-xs text-gray-500">{data.urgentAccounts.length}</span>
              </header>
              <div className="divide-y divide-gray-800">
                {data.urgentAccounts.slice(0, 6).map((a) => (
                  <div key={`${a.clientUserId}-${a.accountId}`} className="px-4 py-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm text-white font-medium">{a.label ?? a.accountId}</p>
                      <p className="text-xs text-gray-500">
                        {data.summary.isAdmin && <>{a.clientLabel} · </>}
                        Spend {fmtMoney(a.spend)} · ROAS {a.roas > 0 ? a.roas.toFixed(2) + "x" : "—"} · Fréq {a.frequency > 0 ? a.frequency.toFixed(2) : "—"}
                      </p>
                    </div>
                    <Link
                      href={`/creatives?accountId=${a.accountId}`}
                      className="inline-flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300"
                    >
                      Analyser <ArrowRight className="w-3 h-3" />
                    </Link>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Recent alerts feed */}
          <section className="bg-gray-900 border border-gray-800 rounded-2xl">
            <header className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-400" /> Alertes du jour
              </h2>
              <Link href={data.summary.isAdmin ? "/admin/alerts" : "/me/alerts"} className="text-xs text-violet-400 hover:text-violet-300">
                Configurer →
              </Link>
            </header>
            {data.alerts.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500">
                Aucune alerte ouverte. Tout va bien.
              </div>
            ) : (
              <div className="divide-y divide-gray-800">
                {data.alerts.slice(0, 8).map((ev) => (
                  <div key={ev.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <p className="text-sm text-white">{ev.message}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {ev.clientId} · {timeAgo(ev.triggeredAt)}
                        </p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => generatePlan(ev.id)}
                          disabled={recommendingId === ev.id}
                          className="inline-flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300 disabled:opacity-50"
                        >
                          {recommendingId === ev.id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Sparkles className="w-3 h-3" />
                          )}
                          Plan IA
                        </button>
                        <button onClick={() => ackEvent(ev.id)} className="text-xs text-gray-400 hover:text-white">
                          Acquitter
                        </button>
                      </div>
                    </div>
                    {recommendations[ev.id] && (
                      <div className="mt-2 p-3 rounded-lg bg-violet-500/5 border border-violet-500/20 text-xs text-gray-200 whitespace-pre-wrap">
                        {recommendations[ev.id]}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Changes detection */}
          <section className="bg-gray-900 border border-gray-800 rounded-2xl">
            <header className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <GitCompareArrows className="w-4 h-4 text-blue-400" /> Ce qui a changé (30j vs 30j précédents)
              </h2>
              {!changes && !changesLoading && (
                <button onClick={loadChanges} className="text-xs text-violet-400 hover:text-violet-300">
                  Détecter →
                </button>
              )}
            </header>
            {changesLoading ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Analyse en cours…
              </div>
            ) : !changes ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500">
                Clique sur "Détecter" pour analyser les évolutions sur 30 jours.
              </div>
            ) : changes.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500">
                Aucun changement significatif détecté.
              </div>
            ) : (
              <div className="divide-y divide-gray-800">
                {changes.slice(0, 12).map((c, i) => {
                  const sevColor = c.severity === "critical"
                    ? "bg-red-500/15 text-red-300 border-red-500/30"
                    : c.severity === "warning"
                    ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                    : c.severity === "positive"
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                    : "bg-gray-800 text-gray-300 border-gray-700";
                  return (
                    <div key={i} className="px-4 py-3 flex items-start gap-3">
                      <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border shrink-0 ${sevColor}`}>
                        {c.severity}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white">{c.title}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {c.accountLabel ?? c.accountId} — {c.detail}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Budget pacing */}
          <section className="bg-gray-900 border border-gray-800 rounded-2xl">
            <header className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Target className="w-4 h-4 text-violet-400" /> Pacing budgets
              </h2>
              <Link href="/me/budgets" className="text-xs text-violet-400 hover:text-violet-300">
                Configurer →
              </Link>
            </header>
            {data.pacing.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500">
                Aucun budget défini. Configure un objectif mensuel par compte pour suivre le pacing.
              </div>
            ) : (
              <div className="divide-y divide-gray-800">
                {data.pacing.map((item) => {
                  const p = item.pacing;
                  if (!p) {
                    return (
                      <div key={item.id} className="px-4 py-3 text-xs text-gray-500">
                        {item.accountId} — pacing indisponible
                      </div>
                    );
                  }
                  const color =
                    p.status === "on_track"
                      ? "text-emerald-400"
                      : p.status.startsWith("critical")
                      ? "text-red-400"
                      : "text-amber-400";
                  const bar =
                    p.status === "on_track"
                      ? "bg-emerald-500"
                      : p.status.startsWith("critical")
                      ? "bg-red-500"
                      : "bg-amber-500";
                  const elapsedPct = Math.round((p.daysElapsed / p.daysInMonth) * 100);
                  const fillPct = Math.min(p.pacingPct, 100);
                  return (
                    <div key={item.id} className="px-4 py-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-white font-medium">{item.accountId}</span>
                          <span className="text-gray-500 text-xs">
                            J{p.daysElapsed}/{p.daysInMonth}
                          </span>
                        </div>
                        <div className={`text-sm font-bold inline-flex items-center gap-1 ${color}`}>
                          {p.status.startsWith("critical") && <AlertTriangle className="w-3.5 h-3.5" />}
                          {p.pacingPct}%
                        </div>
                      </div>
                      <div className="relative h-1.5 rounded-full bg-gray-800 overflow-hidden">
                        <div className={`absolute top-0 bottom-0 ${bar}`} style={{ width: `${fillPct}%` }} />
                        <div
                          className="absolute top-0 bottom-0 w-px bg-white/30"
                          style={{ left: `${Math.min(elapsedPct, 100)}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-gray-500 mt-1">
                        <span>MTD {fmtMoney(p.mtdSpend)}</span>
                        <span>Projeté {fmtMoney(p.projectedSpend)} / {fmtMoney(p.monthlyTarget)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Clients/accounts table */}
          <section className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
            <header className="px-4 py-3 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-white">
                {data.summary.isAdmin ? "Accès clients (logins)" : "Mes comptes"}
              </h2>
            </header>
            <table className="w-full text-sm">
              <thead className="bg-gray-950/50">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    {data.summary.isAdmin ? "Client" : "Compte"}
                  </th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">Spend 30j</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">ROAS</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">Alertes</th>
                </tr>
              </thead>
              <tbody>
                {data.summary.isAdmin
                  ? data.clients.map((c) => (
                      <tr key={c.userId} className="border-t border-gray-800 hover:bg-gray-800/30">
                        <td className="px-4 py-2.5">
                          <Link href={`/portfolio`} className="text-white hover:text-violet-300">
                            {c.name ?? c.email ?? c.userId}
                          </Link>
                          <div className="text-xs text-gray-500">{c.accounts.length} compte{c.accounts.length > 1 ? "s" : ""}</div>
                        </td>
                        <td className="text-right px-4 py-2.5 font-semibold text-white">{fmtMoney(c.totalSpend)}</td>
                        <td className="text-right px-4 py-2.5">
                          {c.avgRoas > 0 ? (
                            <span className={`inline-flex items-center gap-1 ${c.avgRoas >= 2 ? "text-emerald-400" : "text-amber-400"}`}>
                              {c.avgRoas >= 2 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                              {c.avgRoas.toFixed(2)}x
                            </span>
                          ) : (
                            <span className="text-gray-600">—</span>
                          )}
                        </td>
                        <td className="text-right px-4 py-2.5">
                          {c.alertCount > 0 ? (
                            <span className="text-amber-400">{c.alertCount}</span>
                          ) : (
                            <span className="text-gray-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))
                  : data.clients.flatMap((c) =>
                      c.accounts.map((a) => (
                        <tr key={a.accountId} className="border-t border-gray-800 hover:bg-gray-800/30">
                          <td className="px-4 py-2.5">
                            <span className={a.fetchOk ? "text-white" : "text-gray-600 italic"}>
                              {a.label ?? a.accountId}
                            </span>
                            {!a.fetchOk && <span className="text-xs text-amber-500 ml-2">(hors BM)</span>}
                          </td>
                          <td className="text-right px-4 py-2.5 font-semibold text-white">{fmtMoney(a.spend)}</td>
                          <td className="text-right px-4 py-2.5">
                            {a.roas > 0 ? (
                              <span className={`inline-flex items-center gap-1 ${a.roas >= 2 ? "text-emerald-400" : "text-amber-400"}`}>
                                {a.roas >= 2 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                                {a.roas.toFixed(2)}x
                              </span>
                            ) : (
                              <span className="text-gray-600">—</span>
                            )}
                          </td>
                          <td className="text-right px-4 py-2.5 text-gray-300">{a.ctr > 0 ? `${a.ctr.toFixed(2)}%` : "—"}</td>
                        </tr>
                      )),
                    )}
              </tbody>
            </table>
          </section>
        </div>

        {/* Right column: recent reports */}
        <div className="space-y-4">
          <section className="bg-gray-900 border border-gray-800 rounded-2xl">
            <header className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <FileText className="w-4 h-4 text-blue-400" /> Rapports récents
              </h2>
              <Link href={data.summary.isAdmin ? "/admin/schedules" : "/me/schedules"} className="text-xs text-violet-400 hover:text-violet-300">
                Planifier →
              </Link>
            </header>
            {data.recentReports.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-gray-500">
                Aucun rapport généré pour l'instant.
              </div>
            ) : (
              <div className="divide-y divide-gray-800">
                {data.recentReports.slice(0, 8).map((r) => (
                  <Link
                    key={r.id}
                    href={`/deck?clientId=${r.clientId}`}
                    className="block px-4 py-3 hover:bg-gray-800/30"
                  >
                    <p className="text-sm text-white truncate">{r.clientName}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {new Date(r.startDate).toLocaleDateString("fr-FR")} → {new Date(r.endDate).toLocaleDateString("fr-FR")} · {timeAgo(r.createdAt)}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
