"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle, ArrowRight, FileText, Activity, DollarSign, GitCompareArrows, Sparkles, Loader2, Target, Briefcase, Bot,
} from "lucide-react";
import { Section, Kpi, PageHeader, Pill } from "@/components/ui/surface";
import { DeltaBadge, PacingBar } from "@/components/portfolio/kpi-delta";
import { fmtMoney, fmtRoas } from "@/components/portfolio/format";
import { Freshness, WithoutDataBanner } from "@/components/portfolio/freshness";
import type { PortfolioClient, PortfolioSummary } from "@/lib/portfolio";
import type { PacingResult } from "@/lib/budgets";

type AlertEvent = {
  id: string;
  clientId: string;
  metric: string;
  value: number;
  threshold: number;
  message: string;
  triggeredAt: string;
  recommendations?: string | null;
  client: { id: string; name: string } | null;
};

type Report = {
  id: string; clientId: string; clientName: string; title: string; status: string; trigger: string;
  startDate: string; endDate: string; createdAt: string;
};

type CockpitData = {
  summary: PortfolioSummary;
  range: { since: string; until: string };
  rangeLabel: string;
  generatedAt: string;
  fetchedAt: string | null;
  config: { alertRules: number; budgets: number };
  withoutData: Array<{ id: string; name: string; error: { kind: string; message: string } | null }>;
  unlinked: Array<{ id: string; name: string }>;
  attention: PortfolioClient[];
  alerts: AlertEvent[];
  pacing: Array<{ id: string; name: string; pacing: PacingResult }>;
  recentReports: Report[];
  topClients: Array<{ id: string; name: string; currency: string | null; spend: PortfolioClient["spend"]; roas: PortfolioClient["roas"]; cpa: PortfolioClient["cpa"]; alertCount: number; fetchOk: boolean }>;
};

type ChangeEvent = {
  kind: string;
  severity: "info" | "warning" | "critical" | "positive";
  accountId: string;
  accountLabel?: string | null;
  clientId?: string | null;
  title: string;
  detail: string;
};

type ChangesPayload = { events: ChangeEvent[]; accountCount: number; totalAccounts?: number; truncated?: boolean; timedOut?: boolean; failures?: Array<{ accountId: string; label: string | null; error: string }> };

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.floor(hours / 24)} j`;
}

export default function CockpitPage() {
  const [data, setData] = useState<CockpitData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [changes, setChanges] = useState<ChangesPayload | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [recommendingId, setRecommendingId] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<Record<string, string>>({});

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`/api/cockpit${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Erreur ${res.status}`);
      }
      const json: CockpitData = await res.json();
      setData(json);
      const cached: Record<string, string> = {};
      for (const ev of json.alerts ?? []) if (ev.recommendations) cached[ev.id] = ev.recommendations;
      setRecommendations(cached);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  async function loadChanges(refresh = false) {
    setChangesLoading(true);
    try {
      const res = await fetch(`/api/changes${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      const json = await res.json();
      setChanges({ events: json.events ?? [], accountCount: json.accountCount ?? 0, totalAccounts: json.totalAccounts, truncated: json.truncated, timedOut: json.timedOut, failures: json.failures });
    } catch {
      setChanges({ events: [], accountCount: 0 });
    } finally {
      setChangesLoading(false);
    }
  }

  async function ackEvent(id: string) {
    const res = await fetch("/api/alerts/events", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, acknowledged: true }),
    });
    if (!res.ok) { setError(`Impossible d'acquitter (${res.status})`); return; }
    void load(false);
  }

  async function generatePlan(eventId: string) {
    setRecommendingId(eventId);
    try {
      const res = await fetch(`/api/alerts/events/${eventId}/recommend`, { method: "POST" });
      const json = await res.json();
      if (json.recommendations) setRecommendations((m) => ({ ...m, [eventId]: json.recommendations }));
      else if (json.error) setRecommendations((m) => ({ ...m, [eventId]: `Erreur : ${json.error}` }));
    } catch (e) {
      setRecommendations((m) => ({ ...m, [eventId]: `Erreur : ${e instanceof Error ? e.message : "inconnue"}` }));
    } finally {
      setRecommendingId(null);
    }
  }

  if (error && !data) return (
    <div className="p-6 space-y-3">
      <div className="text-red-400 text-sm">{error}</div>
      <button type="button" onClick={() => load(false)} className="text-xs text-violet-400 hover:text-white">Réessayer</button>
    </div>
  );
  if (!data) return <div className="p-6 flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement du cockpit (30 derniers jours complets)…</div>;

  const s = data.summary;
  const currencies = Object.values(s.totalsByCurrency);
  const noRules = data.config.alertRules === 0;
  const noBudgets = data.config.budgets === 0;

  return (
    <div className={`p-6 space-y-6 max-w-7xl mx-auto ${refreshing ? "opacity-80" : ""}`}>
      <PageHeader
        title="Cockpit"
        subtitle={
          <div className="space-y-1">
            <div>Ce qui demande votre attention aujourd&apos;hui · vs période précédente de même durée</div>
            <Freshness rangeLabel={data.rangeLabel} fetchedAt={data.fetchedAt ?? data.generatedAt} timedOut={s.timedOut} />
          </div>
        }
        action={
          <button type="button" onClick={() => load(true)} disabled={refreshing} className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-white disabled:opacity-50">
            {refreshing && <Loader2 className="w-3 h-3 animate-spin" />} {refreshing ? "Actualisation…" : "Rafraîchir"}
          </button>
        }
      />

      {error && <div className="text-xs text-red-400">{error}</div>}
      <WithoutDataBanner items={data.withoutData} unlinked={data.unlinked} />

      <div className={`grid grid-cols-2 gap-3 ${currencies.length > 1 ? "md:grid-cols-3" : "md:grid-cols-4"}`}>
        <Kpi label="Clients" value={s.clientCount} icon={<Briefcase className="w-4 h-4" />} accent="violet" sub={`${s.reportsEnabled} en rapport automatique${s.clientsWithoutData ? ` · ${s.clientsWithoutData} sans données` : ""}`} />
        {currencies.length === 0 && <Kpi label="Dépenses" value="—" icon={<DollarSign className="w-4 h-4" />} accent="gray" sub="aucune donnée" />}
        {currencies.map((t) => (
          <Kpi
            key={t.currency}
            label={`Dépenses ${t.currency === "unknown" ? "(devise inconnue)" : t.currency}`}
            value={fmtMoney(t.spend, t.currency === "unknown" ? null : t.currency)}
            icon={<DollarSign className="w-4 h-4" />}
            accent="emerald"
            sub={
              <span className="inline-flex items-center gap-2">
                <DeltaBadge metric="spend" deltaPct={t.spendDeltaPct} />
                <span>ROAS {t.roas !== null ? fmtRoas(t.roas, { estimated: t.revenueEstimated }) : "—"} · {t.clientCount} client{t.clientCount > 1 ? "s" : ""}</span>
              </span>
            }
          />
        ))}
        <Kpi label="Alertes ouvertes" value={<span className={s.openAlerts > 0 ? "text-amber-400" : undefined}>{s.openAlerts}</span>} icon={<AlertCircle className="w-4 h-4" />} accent={s.openAlerts > 0 ? "amber" : "gray"} sub={noRules ? "aucune règle configurée" : `${data.config.alertRules} règle${data.config.alertRules > 1 ? "s" : ""} active${data.config.alertRules > 1 ? "s" : ""}`} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <Section
            title={<span className="flex items-center gap-2"><Activity className="w-4 h-4 text-amber-400" /> Clients à surveiller</span>}
            tone={data.attention.some((c) => c.attention >= 50) ? "critical" : data.attention.length ? "warning" : "default"}
            action={<Link href="/portfolio" className="text-xs text-violet-400 hover:text-violet-300">Tous les clients →</Link>}
          >
            {data.attention.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500">
                {s.clientCount === 0
                  ? <>Aucun client. <Link href="/d" className="text-violet-400">Créer un dashboard client →</Link></>
                  : s.clientsWithoutData === s.clientCount
                    ? "Aucune donnée disponible — voir le détail ci-dessus."
                    : "Aucune dérive détectée sur la période."}
              </div>
            ) : (
              <div className="divide-y divide-gray-800">
                {data.attention.map((c) => (
                  <div key={c.id} className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Link href={`/portfolio/${c.id}`} className="text-sm text-white font-medium hover:text-violet-300 truncate">{c.name}</Link>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${c.attention >= 50 ? "bg-red-500/15 text-red-300" : "bg-amber-500/15 text-amber-300"}`}>{c.attention}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5 truncate" title={c.attentionReasons.join(" · ")}>
                        {c.attentionReasons.join(" · ")} · {fmtMoney(c.spend.value, c.currency)} dépensés · ROAS {fmtRoas(c.roas.value, { estimated: c.roas.estimated, unavailable: c.roas.unavailable })}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {c.metaAccountId && (
                        <Link href={`/creatives?accountId=act_${c.metaAccountId}`} className="text-xs text-gray-400 hover:text-white">Créas</Link>
                      )}
                      <Link href={`/portfolio/${c.id}`} className="inline-flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300">Fiche <ArrowRight className="w-3 h-3" /></Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section
            title={<span className="flex items-center gap-2"><AlertCircle className="w-4 h-4 text-amber-400" /> Alertes du jour</span>}
            action={<Link href="/admin/alerts" className="text-xs text-violet-400 hover:text-violet-300">{noRules ? "Créer une règle →" : "Configurer →"}</Link>}
          >
            {data.alerts.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500">
                {noRules
                  ? <>Aucune règle d&apos;alerte configurée. <Link href="/admin/alerts" className="text-violet-400">Créer une première règle →</Link> (ex. ROAS &lt; 1,5 sur 7 jours)</>
                  : "Aucune alerte ouverte — les règles actives n'ont rien déclenché."}
              </div>
            ) : (
              <div className="divide-y divide-gray-800">
                {data.alerts.slice(0, 8).map((ev) => (
                  <div key={ev.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white">{ev.message}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {ev.client ? <Link href={`/portfolio/${ev.client.id}`} className="hover:text-violet-300">{ev.client.name}</Link> : ev.clientId} · {timeAgo(ev.triggeredAt)}
                        </p>
                      </div>
                      <div className="flex gap-3 shrink-0">
                        <button type="button" onClick={() => generatePlan(ev.id)} disabled={recommendingId === ev.id} className="inline-flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300 disabled:opacity-50">
                          {recommendingId === ev.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} Plan IA
                        </button>
                        <button type="button" onClick={() => ackEvent(ev.id)} className="text-xs text-gray-400 hover:text-white">Acquitter</button>
                      </div>
                    </div>
                    {recommendations[ev.id] && (
                      <div className="mt-2 p-3 rounded-lg bg-violet-500/5 border border-violet-500/20 text-xs text-gray-200 whitespace-pre-wrap">{recommendations[ev.id]}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section
            title={<span className="flex items-center gap-2"><GitCompareArrows className="w-4 h-4 text-blue-400" /> Ce qui a changé (30 j complets vs 30 j précédents, Meta)</span>}
            action={
              changesLoading ? undefined
                : !changes ? <button type="button" onClick={() => loadChanges(false)} className="text-xs text-violet-400 hover:text-violet-300">Détecter →</button>
                : <button type="button" onClick={() => loadChanges(true)} className="text-xs text-gray-400 hover:text-white">Actualiser</button>
            }
          >
            {changesLoading ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500 flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Analyse en cours…</div>
            ) : !changes ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500">Cliquez sur « Détecter » pour analyser les mouvements de spend, ROAS, fréquence et créas.</div>
            ) : changes.events.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500">
                {changes.accountCount === 0 ? "Aucun compte Meta dans le portefeuille." : `Aucun changement significatif détecté sur ${changes.accountCount} compte${changes.accountCount > 1 ? "s" : ""}.`}
              </div>
            ) : (
              <div className="divide-y divide-gray-800">
                {changes.events.slice(0, 12).map((c, i) => {
                  const sev = c.severity === "critical" ? "bg-red-500/15 text-red-300 border-red-500/30"
                    : c.severity === "warning" ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                    : c.severity === "positive" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                    : "bg-gray-800 text-gray-300 border-gray-700";
                  return (
                    <div key={i} className="px-4 py-3 flex items-start gap-3">
                      <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border shrink-0 ${sev}`}>{c.severity}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white">{c.title}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {c.clientId ? <Link href={`/portfolio/${c.clientId}`} className="hover:text-violet-300">{c.accountLabel ?? c.accountId}</Link> : (c.accountLabel ?? c.accountId)} — {c.detail}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {changes && (changes.truncated || changes.timedOut || (changes.failures?.length ?? 0) > 0) && (
              <div className="px-4 py-2 border-t border-gray-800 text-[11px] text-amber-400/80">
                {changes.truncated && <span>Limité aux {changes.accountCount} premiers comptes sur {changes.totalAccounts}. </span>}
                {changes.timedOut && <span>Budget de temps atteint : analyse partielle. </span>}
                {(changes.failures?.length ?? 0) > 0 && <span>{changes.failures!.length} compte{changes.failures!.length > 1 ? "s" : ""} en erreur ({changes.failures!.map((f) => f.label ?? f.accountId).join(", ")}).</span>}
              </div>
            )}
          </Section>
        </div>

        <div className="space-y-4">
          <Section
            title={<span className="flex items-center gap-2"><FileText className="w-4 h-4 text-blue-400" /> Rapports IA récents</span>}
            action={<Link href="/reports?new=1" className="text-xs text-violet-400 hover:text-violet-300">Nouveau →</Link>}
          >
            {data.recentReports.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-gray-500">Aucun rapport généré. <Link href="/reports?new=1" className="text-violet-400">Générer le premier →</Link></div>
            ) : (
              <div className="divide-y divide-gray-800">
                {data.recentReports.slice(0, 8).map((r) => (
                  <Link key={r.id} href={`/reports/${r.id}`} className="block px-4 py-2.5 hover:bg-gray-800/30">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm text-white truncate">{r.clientName}</p>
                      <Pill tone={r.status === "ready" ? "emerald" : r.status === "failed" ? "red" : "blue"}>{r.status === "ready" ? "Prêt" : r.status === "failed" ? "Échec" : "En cours"}</Pill>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">
                      {r.startDate} → {r.endDate} · {timeAgo(r.createdAt)}{r.trigger === "cron" ? " · auto" : ""}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </Section>

          <Section
            title={<span className="flex items-center gap-2"><Target className="w-4 h-4 text-violet-400" /> Pacing budgets</span>}
            action={<Link href="/portfolio" className="text-xs text-violet-400 hover:text-violet-300">{noBudgets ? "Définir un budget →" : "Tous les clients →"}</Link>}
          >
            {data.pacing.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-gray-500">
                {noBudgets
                  ? <>Aucun budget mensuel configuré. Saisissez-le dans la <Link href="/portfolio" className="text-violet-400">fiche client</Link> (champ « Budget mensuel »).</>
                  : "Pacing indisponible pour les budgets configurés (comptes sans données)."}
              </div>
            ) : (
              <div className="divide-y divide-gray-800">
                {data.pacing.slice(0, 8).map((p) => (
                  <div key={p.id} className="px-4 py-3">
                    <Link href={`/portfolio/${p.id}`} className="text-sm text-white font-medium hover:text-violet-300">{p.name}</Link>
                    <div className="mt-1"><PacingBar pacing={p.pacing} /></div>
                  </div>
                ))}
                {data.pacing.every((p) => p.pacing.status === "on_track") && (
                  <div className="px-4 py-2 text-[11px] text-emerald-400/80">Pacing OK sur tous les budgets configurés.</div>
                )}
              </div>
            )}
          </Section>

          <Section title={<span className="flex items-center gap-2"><Briefcase className="w-4 h-4 text-gray-400" /> Top dépenses</span>}>
            {data.topClients.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-gray-500">Aucune donnée.</div>
            ) : (
              <div className="divide-y divide-gray-800">
                {data.topClients.map((c) => (
                  <Link key={c.id} href={`/portfolio/${c.id}`} className="flex items-center justify-between px-4 py-2 hover:bg-gray-800/30">
                    <span className="text-sm text-gray-200 truncate">{c.name}</span>
                    <span className="text-right shrink-0">
                      <span className="text-sm text-white font-semibold tabular-nums">{fmtMoney(c.spend.value, c.currency)}</span>
                      <span className="block"><DeltaBadge metric="spend" deltaPct={c.spend.deltaPct} /></span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </Section>

          {s.reportsEnabled > 0 && (
            <div className="text-[11px] text-gray-600 inline-flex items-center gap-1 px-1"><Bot className="w-3 h-3" /> {s.reportsEnabled} client{s.reportsEnabled > 1 ? "s" : ""} en rapport automatique (cron 07h UTC)</div>
          )}
        </div>
      </div>
    </div>
  );
}
