"use client";

/**
 * "Nouveau rapport" form: pick a client (dashboard), a period preset or free
 * range, and a comparison mode. Generation takes 1–3 minutes: the form shows
 * progress and hands the id back once the row exists (the page then polls).
 */

import { useEffect, useMemo, useState } from "react";

export interface ReportClient {
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  reportFrequency: string | null;
  lastReport: { id: string; status: string; periodSince: string; periodUntil: string; createdAt: string } | null;
}

const fmt = (d: Date) => d.toISOString().split("T")[0];

function presets(now = new Date()) {
  const y = new Date(now); y.setUTCDate(y.getUTCDate() - 1);
  const last7 = new Date(y); last7.setUTCDate(last7.getUTCDate() - 6);
  const last30 = new Date(y); last30.setUTCDate(last30.getUTCDate() - 29);
  const firstThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonthEnd = new Date(firstThis); lastMonthEnd.setUTCDate(0);
  const lastMonthStart = new Date(Date.UTC(lastMonthEnd.getUTCFullYear(), lastMonthEnd.getUTCMonth(), 1));
  return [
    { key: "last_month", label: "Mois dernier", since: fmt(lastMonthStart), until: fmt(lastMonthEnd) },
    { key: "last_30", label: "30 derniers jours", since: fmt(last30), until: fmt(y) },
    { key: "last_7", label: "7 derniers jours", since: fmt(last7), until: fmt(y) },
    { key: "mtd", label: "Mois en cours", since: fmt(firstThis), until: fmt(y) },
  ];
}

export function NewReportForm({
  clients,
  defaultClientId,
  onCreated,
  onCancel,
}: {
  clients: ReportClient[];
  defaultClientId?: string | null;
  onCreated: (reportId: string) => void;
  onCancel?: () => void;
}) {
  const P = useMemo(() => presets(), []);
  const [clientId, setClientId] = useState(defaultClientId ?? clients[0]?.id ?? "");
  const [preset, setPreset] = useState(P[0].key);
  const [since, setSince] = useState(P[0].since);
  const [until, setUntil] = useState(P[0].until);
  const [compare, setCompare] = useState<"prev" | "year" | "none">("prev");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (defaultClientId) setClientId(defaultClientId);
  }, [defaultClientId]);

  useEffect(() => {
    if (!busy) return;
    const steps = ["Collecte des données Meta / Google…", "Analyse des campagnes et créas…", "Rédaction du rapport par l'IA…", "Finalisation…"];
    let i = 0;
    setPhase(steps[0]);
    const t = setInterval(() => { i = Math.min(i + 1, steps.length - 1); setPhase(steps[i]); }, 25000);
    return () => clearInterval(t);
  }, [busy]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dashboardId: clientId, since, until, compare }),
      });
      const j = await res.json().catch(() => ({}));
      if (j.report?.id) {
        onCreated(j.report.id);
        return;
      }
      throw new Error(j.error ?? `Erreur ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
      setPhase(null);
    }
  }

  const selectCls = "w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500";

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="block text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-1">Client</label>
        <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={selectCls} disabled={busy}>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.metaAccountId && c.googleCustomerId ? " · Meta + Google" : c.metaAccountId ? " · Meta" : " · Google"}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-1">Période</label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {P.map((p) => (
            <button
              key={p.key}
              type="button"
              disabled={busy}
              onClick={() => { setPreset(p.key); setSince(p.since); setUntil(p.until); }}
              className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${preset === p.key ? "bg-violet-600 border-violet-500 text-white" : "bg-gray-950 border-gray-800 text-gray-400 hover:text-white"}`}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => setPreset("custom")}
            className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${preset === "custom" ? "bg-violet-600 border-violet-500 text-white" : "bg-gray-950 border-gray-800 text-gray-400 hover:text-white"}`}
          >
            Personnalisée
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={since} max={until} onChange={(e) => { setSince(e.target.value); setPreset("custom"); }} disabled={busy} className={`${selectCls} [color-scheme:dark]`} />
          <span className="text-gray-600 text-xs">→</span>
          <input type="date" value={until} min={since} onChange={(e) => { setUntil(e.target.value); setPreset("custom"); }} disabled={busy} className={`${selectCls} [color-scheme:dark]`} />
        </div>
      </div>

      <div>
        <label className="block text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-1">Comparaison</label>
        <select value={compare} onChange={(e) => setCompare(e.target.value as typeof compare)} className={selectCls} disabled={busy}>
          <option value="prev">vs période précédente</option>
          <option value="year">vs année précédente</option>
          <option value="none">sans comparaison</option>
        </select>
      </div>

      {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-900/40 rounded-lg px-3 py-2">{error}</div>}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={busy || !clientId}
          className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-semibold"
        >
          {busy ? "Génération en cours…" : "Générer le rapport IA"}
        </button>
        {onCancel && !busy && (
          <button type="button" onClick={onCancel} className="px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white">Annuler</button>
        )}
        {busy && phase && <span className="text-xs text-gray-500 animate-pulse">{phase} (1 à 3 min)</span>}
      </div>
    </form>
  );
}
