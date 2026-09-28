"use client";

/**
 * Global Cockpit — who needs attention, why, and where each client stands
 * against its monthly budget, read by day, by week or by month. Reads the latest
 * stored snapshot (built twice a day); admins can rebuild it and correct the
 * accounts attached to each client.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Settings2, Search } from "lucide-react";
import type { PeriodKind, Severity } from "@/lib/cockpit/engine";
import type { CockpitClientRow, CockpitData, EvolutionPoint } from "@/lib/cockpit/build";
import type { CockpitActionView } from "@/lib/cockpit/view";
import { COCKPIT_CFG } from "@/lib/cockpit/engine";
import {
  ACTION_LABEL, CATEGORY_LABEL, PERIOD_KINDS, SEVERITY_RANK, TXT, budgetRows, cause, kpiText, money, noKpi, pacePts, perfWorse, pct, periodWords, spendText,
  type BudgetRow, type MoneyOptions,
} from "@/lib/cockpit/display";
import { Badges, Chip, Muted, PaceGauge, SeverityBadge, Tag } from "@/components/cockpit/global-parts";
import { DiagnosticPanel } from "@/components/cockpit/global-panel";
import { CockpitConfig } from "@/components/cockpit/global-config";

type Tab = "act" | "watch" | "ok" | "all" | "budget";
type SortKey = "spend" | "perf" | "pace" | null;

const PERIOD_KEY = "impulse_cockpit_period";

interface Payload {
  data: CockpitData | null;
  periods?: PeriodKind[];
  snapshotAt: string | null;
  status: string | null;
  evolution: Record<string, EvolutionPoint[]>;
  actions: Record<string, CockpitActionView>;
  canEdit: boolean;
}

const TOP_CARDS = 5;
const eur = (v: number): string => `≈€${Math.round(v).toLocaleString("fr-FR")}`;
const select = "rounded-lg border border-gray-800 bg-gray-900 px-2 py-1.5 text-xs text-gray-200 focus:border-violet-500 focus:outline-none";

/** Level of the client one build earlier than the one shown, when it differs. */
function previousLevel(points: EvolutionPoint[] | undefined, current: Severity): Severity | null {
  if (!points || points.length < 2) return null;
  const before = points[points.length - 2];
  return before.severity !== current ? before.severity : null;
}

function ActionButton({ action, onClick, name, full }: { action: CockpitActionView | undefined; onClick: () => void; name: string; full?: boolean }) {
  const has = !!action?.state;
  const bits = has ? [ACTION_LABEL[action!.state], action!.owner, action!.due ? new Date(`${action!.due}T00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) : null].filter(Boolean) : [];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${has ? "Modifier l'action" : "Planifier une action"} pour ${name}`}
      className={`rounded-lg border px-2.5 py-1.5 text-left text-xs ${full ? "w-full" : ""} ${has ? "border-violet-700/60 bg-violet-950/40 text-violet-200" : "border-gray-800 text-gray-500 hover:border-gray-700 hover:text-gray-300"}`}
    >
      {has ? bits.join(" · ") : "Planifier une action"}
    </button>
  );
}

export function GlobalCockpit() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildNote, setBuildNote] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("act");
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("all");
  const [model, setModel] = useState("all");
  const [category, setCategory] = useState("all");
  const [trend, setTrend] = useState("all");
  const [toEur, setToEur] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: null, dir: -1 });
  const [full, setFull] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [config, setConfig] = useState(false);
  const [period, setPeriod] = useState<PeriodKind>("week");

  useEffect(() => {
    // After mount only: the reading chosen last time, kept in this browser.
    const t = setTimeout(() => {
      try {
        const saved = localStorage.getItem(PERIOD_KEY);
        if (saved === "day" || saved === "month") setPeriod(saved);
      } catch { /* storage unavailable */ }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const choosePeriod = (p: PeriodKind) => {
    setPeriod(p);
    setOpen(null);
    try { localStorage.setItem(PERIOD_KEY, p); } catch { /* storage unavailable */ }
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cockpit/global?period=${period}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      setPayload(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [period]);

  useEffect(() => { void load(); }, [load]);

  async function rebuild() {
    setBuilding(true);
    setBuildNote(null);
    try {
      const res = await fetch("/api/cockpit/global/refresh", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Erreur ${res.status}`);
      setBuildNote(json.partial ? "Actualisation partielle : relancez pour compléter les comptes restants." : `Cockpit actualisé (${json.clients} clients).`);
      await load();
    } catch (e) {
      setBuildNote(`Actualisation impossible : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBuilding(false);
    }
  }

  const data = payload?.data ?? null;
  const o: MoneyOptions = useMemo(() => ({ toEur, fx: data?.fx ?? {} }), [toEur, data]);
  const clients = useMemo(() => data?.clients ?? [], [data]);

  const counts = useMemo(() => {
    const n: Record<Severity, number> = { urgent: 0, action: 0, watch: 0, ok: 0 };
    let exposed = 0;
    for (const c of clients) {
      n[c.alert.severity]++;
      if (c.alert.severity === "urgent" || c.alert.severity === "action") exposed += c.eur_w0;
    }
    return { n, exposed };
  }, [clients]);

  const budget = useMemo(() => {
    const rows = budgetRows(clients);
    const over = rows.filter((r) => r.gap >= COCKPIT_CFG.paceBadPts).sort((a, b) => b.gap - a.gap);
    const under = rows.filter((r) => r.gap <= -COCKPIT_CFG.paceBadPts).sort((a, b) => a.gap - b.gap);
    return { rows, over, under };
  }, [clients]);

  const top = useMemo(() => clients
    .filter((c) => c.alert.severity === "urgent" || c.alert.severity === "action")
    .sort((a, b) => SEVERITY_RANK[a.alert.severity] - SEVERITY_RANK[b.alert.severity] || b.score - a.score)
    .slice(0, TOP_CARDS), [clients]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = clients.filter((c) => {
      const s = c.alert.severity;
      if (category !== "all" && c.alert.category !== category) return false;
      if (tab === "act" && s !== "urgent" && s !== "action") return false;
      if (tab === "watch" && s !== "watch") return false;
      if (tab === "ok" && s !== "ok") return false;
      if (q && !(c.name.toLowerCase().includes(q) || c.key.includes(q))) return false;
      if (platform !== "all" && !Object.values(c.platforms).some((p) => p.plat === platform)) return false;
      if (model !== "all" && c.kpi_mode !== model) return false;
      const sd = (c.blended.spend_d ?? 0) * 100;
      if (trend === "up" && sd < 15) return false;
      if (trend === "down" && sd > -15) return false;
      return true;
    });
    if (!sort.key) return list;
    const val = (c: CockpitClientRow) => sort.key === "spend" ? c.eur_w0 : sort.key === "perf" ? perfWorse(c) : c.pacing ? Math.abs(pacePts(c.pacing)) : -9;
    return [...list].sort((a, b) => (val(b) - val(a)) * -sort.dir);
  }, [clients, tab, query, platform, model, category, trend, sort]);

  if (error && !payload) return <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-200">Cockpit indisponible : {error}</div>;
  if (!payload) return <div className="flex items-center gap-2 p-6 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement du cockpit…</div>;

  if (!data) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-6 text-sm text-gray-300">
        <p className="font-semibold text-white">Le cockpit n&apos;a pas encore été calculé.</p>
        <p className="mt-1 text-gray-400">Il est construit deux fois par jour à partir de la feuille des budgets et des comptes Meta et Google Ads.</p>
        {payload.canEdit && (
          <button type="button" onClick={rebuild} disabled={building} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-60">
            {building ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {building ? "Calcul en cours, jusqu'à 4 minutes…" : "Calculer maintenant"}
          </button>
        )}
        {buildNote && <p className="mt-2 text-xs text-gray-400">{buildNote}</p>}
      </div>
    );
  }

  const words = periodWords(data.period, data.hist_weeks);
  const available = payload.periods ?? ["week"];
  const showPrio = tab === "act" && !query.trim() && top.length > 0;
  const topKeys = new Set(top.map((c) => c.key));
  const table = showPrio && !full ? filtered.filter((c) => !topKeys.has(c.key)) : filtered;
  const delta = data.tot_eur_base ? (data.tot_eur_w0 - data.tot_eur_base) / data.tot_eur_base : null;
  const nBudget = budget.over.length + budget.under.length;
  const opened = open ? clients.find((c) => c.key === open) ?? null : null;
  const title = tab === "act" ? `${showPrio && !full ? "Autres comptes" : "Comptes"} nécessitant une action (${table.length})`
    : tab === "watch" ? `À surveiller (${table.length})` : tab === "ok" ? `Comptes sains (${table.length})` : `Tous les comptes (${table.length})`;

  const tabs: Array<{ id: Tab; label: string; n: number }> = [
    { id: "act", label: "À traiter", n: counts.n.urgent + counts.n.action },
    { id: "watch", label: "À surveiller", n: counts.n.watch },
    { id: "ok", label: "Sans alerte", n: counts.n.ok },
    { id: "all", label: "Tous", n: clients.length },
    { id: "budget", label: "Budget", n: nBudget },
  ];
  const sortBy = (key: Exclude<SortKey, null>) => setSort((s) => (s.key === key ? { key, dir: s.dir === -1 ? 1 : -1 } : { key, dir: -1 }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === -1 ? " ↓" : " ↑") : "");

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">Global Cockpit</h1>
          <p className="text-xs text-gray-400">
            {words.read} {data.w0_label} · vs {words.baseLong} · actualisé le{" "}
            {new Date(data.generated).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}
            {payload.status === "partial" && <span className="ml-2 text-amber-300">· données partielles</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Période lue" className="inline-flex overflow-hidden rounded-lg border border-gray-800">
            {PERIOD_KINDS.map((p) => {
              const ready = available.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => choosePeriod(p)}
                  disabled={!ready}
                  aria-pressed={period === p}
                  title={ready ? undefined : "Disponible après la prochaine actualisation du cockpit"}
                  className={`px-3 py-1.5 text-xs font-medium ${period === p ? "bg-violet-600 text-white" : "text-gray-300 hover:bg-gray-900"} disabled:cursor-not-allowed disabled:text-gray-600`}
                >
                  {periodWords(p, 0).tab}
                </button>
              );
            })}
          </div>
          <button type="button" onClick={() => setToEur((v) => !v)} aria-pressed={toEur} className={`rounded-lg border px-2.5 py-1.5 text-xs ${toEur ? "border-violet-600 bg-violet-950/50 text-violet-200" : "border-gray-800 text-gray-300 hover:border-gray-700"}`}>
            {toEur ? "Devises : tout en €" : "Devises : locales"}
          </button>
          {payload.canEdit && (
            <>
              <button type="button" onClick={() => setConfig(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-800 px-2.5 py-1.5 text-xs text-gray-300 hover:border-gray-700">
                <Settings2 className="h-3.5 w-3.5" /> Clients et comptes
              </button>
              <button type="button" onClick={rebuild} disabled={building} className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-60">
                {building ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {building ? "Calcul en cours…" : "Actualiser"}
              </button>
            </>
          )}
        </div>
      </header>

      {buildNote && <p className="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2 text-xs text-gray-300">{buildNote}</p>}
      {data.warnings.map((w) => <p key={w} className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">{w}</p>)}

      <details className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-2 text-xs text-gray-400">
        <summary className="cursor-pointer text-gray-300">Comment lire ce cockpit</summary>
        <div className="mt-2 space-y-1">
          <p><b className="text-gray-200">À traiter</b> = Urgences + Actions requises. Urgence : intervenir aujourd&apos;hui (dégradation majeure sur un compte à fortes dépenses). Action requise : à traiter cette semaine. À surveiller : dérive naissante. Sans alerte : RAS.</p>
          <p><b className="text-gray-200">Jour, Semaine, Mois</b> : la même lecture sur la journée d&apos;hier, sur la dernière semaine complète, ou sur le mois en cours comparé aux mêmes jours des mois précédents. Les seuils en euros et en conversions suivent la durée de la période.</p>
          <p><b className="text-gray-200">Δ {words.base}</b> = vs {words.baseLong} (structurel) · <b className="text-gray-200">Δ {words.prev}</b> = vs {words.prevLong}.</p>
          <p><b className="text-gray-200">Cause</b> = composant du funnel (CPM × CTR × CVR, × AOV en ROAS) qui explique le plus la dérive.</p>
          <p><b className="text-gray-200">Rythme budgétaire</b> : jauge = % du budget mensuel dépensé, repère = attendu à ce stade du mois, écart en points. Les budgets viennent de la feuille des budgets de l&apos;agence.</p>
          <p><b className="text-gray-200">Devises</b> : chaque client dans la devise de son compte ; le bouton convertit tout en €. Les totaux du haut sont toujours en € ({data.fx_note}).</p>
        </div>
      </details>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-4">
          <p className="text-xs text-gray-400">Dépenses totales</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-white">{eur(data.tot_eur_w0)}</p>
          <p className="mt-1 text-[11px] text-gray-500">{data.w0_label} <Chip d={delta} kind="spend" label={`vs ${words.moy.toLowerCase()}`} /></p>
        </div>
        <button type="button" onClick={() => setTab("act")} className="rounded-xl border border-gray-800 bg-gray-900/60 p-4 text-left hover:border-gray-700">
          <p className="text-xs text-gray-400">Comptes prioritaires</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-white"><span className="text-red-300">{counts.n.urgent}</span> <span className="text-sm font-normal text-gray-500">urgences</span></p>
          <p className="mt-1 text-[11px] text-gray-500">{counts.n.action} en action requise</p>
        </button>
        <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-4">
          <p className="text-xs text-gray-400">Dépenses des comptes à examiner</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-white">{eur(counts.exposed)}</p>
          <p className="mt-1 text-[11px] text-gray-500">{data.tot_eur_w0 ? Math.round((counts.exposed / data.tot_eur_w0) * 100) : 0}% des dépenses totales · volume concerné, pas une estimation de perte</p>
        </div>
        <button type="button" onClick={() => setTab("budget")} disabled={!budget.rows.length} className="rounded-xl border border-gray-800 bg-gray-900/60 p-4 text-left hover:border-gray-700 disabled:opacity-60">
          <p className="text-xs text-gray-400">Urgences budget</p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${nBudget ? "text-amber-300" : "text-white"}`}>{budget.rows.length ? nBudget : "—"}</p>
          <p className="mt-1 text-[11px] text-gray-500">{budget.rows.length ? `${budget.over.length} en surdépense · ${budget.under.length} en sous-dépense` : TXT.noBudget}</p>
        </button>
      </section>

      <p className="text-[11px] text-gray-500">
        Qualité des données : {data.quality.accounts - data.quality.issues}/{data.quality.accounts} canaux actualisés · budgets du mois : {data.quality.budgeted}/{data.quality.accounts} canaux, couvrant {Math.round(data.quality.budget_coverage * 100)} % des dépenses {words.spendOf}. Les alertes budget suivent un rythme linéaire, à vérifier selon le plan média.
      </p>

      {payload.canEdit && data.unmatched.length > 0 && (
        <p className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          {data.unmatched.length} client(s) de la feuille ont un budget mais aucun compte lisible : {data.unmatched.map((u) => `${u.name} (${u.platforms.join(", ")})`).join(" · ")}.{" "}
          <button type="button" onClick={() => setConfig(true)} className="underline">Rattacher un compte</button>
        </p>
      )}

      <nav className="flex flex-wrap gap-1 border-b border-gray-800" aria-label="Vues du cockpit">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => { setTab(t.id); setFull(false); }} aria-current={tab === t.id}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.id ? "border-violet-500 text-white" : "border-transparent text-gray-400 hover:text-gray-200"}`}>
            {t.label} <span className="ml-1 rounded-full bg-gray-800 px-1.5 text-[11px] tabular-nums text-gray-300">{t.n}</span>
          </button>
        ))}
      </nav>

      {tab === "budget" ? (
        <BudgetView data={data} budget={budget} total={clients.length} o={o} onOpen={setOpen} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un client" aria-label="Rechercher un client" className={`${select} w-48 pl-7`} />
            </label>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={select} aria-label="Plateforme">
              <option value="all">Plateforme : toutes</option><option value="meta">Meta</option><option value="google">Google</option>
            </select>
            <select value={model} onChange={(e) => setModel(e.target.value)} className={select} aria-label="Modèle">
              <option value="all">Modèle : tous</option><option value="cpa">CPA</option><option value="roas">ROAS</option><option value="brand">Branding</option><option value="mixte">Mixte</option>
            </select>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={select} aria-label="Type d'alerte">
              <option value="all">Alerte : toutes</option>
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={trend} onChange={(e) => setTrend(e.target.value)} className={select} aria-label="Évolution des dépenses">
              <option value="all">Dépenses : toutes</option><option value="up">En hausse ≥15%</option><option value="down">En baisse ≥15%</option>
            </select>
          </div>

          {showPrio && (
            <section>
              <h2 className="text-sm font-semibold text-white">Priorités du jour</h2>
              <p className="text-xs text-gray-400">Les comptes qui nécessitent une action immédiate, classés par urgence, motif explicite.</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {top.map((c) => {
                  const ca = cause(c);
                  const before = previousLevel(payload.evolution[c.key], c.alert.severity);
                  return (
                    <article key={c.key} className={`rounded-xl border bg-gray-900/60 p-4 ${c.alert.severity === "urgent" ? "border-red-500/40" : "border-amber-500/30"}`}>
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-semibold text-white">
                          <button type="button" onClick={() => setOpen(c.key)} className="hover:underline">{c.name}</button>
                          <Badges c={c} />
                        </h3>
                        <SeverityBadge severity={c.alert.severity} />
                      </div>
                      <p className="mt-2 text-sm text-gray-200">{c.alert.reason}</p>
                      <p className="mt-1 text-xs text-gray-400">{ca ? <>Signal à vérifier : <b className="text-red-300">{ca.txt}</b> ({ca.where})</> : `Cause : ${TXT.noCause.toLowerCase()}`}</p>
                      <p className="mt-1 text-xs text-gray-500">{spendText(c, o)} de dépenses {words.here}{before ? ` · niveau précédent : ${before === "ok" ? "sans alerte" : before === "watch" ? "à surveiller" : before === "action" ? "action requise" : "urgence"}` : ""}</p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button type="button" onClick={() => setOpen(c.key)} className="rounded-lg bg-violet-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-violet-500">Ouvrir le diagnostic</button>
                        <ActionButton action={payload.actions[c.key]} onClick={() => setOpen(c.key)} name={c.name} />
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-white">{title}</h2>
              {showPrio && (
                <button type="button" onClick={() => setFull((v) => !v)} className="text-xs text-violet-300 hover:text-violet-200">
                  {full ? "Masquer le Top 5 du tableau" : "Afficher la liste complète (Top 5 inclus)"}
                </button>
              )}
            </div>

            <div className="hidden overflow-x-auto rounded-xl border border-gray-800 lg:block">
              <table className="w-full text-sm">
                <thead className="bg-gray-900/80 text-left text-[11px] uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Client</th>
                    <th className="px-3 py-2 font-medium">Niveau</th>
                    <th className="px-3 py-2 text-right font-medium"><button type="button" onClick={() => sortBy("spend")} className="hover:text-gray-300">{words.spend}{arrow("spend")}</button></th>
                    <th className="px-3 py-2 text-right font-medium"><button type="button" onClick={() => sortBy("perf")} className="hover:text-gray-300">CPA / ROAS{arrow("perf")}</button></th>
                    <th className="px-3 py-2 font-medium">Cause principale</th>
                    <th className="px-3 py-2 font-medium"><button type="button" onClick={() => sortBy("pace")} className="hover:text-gray-300">Rythme budgétaire{arrow("pace")}</button></th>
                    <th className="px-3 py-2 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/70">
                  {table.map((c) => {
                    const r = c.blended;
                    const ca = cause(c);
                    const before = previousLevel(payload.evolution[c.key], c.alert.severity);
                    return (
                      <tr key={c.key} className="align-top hover:bg-gray-900/40">
                        <td className="px-3 py-2.5">
                          <button type="button" onClick={() => setOpen(c.key)} className="font-medium text-white hover:underline">{c.name}</button>
                          <Badges c={c} />
                        </td>
                        <td className="px-3 py-2.5">
                          <SeverityBadge severity={c.alert.severity} />
                          {before && <div className="mt-1 text-[10px] text-gray-500">avant : {before === "ok" ? "sans alerte" : before === "watch" ? "à surveiller" : before === "action" ? "action requise" : "urgence"}</div>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          <b className="text-white">{spendText(c, o)}</b> <Chip d={r.spend_d} kind="spend" label={words.base} />
                          {!c.mixed && <div className="mt-0.5 text-[11px] text-gray-500">{words.moy} {money(r.spend_base, c.ccy, o)} · {words.prev} {pct(r.spend_d_wow)}</div>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          <b className="text-white">{noKpi(c.kpi_mode) ? <Muted>{c.kpi_mode === "brand" ? TXT.brand : TXT.mixte}</Muted> : kpiText(r.kpi, c.kpi_mode, c.ccy, o)}</b>{" "}
                          {r.zero_conv ? <Tag className="bg-red-500/20 text-red-300">0 conv</Tag>
                            : noKpi(c.kpi_mode) ? null
                            : r.low_vol ? <Muted>{TXT.lowVol} · {Math.round(r.conv)} conv</Muted>
                            : <Chip d={r.kpi_d} kind="perf" label={words.base} mode={c.kpi_mode} />}
                          {c.kpi_mode === "mixte" ? <div className="mt-0.5 text-[11px] text-gray-500">voir le détail par canal</div>
                            : c.kpi_mode !== "brand" && r.kpi_base !== null ? <div className="mt-0.5 text-[11px] text-gray-500">{words.moy} {kpiText(r.kpi_base, c.kpi_mode, c.ccy, o)} · {words.prev} {pct(r.kpi_d_wow)}</div> : null}
                        </td>
                        <td className="px-3 py-2.5 text-xs">
                          {ca ? <><b className="text-red-300">{ca.txt}</b><br /><Muted>{ca.where}</Muted></>
                            : <Muted>{c.alert.severity === "ok" ? "RAS" : r.n_base < 2 ? TXT.noData : TXT.noCause}</Muted>}
                        </td>
                        <td className="px-3 py-2.5"><PaceGauge p={c.pacing} /></td>
                        <td className="px-3 py-2.5"><ActionButton action={payload.actions[c.key]} onClick={() => setOpen(c.key)} name={c.name} /></td>
                      </tr>
                    );
                  })}
                  {!table.length && <tr><td colSpan={7} className="px-3 py-7 text-center text-sm text-gray-500">Aucun compte dans cette vue</td></tr>}
                </tbody>
              </table>
            </div>

            <div className="space-y-2 lg:hidden">
              {table.map((c) => {
                const r = c.blended;
                const ca = cause(c);
                return (
                  <article key={c.key} className="space-y-2 rounded-xl border border-gray-800 bg-gray-900/60 p-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <button type="button" onClick={() => setOpen(c.key)} className="text-left font-medium text-white hover:underline">{c.name}</button>
                      <SeverityBadge severity={c.alert.severity} />
                    </div>
                    <div className="flex items-center justify-between gap-2"><Muted>{words.spend}</Muted><span className="tabular-nums"><b className="text-white">{spendText(c, o)}</b> <Chip d={r.spend_d} kind="spend" label={words.base} /></span></div>
                    <div className="flex items-center justify-between gap-2"><Muted>CPA / ROAS</Muted><span className="tabular-nums"><b className="text-white">{noKpi(c.kpi_mode) ? (c.kpi_mode === "brand" ? TXT.brand : TXT.mixte) : kpiText(r.kpi, c.kpi_mode, c.ccy, o)}</b> {noKpi(c.kpi_mode) || r.low_vol ? null : <Chip d={r.kpi_d} kind="perf" label={words.base} mode={c.kpi_mode} />}</span></div>
                    {ca && <div className="flex items-center justify-between gap-2"><Muted>Cause</Muted><span><b className="text-red-300">{ca.txt}</b> <Muted>{ca.where}</Muted></span></div>}
                    {c.pacing && <div className="flex items-center justify-between gap-2"><Muted>Rythme budgétaire</Muted><PaceGauge p={c.pacing} /></div>}
                    <ActionButton action={payload.actions[c.key]} onClick={() => setOpen(c.key)} name={c.name} full />
                  </article>
                );
              })}
              {!table.length && <p className="rounded-xl border border-gray-800 p-6 text-center text-sm text-gray-500">Aucun compte dans cette vue</p>}
            </div>
          </section>
        </>
      )}

      {opened && (
        <DiagnosticPanel
          key={opened.key}
          client={opened}
          starts={data.week_starts}
          words={words}
          evolution={payload.evolution[opened.key] ?? []}
          action={payload.actions[opened.key] ?? null}
          o={o}
          onClose={() => setOpen(null)}
          onSaved={(key, action) => setPayload((p) => (p ? { ...p, actions: { ...p.actions, [key]: action } } : p))}
        />
      )}
      {config && <CockpitConfig onClose={() => setConfig(false)} />}
    </div>
  );
}

function BudgetView({ data, budget, total, o, onOpen }: {
  data: CockpitData;
  budget: { rows: BudgetRow[]; over: BudgetRow[]; under: BudgetRow[] };
  total: number;
  o: MoneyOptions;
  onOpen: (key: string) => void;
}) {
  const flagged = [...budget.over, ...budget.under];
  const inPace = budget.rows.length - flagged.length;
  const month = new Date(`${data.month}-01T00:00`).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  const signed = (v: number, ccy: string | null) => `${v >= 0 ? "+" : "−"}${money(Math.abs(v), ccy, o)}`;

  const row = (r: BudgetRow) => {
    const cls = r.gap > 0 ? "text-red-300" : "text-amber-300";
    const diff = r.projection === null ? null : r.projection - r.p.budget;
    return (
      <tr key={r.c.key} className="align-top hover:bg-gray-900/40">
        <td className="px-3 py-2.5"><button type="button" onClick={() => onOpen(r.c.key)} className="font-medium text-white hover:underline">{r.c.name}</button> <Tag>{r.c.ccy ?? "—"}</Tag></td>
        <td className="px-3 py-2.5 text-right tabular-nums">{money(r.p.budget, r.c.ccy, o)}</td>
        <td className="px-3 py-2.5 text-right tabular-nums"><b className="text-white">{money(r.p.mtd, r.c.ccy, o)}</b><div className="text-[11px] text-gray-500">{Math.round(r.p.pct_spent * 100)}% vs {Math.round(r.p.pct_month * 100)}% attendu</div></td>
        <td className="px-3 py-2.5"><PaceGauge p={r.p} /></td>
        <td className="px-3 py-2.5 text-right tabular-nums"><span className={cls}>{signed(r.gapAmount, r.c.ccy)}</span><div className="text-[11px] text-gray-500">{r.gap > 0 ? "+" : ""}{Math.round(r.gap)} pts</div></td>
        <td className="px-3 py-2.5 text-right tabular-nums">
          {r.projection === null || diff === null ? <Muted>{TXT.noData}</Muted> : (
            <><b className="text-white">{money(r.projection, r.c.ccy, o)}</b><div className="text-[11px] text-gray-500"><span className={Math.abs(diff) / r.p.budget >= 0.12 ? cls : ""}>{signed(diff, r.c.ccy)}</span> vs budget</div></>
          )}
        </td>
      </tr>
    );
  };
  const group = (label: string, severity: Severity, rows: BudgetRow[]) => rows.length ? (
    <>
      <tr className="bg-gray-900/70"><td colSpan={6} className="px-3 py-1.5"><SeverityBadge severity={severity} label={`${label} (${rows.length})`} /></td></tr>
      {rows.map(row)}
    </>
  ) : null;

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-white">Urgences budgétaires ({flagged.length}) — {month}</h2>
      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-gray-900/80 text-left text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 font-medium">Client</th>
              <th className="px-3 py-2 text-right font-medium">Budget mensuel</th>
              <th className="px-3 py-2 text-right font-medium">Dépensé</th>
              <th className="px-3 py-2 font-medium">Rythme</th>
              <th className="px-3 py-2 text-right font-medium">Écart vs attendu</th>
              <th className="px-3 py-2 text-right font-medium">Projection fin de mois</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/70">
            {group("En surdépense", "urgent", budget.over)}
            {group("En sous-dépense", "action", budget.under)}
            {!flagged.length && <tr><td colSpan={6} className="px-3 py-7 text-center text-sm text-gray-500">Tous les comptes budgétés sont dans les clous</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">
        {inPace} autres comptes budgétés dans les clous (écart &lt; {COCKPIT_CFG.paceBadPts} pts) · {total - budget.rows.length} clients sans budget renseigné · dépensé du 1ᵉʳ du mois à hier · projection = rythme actuel maintenu jusqu&apos;à la fin du mois · budgets Meta et Google de la feuille des budgets.
      </p>
    </section>
  );
}
