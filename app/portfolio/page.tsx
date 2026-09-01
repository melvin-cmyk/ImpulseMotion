"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, FileText, Loader2, Bot } from "lucide-react";
import { Card, Kpi, PageHeader, Pill } from "@/components/ui/surface";
import { DeltaBadge, PacingBar } from "@/components/portfolio/kpi-delta";
import { errorKindLabel, fmtMetric, fmtMoney, fmtNumber, fmtRoas } from "@/components/portfolio/format";
import { Freshness, WithoutDataBanner } from "@/components/portfolio/freshness";
import type { PortfolioClient, PortfolioResult } from "@/lib/portfolio";

import { compareClients, DEFAULT_DIR, type SortDir, type SortKey } from "@/components/portfolio/sort";

export default function PortfolioPage() {
  const params = useSearchParams();
  const since = params.get("since");
  const until = params.get("until");
  const [data, setData] = useState<PortfolioResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sort, setSort] = useState<SortKey>("spend");
  const [dir, setDir] = useState<SortDir>("desc");
  const [q, setQ] = useState("");

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (since && until) { qs.set("since", since); qs.set("until", until); }
      if (refresh) qs.set("refresh", "1");
      const res = await fetch(`/api/portfolio${qs.size ? `?${qs}` : ""}`, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Erreur ${res.status}`);
      }
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [since, until]);

  useEffect(() => { void load(false); }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    const filtered = data.clients.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()));
    return [...filtered].sort((a, b) => compareClients(a, b, sort, dir));
  }, [data, sort, dir, q]);

  const fetchedAt = useMemo(
    () => data?.clients.reduce<string | null>((min, c) => (c.fetchedAt && (!min || c.fetchedAt < min) ? c.fetchedAt : min), null) ?? null,
    [data],
  );

  function toggleSort(key: SortKey) {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(key); setDir(DEFAULT_DIR[key]); }
  }

  if (error && !data) return (
    <div className="p-6 space-y-3">
      <div className="text-red-400 text-sm">{error}</div>
      <button type="button" onClick={() => load(false)} className="text-xs text-violet-400 hover:text-white">Réessayer</button>
    </div>
  );
  if (!data) return <div className="p-6 flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement des clients (30 derniers jours complets)…</div>;

  const s = data.summary;
  const currencies = Object.values(s.totalsByCurrency);
  const withoutData = data.clients.filter((c) => !c.fetchOk).map((c) => ({ id: c.id, name: c.name, error: c.error }));

  const th = (key: SortKey, label: string, align = "text-right") => (
    <th className={`${align} px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide`}>
      <button type="button" onClick={() => toggleSort(key)} className={`inline-flex items-center gap-1 hover:text-white ${sort === key ? "text-violet-300" : ""}`} title={sort === key ? `Tri ${dir === "asc" ? "croissant" : "décroissant"} — cliquer pour inverser` : "Trier"}>
        {label} {sort === key ? (dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-60" />}
      </button>
    </th>
  );

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Clients"
        subtitle={
          <div className="space-y-1">
            <div>Un client = un compte publicitaire (Meta et/ou Google), comparé à la période précédente de même durée.</div>
            <Freshness rangeLabel={data.rangeLabel} fetchedAt={fetchedAt} onRefresh={() => load(true)} refreshing={refreshing} timedOut={s.timedOut} />
          </div>
        }
        action={
          <Link href="/reports?new=1" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold">
            <FileText className="w-4 h-4" /> Rapport IA
          </Link>
        }
      />

      {error && <div className="text-xs text-red-400">{error}</div>}
      <WithoutDataBanner items={withoutData} unlinked={data.unlinked} />
      {s.timedOut && s.unresolved.length > 0 && (
        <div className="text-xs text-amber-300">Non résolus (budget de temps atteint) : {s.unresolved.map((u) => u.name).join(", ")} — cliquez sur Actualiser pour réessayer.</div>
      )}

      <div className={`grid grid-cols-2 gap-3 ${currencies.length > 1 ? "md:grid-cols-3" : "md:grid-cols-4"}`}>
        <Kpi label="Clients" value={s.clientCount} accent="violet" sub={`${s.reportsEnabled} en rapport automatique${s.clientsWithoutData ? ` · ${s.clientsWithoutData} sans données` : ""}`} />
        {currencies.length === 0 && <Kpi label="Dépenses" value="—" accent="gray" sub="aucune donnée" />}
        {currencies.map((t) => (
          <Kpi
            key={t.currency}
            label={`Dépenses ${t.currency === "unknown" ? "(devise inconnue)" : t.currency}`}
            value={fmtMoney(t.spend, t.currency === "unknown" ? null : t.currency)}
            accent="emerald"
            sub={
              <span className="inline-flex items-center gap-2">
                <DeltaBadge metric="spend" deltaPct={t.spendDeltaPct} />
                <span>ROAS {t.roas !== null ? fmtRoas(t.roas, { estimated: t.revenueEstimated }) : "—"} · {t.clientCount} client{t.clientCount > 1 ? "s" : ""}</span>
              </span>
            }
          />
        ))}
        <Kpi label="Alertes ouvertes" value={<span className={s.openAlerts > 0 ? "text-amber-400" : undefined}>{s.openAlerts}</span>} accent={s.openAlerts > 0 ? "amber" : "gray"} />
      </div>

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher un client…"
            className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-violet-500 w-64"
          />
          <span className="text-xs text-gray-500">{rows.length} client{rows.length > 1 ? "s" : ""}</span>
          {loading && <Loader2 className="w-3 h-3 animate-spin text-gray-500" />}
        </div>
        <div className={`overflow-x-auto ${refreshing ? "opacity-60" : ""}`}>
          <table className="w-full text-sm">
            <thead className="bg-gray-950/50">
              <tr>
                {th("name", "Client", "text-left")}
                <th className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Plateformes</th>
                {th("spend", "Dépenses")}
                {th("roas", "ROAS")}
                {th("cpa", "CPA")}
                {th("conversions", "Conv.")}
                <th className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Pacing</th>
                {th("attention", "Attention", "text-left")}
                <th className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Dernier rapport</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className={`border-t border-gray-800 hover:bg-gray-800/30 ${!c.fetchOk ? "opacity-70" : ""}`}>
                  <td className="px-3 py-2.5">
                    <Link href={`/portfolio/${c.id}`} className="font-medium text-white hover:text-violet-300">{c.name}</Link>
                    <div className="text-[11px] text-gray-500 truncate max-w-[240px]">
                      {c.owner.name ?? c.owner.email}{c.memberCount > 0 ? ` +${c.memberCount}` : ""}
                      {c.duplicates > 0 && <span className="text-gray-600" title={`${c.duplicates + 1} dashboards fusionnés : ${c.dashboardIds.join(", ")}`}> · {c.duplicates + 1} dashboards</span>}
                      {c.currency && <span className="text-gray-600"> · {c.currency}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex gap-1">
                      {c.metaAccountId && <Pill tone="blue">Meta</Pill>}
                      {c.googleCustomerId && <Pill tone="emerald">Google</Pill>}
                    </div>
                  </td>
                  {!c.fetchOk ? (
                    <td colSpan={4} className="px-3 py-2.5">
                      <div className="rounded-lg border border-dashed border-gray-800 bg-gray-900/60 px-3 py-1.5 text-xs text-gray-500" title={c.error?.message}>
                        <span className="font-semibold text-gray-400">n/d</span> · {errorKindLabel(c.error?.kind)}
                      </div>
                    </td>
                  ) : (
                    <>
                      <td className="px-3 py-2.5 text-right">
                        <div className="font-semibold text-white tabular-nums">{fmtMoney(c.spend.value, c.currency)}</div>
                        <DeltaBadge metric="spend" deltaPct={c.spend.deltaPct} />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className={`font-semibold tabular-nums ${roasTone(c)}`} title={c.roas.unavailable ? "Revenu indisponible : ni valeur de conversion trackée, ni panier moyen configuré" : c.roas.estimated ? "ROAS estimé via panier moyen" : undefined}>
                          {fmtRoas(c.roas.value, { estimated: c.roas.estimated, unavailable: c.roas.unavailable })}
                        </div>
                        {!c.roas.unavailable && <DeltaBadge metric="roas" deltaPct={c.roas.deltaPct} />}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="text-white tabular-nums">{c.cpa.value > 0 ? fmtMetric("cpa", c.cpa.value, c.currency) : "—"}</div>
                        <DeltaBadge metric="cpa" deltaPct={c.cpa.value > 0 ? c.cpa.deltaPct : null} />
                      </td>
                      <td className="px-3 py-2.5 text-right text-gray-300 tabular-nums">
                        {c.conversions.value > 0 ? fmtNumber(c.conversions.value) : "—"}
                        <div><DeltaBadge metric="purchases" deltaPct={c.conversions.deltaPct} /></div>
                      </td>
                    </>
                  )}
                  <td className="px-3 py-2.5">{c.pacing ? <PacingBar pacing={c.pacing} compact /> : <span className="text-[11px] text-gray-600" title="Aucun budget mensuel — définissez-le dans la fiche client">—</span>}</td>
                  <td className="px-3 py-2.5">
                    {c.attention > 0 ? (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${c.attention >= 50 ? "text-red-400" : "text-amber-400"}`}>
                          <AlertCircle className="w-3 h-3" /> {c.attention}
                        </span>
                        <span className="text-[11px] text-gray-500 truncate max-w-[200px]" title={c.attentionReasons.join(" · ")}>{c.attentionReasons.join(" · ")}</span>
                      </div>
                    ) : (
                      <span className="text-[11px] text-gray-600">{c.fetchOk ? "RAS" : "—"}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {c.lastReport ? (
                      <Link href={`/reports/${c.lastReport.id}`} className="text-[11px] text-violet-300 hover:text-white">
                        {new Date(c.lastReport.createdAt).toLocaleDateString("fr-FR")}
                        {c.lastReport.status !== "ready" && ` (${c.lastReport.status === "failed" ? "échec" : "en cours"})`}
                      </Link>
                    ) : (
                      <Link href={`/reports?new=1&dashboardId=${c.id}`} className="text-[11px] text-gray-500 hover:text-violet-300">Générer →</Link>
                    )}
                    {c.reportFrequency && (
                      <div className="text-[10px] text-gray-600 inline-flex items-center gap-1"><Bot className="w-3 h-3" /> {c.reportFrequency === "weekly" ? "hebdo" : "mensuel"}</div>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-10 text-center text-sm text-gray-500">Aucun client. Créez un dashboard client dans <Link href="/d" className="text-violet-400">Dashboards clients</Link>.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      {data.clients.some((c) => c.estimated) && (
        <p className="text-[11px] text-gray-600">* ROAS estimé via panier moyen (le compte ne remonte pas la valeur des conversions).</p>
      )}
      {data.clients.some((c) => c.fetchOk && c.roas.unavailable) && (
        <p className="text-[11px] text-gray-600">— ROAS indisponible : le compte ne remonte pas la valeur des conversions et aucun panier moyen n&apos;est configuré (Admin → Comptes).</p>
      )}
    </div>
  );
}

function roasTone(c: PortfolioClient): string {
  if (c.roas.unavailable || c.roas.value <= 0) return "text-gray-500";
  if (c.roas.value >= 2) return "text-emerald-400";
  if (c.roas.value < 1) return "text-red-400";
  return "text-white";
}
