"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, FileText, Loader2, Bot, Sparkles, BarChart3, LayoutDashboard, Gauge } from "lucide-react";
import type { ClientRef } from "@/lib/clients/registry";
import { Card, Kpi, PageHeader, Pill } from "@/components/ui/surface";
import { DeltaBadge, PacingBar } from "@/components/portfolio/kpi-delta";
import { errorKindLabel, fmtMetric, fmtMoney, fmtNumber, fmtRoas } from "@/components/portfolio/format";
import { Freshness, WithoutDataBanner } from "@/components/portfolio/freshness";
import { CrmLevelBadge } from "@/components/portfolio/crm-shared";
import type { PortfolioClient, PortfolioResult } from "@/lib/portfolio";

import { compareClients, DEFAULT_DIR, type PortfolioRow, type SortDir, type SortKey } from "@/components/portfolio/sort";

/**
 * /portfolio — the client list. Opens INSTANTLY on the light list
 * (GET /api/clients: names, platforms, identifiers, no Meta/Google call);
 * the 30-day KPI table (GET /api/portfolio, up to 100 s) is loaded only when
 * the consultant asks for it ("Chiffres 30 j", or ?kpis=1) — the per-client
 * cockpit already carries the numbers.
 */
export default function PortfolioPage() {
  const params = useSearchParams();
  const [showKpis, setShowKpis] = useState(params.get("kpis") === "1");
  if (showKpis) return <PortfolioKpiPage onBack={() => setShowKpis(false)} />;
  return <ClientListPage onShowKpis={() => setShowKpis(true)} />;
}

function ClientListPage({ onShowKpis }: { onShowKpis: () => void }) {
  const [clients, setClients] = useState<ClientRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/clients", { cache: "no-store" });
        if (!res.ok) throw new Error(`Erreur ${res.status}`);
        const body = (await res.json()) as { clients: ClientRef[] };
        if (!cancelled) setClients(body.clients);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Erreur");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => {
    if (!clients) return [];
    const needle = q.trim().toLowerCase();
    const digits = needle.replace(/\D/g, "");
    return clients.filter((c) => {
      if (!needle) return true;
      if (c.name.toLowerCase().includes(needle)) return true;
      if (digits.length >= 3 && c.accounts.some((a) => a.id.replace(/\D/g, "").includes(digits))) return true;
      if (c.accounts.some((a) => a.name.toLowerCase().includes(needle))) return true;
      return false;
    });
  }, [clients, q]);

  const action = "inline-flex items-center gap-1.5 rounded-md border border-ui-line bg-ui-card px-2.5 py-1 text-xs text-ui-fg2 hover:text-ui-fg hover:border-ui-accent transition-colors whitespace-nowrap";

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Clients"
        subtitle="Un client = une marque, avec tous ses comptes Meta, Google Ads et TikTok. Les chiffres sont dans le cockpit de chaque client ; ⌘K retrouve un client par nom ou par identifiant."
        action={
          <div className="flex items-center gap-2">
            <button type="button" onClick={onShowKpis} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-ui-line bg-ui-card text-ui-fg2 hover:text-ui-fg hover:border-ui-accent text-sm" title="Charger les KPIs des 30 derniers jours pour tous les clients (jusqu'à 1 à 2 min)">
              <BarChart3 className="w-4 h-4" /> Chiffres 30 j
            </button>
            <Link href="/reports?new=1" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-ui-accent hover:brightness-110 text-ui-on-accent text-sm font-medium">
              <FileText className="w-4 h-4" /> Rapport IA
            </Link>
          </div>
        }
      />

      {error && <div className="text-xs text-red-400">{error}</div>}

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-ui-line flex items-center gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher un client (nom, compte Meta, Google, TikTok)…"
            autoFocus
            className="bg-ui-bg border border-ui-line rounded-lg px-3 py-1.5 text-sm text-ui-fg placeholder:text-ui-muted focus:outline-none focus:border-ui-accent w-96 max-w-full"
          />
          <span className="text-xs text-ui-muted">{clients ? `${rows.length} client${rows.length > 1 ? "s" : ""}` : ""}</span>
          {!clients && !error && <Loader2 className="w-3 h-3 animate-spin text-ui-muted" />}
        </div>
        <table className="w-full text-sm">
          <thead className="bg-ui-bg">
            <tr>
              <th className="text-left px-3 py-2 text-[11px] font-medium text-ui-muted ">Client</th>
              <th className="text-left px-3 py-2 text-[11px] font-medium text-ui-muted ">Plateformes</th>
              <th className="text-right px-3 py-2 text-[11px] font-medium text-ui-muted ">Ouvrir</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t border-ui-line hover:bg-ui-raised">
                <td className="px-3 py-2.5">
                  {c.dashboardId ? <Link href={`/portfolio/${c.dashboardId}`} className="font-medium text-ui-fg hover:text-ui-accent-ink">{c.name}</Link> : <Link href={`/analyse?client=${c.clientId}`} className="font-medium text-ui-fg hover:text-ui-accent-ink">{c.name}</Link>}
                  <div className="text-[11px] text-ui-muted truncate max-w-[420px]" title={c.accounts.map((a) => `${a.platform === "meta" ? "Meta" : a.platform === "google" ? "Google" : "TikTok"} ${a.id} · ${a.name}`).join("\n")}>
                    {c.accounts.length} compte{c.accounts.length > 1 ? "s" : ""} : {c.accounts.map((a) => a.name).filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 3).join(" · ")}{c.accounts.length > 3 ? "…" : ""}
                    {!c.dashboardId && <span className="text-amber-400/80"> · sans dashboard</span>}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex gap-1">
                    {(["meta", "google", "tiktok"] as const).map((pf) => { const n = c.accounts.filter((a) => a.platform === pf).length; return n ? <Pill key={pf} tone={pf === "meta" ? "blue" : pf === "google" ? "emerald" : "violet"}>{pf === "meta" ? "Meta" : pf === "google" ? "Google Ads" : "TikTok"}{n > 1 ? ` ×${n}` : ""}</Pill> : null; })}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center justify-end gap-1.5 flex-wrap">
                    {c.dashboardId ? <Link href={`/portfolio/${c.dashboardId}`} className={action} title="Cockpit du client : KPIs, sources, rapports, Drive"><Gauge className="w-3.5 h-3.5 text-ui-accent-ink" /> Cockpit</Link> : <Link href="/d" className={action} title="Ce client n'a pas encore de dashboard client : créez-le pour avoir son cockpit, ses rapports et son Drive"><Gauge className="w-3.5 h-3.5 text-amber-300" /> Créer le dashboard</Link>}
                    <Link href={`/analyse?client=${c.clientId}`} className={action} title="Analyse Ads : les créas Meta, Google et TikTok de ce client"><Sparkles className="w-3.5 h-3.5 text-ui-accent-ink" /> Analyse Ads</Link>
                    {c.dashboardId && <Link href={`/d/${c.dashboardId}`} className={action} title="Dashboard client"><LayoutDashboard className="w-3.5 h-3.5 text-ui-accent-ink" /> Dashboard</Link>}
                    {c.dashboardId && <Link href={`/reports?new=1&dashboardId=${c.dashboardId}`} className={action} title="Nouveau rapport IA pour ce client"><FileText className="w-3.5 h-3.5 text-ui-accent-ink" /> Rapport</Link>}
                  </div>
                </td>
              </tr>
            ))}
            {clients && rows.length === 0 && (
              <tr><td colSpan={3} className="px-4 py-10 text-center text-sm text-ui-muted">{q ? "Aucun client ne correspond." : <>Aucun client. Créez un dashboard client dans <Link href="/d" className="text-ui-accent-ink">Dashboards client</Link>.</>}</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/** The former /portfolio: every client with 30-day KPIs vs previous period (heavy: one Meta/Google read per client). */
function PortfolioKpiPage({ onBack }: { onBack: () => void }) {
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

  const rows = useMemo<PortfolioRow[]>(() => {
    if (!data) return [];
    const filtered = (data.clients as PortfolioRow[]).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()));
    return [...filtered].sort((a, b) => compareClients(a, b, sort, dir));
  }, [data, sort, dir, q]);
  const hasCrm = useMemo(() => !!data && (data.clients as PortfolioRow[]).some((c) => c.crm), [data]);

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
      <button type="button" onClick={() => load(false)} className="text-xs text-ui-accent-ink hover:text-ui-fg">Réessayer</button>
    </div>
  );
  if (!data) return <div className="p-6 flex items-center gap-2 text-ui-muted text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement des chiffres (30 derniers jours complets, jusqu\u2019à 1 à 2 min)…</div>;

  const s = data.summary;
  const currencies = Object.values(s.totalsByCurrency);
  const withoutData = data.clients.filter((c) => !c.fetchOk).map((c) => ({ id: c.id, name: c.name, error: c.error }));

  const th = (key: SortKey, label: string, align = "text-right") => (
    <th className={`${align} px-3 py-2 text-[11px] font-medium text-ui-muted `}>
      <button type="button" onClick={() => toggleSort(key)} className={`inline-flex items-center gap-1 hover:text-ui-fg ${sort === key ? "text-ui-accent-ink" : ""}`} title={sort === key ? `Tri ${dir === "asc" ? "croissant" : "décroissant"} — cliquer pour inverser` : "Trier"}>
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
            <div>Un client = un compte publicitaire (Meta, Google et/ou TikTok Ads), comparé à la période précédente de même durée.</div>
            <Freshness rangeLabel={data.rangeLabel} fetchedAt={fetchedAt} onRefresh={() => load(true)} refreshing={refreshing} timedOut={s.timedOut} />
          </div>
        }
        action={
          <div className="flex items-center gap-2">
            <button type="button" onClick={onBack} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-ui-line bg-ui-card text-ui-fg2 hover:text-ui-fg text-sm">Liste simple</button>
            <Link href="/reports?new=1" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-ui-accent hover:brightness-110 text-ui-on-accent text-sm font-medium">
              <FileText className="w-4 h-4" /> Rapport IA
            </Link>
          </div>
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
        <div className="px-4 py-3 border-b border-ui-line flex items-center gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher un client…"
            className="bg-ui-bg border border-ui-line rounded-lg px-3 py-1.5 text-sm text-ui-fg placeholder:text-ui-muted focus:outline-none focus:border-ui-accent w-64"
          />
          <span className="text-xs text-ui-muted">{rows.length} client{rows.length > 1 ? "s" : ""}</span>
          {loading && <Loader2 className="w-3 h-3 animate-spin text-ui-muted" />}
        </div>
        <div className={`overflow-x-auto ${refreshing ? "opacity-60" : ""}`}>
          <table className="w-full text-sm">
            <thead className="bg-ui-bg">
              <tr>
                {th("name", "Client", "text-left")}
                <th className="text-left px-3 py-2 text-[11px] font-medium text-ui-muted ">Plateformes</th>
                {th("spend", "Dépenses")}
                {th("roas", "ROAS")}
                {th("cpa", "CPA")}
                {th("conversions", "Conv.")}
                {th("crm", "CRM")}
                <th className="text-left px-3 py-2 text-[11px] font-medium text-ui-muted ">Pacing</th>
                {th("attention", "Attention", "text-left")}
                <th className="text-left px-3 py-2 text-[11px] font-medium text-ui-muted ">Dernier rapport</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className={`border-t border-ui-line hover:bg-ui-raised ${!c.fetchOk ? "opacity-70" : ""}`}>
                  <td className="px-3 py-2.5">
                    <Link href={`/portfolio/${c.id}`} className="font-medium text-ui-fg hover:text-ui-accent-ink">{c.name}</Link>
                    <div className="text-[11px] text-ui-muted truncate max-w-[240px]">
                      {c.owner.name ?? c.owner.email}{c.memberCount > 0 ? ` +${c.memberCount}` : ""}
                      {c.duplicates > 0 && <span className="text-ui-muted" title={`${c.duplicates + 1} dashboards fusionnés : ${c.dashboardIds.join(", ")}`}> · {c.duplicates + 1} dashboards</span>}
                      {c.currency && <span className="text-ui-muted"> · {c.currency}</span>}
                    </div>
                    <Link href={`/analyse?client=${c.id}`} className="mt-1 inline-flex items-center gap-1 text-[11px] text-ui-accent-ink hover:text-ui-fg" title="Analyse Ads de ce client"><Sparkles className="w-3 h-3" /> Analyse Ads</Link>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex gap-1">
                      {c.metaAccountId && <Pill tone="blue">Meta</Pill>}
                      {c.googleCustomerId && <Pill tone="emerald">Google</Pill>}
                      {(c.tiktokAdvertiserIds?.length ?? 0) > 0 && <Pill tone="violet">TikTok</Pill>}
                    </div>
                  </td>
                  {!c.fetchOk ? (
                    <td colSpan={4} className="px-3 py-2.5">
                      <div className="rounded-lg border border-dashed border-ui-line bg-ui-card px-3 py-1.5 text-xs text-ui-muted" title={c.error?.message}>
                        <span className="font-medium text-ui-fg2">n/d</span> · {errorKindLabel(c.error?.kind)}
                      </div>
                    </td>
                  ) : (
                    <>
                      <td className="px-3 py-2.5 text-right">
                        <div className="font-medium text-ui-fg tabular-nums">{fmtMoney(c.spend.value, c.currency)}</div>
                        <DeltaBadge metric="spend" deltaPct={c.spend.deltaPct} />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className={`font-medium tabular-nums ${roasTone(c)}`} title={c.roas.unavailable ? "Revenu indisponible : ni valeur de conversion trackée, ni panier moyen configuré" : c.roas.estimated ? "ROAS estimé via panier moyen" : undefined}>
                          {fmtRoas(c.roas.value, { estimated: c.roas.estimated, unavailable: c.roas.unavailable })}
                        </div>
                        {!c.roas.unavailable && <DeltaBadge metric="roas" deltaPct={c.roas.deltaPct} />}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="text-ui-fg tabular-nums">{c.cpa.value > 0 ? fmtMetric("cpa", c.cpa.value, c.currency) : "—"}</div>
                        <DeltaBadge metric="cpa" deltaPct={c.cpa.value > 0 ? c.cpa.deltaPct : null} />
                      </td>
                      <td className="px-3 py-2.5 text-right text-ui-fg2 tabular-nums">
                        {c.conversions.value > 0 ? fmtNumber(c.conversions.value) : "—"}
                        <div><DeltaBadge metric="purchases" deltaPct={c.conversions.deltaPct} /></div>
                      </td>
                    </>
                  )}
                  <td className="px-3 py-2.5"><CrmCell crm={c.crm} /></td>
                  <td className="px-3 py-2.5">{c.pacing ? <PacingBar pacing={c.pacing} compact /> : <span className="text-[11px] text-ui-muted" title="Aucun budget mensuel — définissez-le dans la fiche client">—</span>}</td>
                  <td className="px-3 py-2.5">
                    {c.attention > 0 ? (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${c.attention >= 50 ? "text-red-400" : "text-amber-400"}`}>
                          <AlertCircle className="w-3 h-3" /> {c.attention}
                        </span>
                        <span className="text-[11px] text-ui-muted truncate max-w-[200px]" title={c.attentionReasons.join(" · ")}>{c.attentionReasons.join(" · ")}</span>
                      </div>
                    ) : (
                      <span className="text-[11px] text-ui-muted">{c.fetchOk ? "RAS" : "—"}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {c.lastReport ? (
                      <Link href={`/reports/${c.lastReport.id}`} className="text-[11px] text-ui-accent-ink hover:text-ui-fg">
                        {new Date(c.lastReport.createdAt).toLocaleDateString("fr-FR")}
                        {c.lastReport.status !== "ready" && ` (${c.lastReport.status === "failed" ? "échec" : "en cours"})`}
                      </Link>
                    ) : (
                      <Link href={`/reports?new=1&dashboardId=${c.id}`} className="text-[11px] text-ui-muted hover:text-ui-accent-ink">Générer →</Link>
                    )}
                    {c.reportFrequency && (
                      <div className="text-[10px] text-ui-muted inline-flex items-center gap-1"><Bot className="w-3 h-3" /> {c.reportFrequency === "weekly" ? "hebdo" : "mensuel"}</div>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-10 text-center text-sm text-ui-muted">Aucun client. Créez un dashboard client dans <Link href="/d" className="text-ui-accent-ink">Dashboards clients</Link>.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      {data.clients.some((c) => c.estimated) && (
        <p className="text-[11px] text-ui-muted">* ROAS estimé via panier moyen (le compte ne remonte pas la valeur des conversions).</p>
      )}
      {hasCrm && (
        <p className="text-[11px] text-ui-muted">CRM : niveau d&apos;attribution HubSpot (L0 aucune source exploitable, L1 par source d&apos;origine, L2 par campagne UTM) · CPL qualifié = dépense pub ÷ contacts qualifiés · ROAS réel = deals gagnés ÷ dépense pub. Tri sur le CPL qualifié.</p>
      )}
      {data.clients.some((c) => c.fetchOk && c.roas.unavailable) && (
        <p className="text-[11px] text-ui-muted">— ROAS indisponible : le compte ne remonte pas la valeur des conversions et aucun panier moyen n&apos;est configuré (Admin → Comptes).</p>
      )}
    </div>
  );
}

/** CRM column: level badge + qualified CPL + real ROAS, "—" without HubSpot source, error icon on failure. */
function CrmCell({ crm }: { crm: PortfolioRow["crm"] }) {
  if (!crm) return <span className="text-[11px] text-ui-muted" title="Aucune source HubSpot connectée">—</span>;
  if (crm.error) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-red-400" title={`HubSpot en erreur : ${crm.error}`}>
        <AlertCircle className="w-3 h-3" /> CRM
      </span>
    );
  }
  const roasCls = crm.realRoas === null || crm.realRoas <= 0 ? "text-ui-muted" : crm.realRoas >= 2 ? "text-emerald-400" : crm.realRoas < 1 ? "text-red-400" : "text-ui-fg";
  return (
    <div className="min-w-[110px]" title={`${fmtNumber(crm.contacts)} contact${crm.contacts > 1 ? "s" : ""} · ${fmtNumber(crm.qualified)} qualifié${crm.qualified > 1 ? "s" : ""} · ${fmtNumber(crm.won)} gagné${crm.won > 1 ? "s" : ""} (${fmtMoney(crm.wonAmount, crm.currency, { digits: 0 })})${crm.partial ? " · données partielles" : ""}`}>
      <div className="flex items-center gap-1.5">
        <CrmLevelBadge level={crm.level} />
        {crm.partial && <span className="text-[10px] text-amber-400" title="Données HubSpot partielles">partiel</span>}
      </div>
      <div className="text-[11px] tabular-nums mt-0.5 flex items-center gap-1.5 flex-wrap">
        <span className="text-ui-fg2" title="CPL qualifié">{crm.cplQualified !== null && crm.cplQualified > 0 ? fmtMoney(crm.cplQualified, crm.currency, { digits: 2 }) : "—"}</span>
        <span className="text-ui-muted">·</span>
        <span className={roasCls} title="ROAS réel (deals gagnés ÷ dépense pub)">{fmtRoas(crm.realRoas)}</span>
      </div>
    </div>
  );
}

function roasTone(c: PortfolioClient): string {
  if (c.roas.unavailable || c.roas.value <= 0) return "text-ui-muted";
  if (c.roas.value >= 2) return "text-emerald-400";
  if (c.roas.value < 1) return "text-red-400";
  return "text-ui-fg";
}
