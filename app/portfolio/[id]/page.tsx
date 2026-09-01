"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ExternalLink, FileText, Loader2, Sparkles, Bot, Target } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Pill, Section } from "@/components/ui/surface";
import { DeltaBadge, PacingBar } from "@/components/portfolio/kpi-delta";
import { errorKindLabel, fmtMetric, fmtMoney, fmtNumber, fmtRoas } from "@/components/portfolio/format";
import { Freshness, KpiUnavailable } from "@/components/portfolio/freshness";
import { SourcesPanel } from "@/components/portfolio/sources-panel";
import { CrmAttributionCard } from "@/components/portfolio/crm-attribution-card";
import type { CrmAttributionData } from "@/components/portfolio/crm-types";
import { validateRange } from "@/lib/date-ranges";
import type { PacingResult } from "@/lib/budgets";

interface KpiData { metric: string; source: string; value: number; previous: number | null; deltaPct: number | null; estimated?: boolean; unavailable?: boolean; currency?: string; partial?: boolean; errors?: string[] }
interface ClientSheet {
  client: {
    id: string; name: string; metaAccountId: string | null; googleCustomerId: string | null; reportFrequency: string | null;
    owner: { id: string; name: string | null; email: string | null };
    members: Array<{ id: string; name: string | null; email: string | null }>;
    dashboardIds: string[]; duplicates: number; currency: string | null; timezone: string | null;
    monthlyBudget: number | null; budgetCurrency: string | null; budgetSource: string | null; budgetDashboardId: string;
  };
  range: { since: string; until: string };
  rangeLabel: string;
  partialDay: boolean;
  compare: { since: string; until: string };
  data: Record<string, unknown>;
  errors: Record<string, string>;
  error: { kind: string; message: string } | null;
  fetchedAt: string | null;
  generatedAt: string;
  /** Full HubSpot attribution payload — absent when the client has no HubSpot source. */
  crm?: CrmAttributionData;
  reports: Array<{ id: string; title: string; status: string; periodSince: string; periodUntil: string; createdAt: string; trigger: string; nextStepsCount: number; nextStepsDone: number }>;
}

const KPI_LABELS: Record<string, string> = { spend: "Dépenses", revenue: "Revenu", roas: "ROAS", purchases: "Conversions", cpa: "CPA", ctr: "CTR", cpc: "CPC", cr: "Taux de conv." };
const KPI_ORDER = ["spend", "revenue", "roas", "purchases", "cpa", "ctr", "cpc", "cr"];

const fmtDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });

function Toast({ message, tone, onClose }: { message: string; tone: "error" | "ok"; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 5000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div className={`fixed bottom-4 right-4 z-50 rounded-lg px-4 py-2.5 text-sm shadow-lg border ${tone === "error" ? "bg-red-950 border-red-800 text-red-200" : "bg-emerald-950 border-emerald-800 text-emerald-200"}`} role="status">
      {message}
    </div>
  );
}

export default function ClientSheetPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const since = params.get("since") ?? "";
  const until = params.get("until") ?? "";
  const [sheet, setSheet] = useState<ClientSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingFreq, setSavingFreq] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "error" | "ok" } | null>(null);
  // Date inputs are debounced: local draft, applied on blur / Enter.
  const [draft, setDraft] = useState<{ since: string; until: string }>({ since, until });
  const [rangeError, setRangeError] = useState<string | null>(null);
  // Budget inline field
  const [budgetDraft, setBudgetDraft] = useState<{ amount: string; currency: string }>({ amount: "", currency: "" });
  const [savingBudget, setSavingBudget] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async (refresh = false) => {
    const myId = ++requestId.current;
    if (refresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (since && until) { qs.set("since", since); qs.set("until", until); }
      if (refresh) qs.set("refresh", "1");
      const res = await fetch(`/api/portfolio/${id}${qs.size ? `?${qs}` : ""}`, { cache: "no-store" });
      if (myId !== requestId.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? (res.status === 404 ? "Client introuvable" : `Erreur ${res.status}`));
      }
      const json: ClientSheet = await res.json();
      setSheet(json);
      setDraft({ since: json.range.since, until: json.range.until });
      setBudgetDraft({ amount: json.client.monthlyBudget != null ? String(json.client.monthlyBudget) : "", currency: json.client.budgetCurrency ?? json.client.currency ?? "" });
    } catch (e) {
      if (myId !== requestId.current) return;
      setError(e instanceof Error ? e.message : "Erreur");
    } finally {
      if (myId === requestId.current) { setLoading(false); setRefreshing(false); }
    }
  }, [id, since, until]);

  useEffect(() => { void load(false); }, [load]);

  async function setFrequency(value: string) {
    if (!sheet) return;
    setSavingFreq(true);
    try {
      const res = await fetch(`/api/dashboards/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportFrequency: value === "none" ? null : value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Erreur ${res.status}`);
      }
      setSheet({ ...sheet, client: { ...sheet.client, reportFrequency: value === "none" ? null : value } });
      setToast({ message: "Rapport automatique mis à jour", tone: "ok" });
    } catch (e) {
      setToast({ message: `Impossible d'enregistrer la fréquence : ${e instanceof Error ? e.message : "erreur"}`, tone: "error" });
    } finally {
      setSavingFreq(false);
    }
  }

  async function saveBudget() {
    if (!sheet) return;
    const amount = budgetDraft.amount.trim();
    const currency = budgetDraft.currency.trim().toUpperCase();
    if (amount && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
      setToast({ message: "Le budget mensuel doit être un nombre > 0", tone: "error" });
      return;
    }
    if (amount && currency && !/^[A-Z]{3}$/.test(currency)) {
      setToast({ message: "Devise invalide (code ISO à 3 lettres, ex. EUR)", tone: "error" });
      return;
    }
    const current = sheet.client.monthlyBudget != null ? String(sheet.client.monthlyBudget) : "";
    if (amount === current && (currency || "") === (sheet.client.budgetCurrency ?? sheet.client.currency ?? "")) return;
    setSavingBudget(true);
    try {
      const res = await fetch(`/api/portfolio/${sheet.client.budgetDashboardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyBudget: amount ? Number(amount) : null, budgetCurrency: amount ? (currency || null) : null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Erreur ${res.status}`);
      }
      setToast({ message: amount ? "Budget mensuel enregistré" : "Budget mensuel supprimé", tone: "ok" });
      void load(false);
    } catch (e) {
      setToast({ message: `Impossible d'enregistrer le budget : ${e instanceof Error ? e.message : "erreur"}`, tone: "error" });
    } finally {
      setSavingBudget(false);
    }
  }

  function applyDraft() {
    if (!sheet) return;
    if (draft.since === sheet.range.since && draft.until === sheet.range.until) { setRangeError(null); return; }
    const v = validateRange(draft.since, draft.until);
    if (!v.ok) { setRangeError(v.error); return; }
    setRangeError(null);
    router.push(`/portfolio/${id}?since=${v.range.since}&until=${v.range.until}`);
  }

  if (error && !sheet) return (
    <div className="p-6 space-y-3">
      <Link href="/portfolio" className="text-sm text-gray-400 hover:text-white inline-flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Clients</Link>
      <div className="text-red-400 text-sm">{error}</div>
      <button type="button" onClick={() => load(false)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white">Réessayer</button>
    </div>
  );
  if (!sheet) return <div className="p-6 flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement de la fiche client…</div>;

  const c = sheet.client;
  const d = sheet.data;
  const cur = c.currency;
  const kpis = KPI_ORDER.map((m) => ({ metric: m, data: d[`kpi:${m}`] as KpiData | undefined, error: sheet.errors[`kpi:${m}`] }));
  const platforms = d.platforms as { rows: Array<Record<string, number | string | null>> } | undefined;
  const dailyMeta = (d["daily:meta"] as { points: Array<{ date: string; value: number }> } | undefined)?.points ?? [];
  const dailyGoogle = (d["daily:google"] as { points: Array<{ date: string; value: number }> } | undefined)?.points ?? [];
  const chart = mergeDaily(dailyMeta, dailyGoogle);
  const campaignsMeta = (d["campaigns:meta"] as { rows: Array<{ name: string; spend: number; clicks: number; conversions: number; roas: number }> } | undefined)?.rows ?? [];
  const campaignsGoogle = (d["campaigns:google"] as { rows: Array<{ name: string; spend: number; clicks: number; conversions: number; roas: number }> } | undefined)?.rows ?? [];
  const creatives = (d.creatives as { creatives: Array<{ adId: string; name: string; imageUrl: string | null; spend: number; ctr: number; hookRate: number; roas: number; cpa: number; estimated: boolean }> } | undefined)?.creatives ?? [];
  const pacing = d.pacing as PacingResult | undefined;
  const alerts = (d.alerts as { events: Array<{ id: string; metric: string; message: string; triggeredAt: string; acknowledged: boolean }> } | undefined)?.events ?? [];
  const funnel = d.funnel as { steps: Array<{ label: string; value: number }>; rates: Array<{ label: string; pct: number }> } | undefined;
  const rangeQs = `?since=${sheet.range.since}&until=${sheet.range.until}`;

  const btn = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border bg-gray-900 border-gray-800 text-gray-300 hover:text-white hover:border-gray-700 transition-colors";
  const dateInput = "bg-transparent text-xs text-gray-300 focus:outline-none [color-scheme:dark]";

  return (
    <div className={`p-6 space-y-6 max-w-7xl mx-auto ${refreshing || loading ? "opacity-80" : ""}`}>
      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Link href="/portfolio" className="text-sm text-gray-400 hover:text-white inline-flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Clients</Link>
        <div className="flex items-center gap-2 flex-wrap">
          <div className={`flex items-center gap-1 rounded-lg border px-2 py-1 ${rangeError ? "border-red-700 bg-red-950/30" : "border-gray-800 bg-gray-900"}`} title="Appliqué à la sortie du champ ou avec Entrée">
            <input type="date" value={draft.since} max={draft.until || undefined} onChange={(e) => setDraft((x) => ({ ...x, since: e.target.value }))} onBlur={applyDraft} onKeyDown={(e) => { if (e.key === "Enter") applyDraft(); }} className={dateInput} />
            <span className="text-gray-600 text-xs">→</span>
            <input type="date" value={draft.until} min={draft.since || undefined} onChange={(e) => setDraft((x) => ({ ...x, until: e.target.value }))} onBlur={applyDraft} onKeyDown={(e) => { if (e.key === "Enter") applyDraft(); }} className={dateInput} />
          </div>
          <Link href={`/d/${c.id}${rangeQs}`} className={btn}><ExternalLink className="w-3.5 h-3.5" /> Dashboard client</Link>
          {c.metaAccountId && <Link href={`/creatives?accountId=act_${c.metaAccountId}`} className={btn}><Sparkles className="w-3.5 h-3.5" /> Analyse créas</Link>}
          <Link href={`/reports?new=1&dashboardId=${c.id}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white"><FileText className="w-3.5 h-3.5" /> Rapport IA</Link>
        </div>
      </div>
      {rangeError && <div className="text-xs text-red-400 -mt-4">{rangeError}</div>}

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">{c.name}</h1>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap text-xs text-gray-500">
            {c.metaAccountId && <Pill tone="blue">Meta · {c.metaAccountId}</Pill>}
            {c.googleCustomerId && <Pill tone="emerald">Google · {c.googleCustomerId}</Pill>}
            {cur && <Pill>{cur}</Pill>}
            {c.duplicates > 0 && <Pill tone="amber" className="cursor-help">{c.duplicates + 1} dashboards fusionnés</Pill>}
            <span>Accès : {c.owner.name ?? c.owner.email}{c.members.length > 0 ? ` + ${c.members.map((m) => m.name ?? m.email).join(", ")}` : ""}</span>
          </div>
          <Freshness className="mt-2" rangeLabel={sheet.rangeLabel} fetchedAt={sheet.fetchedAt ?? sheet.generatedAt} onRefresh={() => load(true)} refreshing={refreshing} />
        </div>
        <div className="flex flex-col items-end gap-2">
          <label className="text-xs text-gray-400 inline-flex items-center gap-2">
            <Bot className="w-4 h-4 text-violet-400" /> Rapport automatique
            <select
              value={c.reportFrequency ?? "none"}
              disabled={savingFreq}
              onChange={(e) => setFrequency(e.target.value)}
              className="bg-gray-900 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-violet-500 disabled:opacity-60"
            >
              <option value="none">désactivé</option>
              <option value="weekly">chaque lundi (7 derniers jours)</option>
              <option value="monthly">le 1er du mois (mois précédent)</option>
            </select>
          </label>
          {c.metaAccountId && (
            <label className="text-xs text-gray-400 inline-flex items-center gap-2" title="Budget média mensuel du client — alimente le pacing du portefeuille et du dashboard client">
              <Target className="w-4 h-4 text-violet-400" /> Budget mensuel
              <input
                type="number"
                min={0}
                step="100"
                placeholder="—"
                value={budgetDraft.amount}
                disabled={savingBudget}
                onChange={(e) => setBudgetDraft((b) => ({ ...b, amount: e.target.value }))}
                onBlur={saveBudget}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                className="w-28 bg-gray-900 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-white text-right tabular-nums focus:outline-none focus:border-violet-500 disabled:opacity-60"
              />
              <input
                type="text"
                maxLength={3}
                placeholder={cur ?? "EUR"}
                value={budgetDraft.currency}
                disabled={savingBudget}
                onChange={(e) => setBudgetDraft((b) => ({ ...b, currency: e.target.value.toUpperCase() }))}
                onBlur={saveBudget}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                className="w-14 bg-gray-900 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-white uppercase focus:outline-none focus:border-violet-500 disabled:opacity-60"
              />
              {savingBudget && <Loader2 className="w-3 h-3 animate-spin" />}
              {!savingBudget && c.budgetSource === "account_budget" && <span className="text-[10px] text-gray-600" title="Budget hérité d'un objectif défini dans Mes budgets ; saisir un montant ici le remplace">hérité</span>}
            </label>
          )}
        </div>
      </header>

      {sheet.error && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          Données indisponibles — {errorKindLabel(sheet.error.kind)} <span className="text-amber-400/60 text-xs">({sheet.error.message})</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {kpis.map(({ metric, data: k, error: err }) => {
          if (!k) return <KpiUnavailable key={metric} label={KPI_LABELS[metric] ?? metric} reason={err} />;
          const unavailable = !!k.unavailable;
          return (
            <div key={metric} className={`bg-gray-900 border border-gray-800 rounded-xl px-3 py-2.5 ${unavailable ? "opacity-70" : ""}`} title={k.partial ? k.errors?.join(" · ") : undefined}>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">{KPI_LABELS[metric] ?? metric}{k.estimated && !unavailable ? " *" : ""}{k.partial ? " (partiel)" : ""}</div>
              <div className={`text-lg font-bold tabular-nums mt-0.5 ${unavailable ? "text-gray-500" : "text-white"}`}>
                {fmtMetric(metric, k.value, k.currency ?? cur, { estimated: k.estimated, unavailable })}
              </div>
              {unavailable ? (
                <div className="text-[11px] text-gray-600">revenu non tracké, pas de panier moyen</div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <DeltaBadge metric={metric} deltaPct={k.deltaPct} />
                  {k.previous !== null && <span className="text-[11px] text-gray-600">vs {fmtMetric(metric, k.previous, k.currency ?? cur, { estimated: k.estimated })}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Section title="Dépenses quotidiennes" className="lg:col-span-2" bodyClassName="p-3">
          {chart.length === 0 ? (
            <div className="text-xs text-gray-500 px-2 py-8 text-center">Aucune donnée quotidienne{sheet.errors["daily:meta"] ? ` — ${sheet.errors["daily:meta"]}` : ""}</div>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gMeta" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.4} /><stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} /></linearGradient>
                    <linearGradient id="gGoogle" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#10b981" stopOpacity={0.4} /><stop offset="100%" stopColor="#10b981" stopOpacity={0} /></linearGradient>
                  </defs>
                  <XAxis dataKey="date" tickFormatter={fmtDay} tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => fmtMoney(Number(v), cur, { digits: 0 })} />
                  <Tooltip
                    contentStyle={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 8, fontSize: 12 }}
                    labelFormatter={(l) => fmtDay(String(l))}
                    formatter={(v, name) => [fmtMoney(Number(v ?? 0), cur, { digits: 0 }), String(name) === "meta" ? "Meta" : "Google"]}
                  />
                  {dailyMeta.length > 0 && <Area type="monotone" dataKey="meta" stroke="#8b5cf6" fill="url(#gMeta)" strokeWidth={2} dot={false} />}
                  {dailyGoogle.length > 0 && <Area type="monotone" dataKey="google" stroke="#10b981" fill="url(#gGoogle)" strokeWidth={2} dot={false} />}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>

        <div className="space-y-4">
          <Section title="Suivi du budget mensuel" bodyClassName="p-4">
            {pacing ? <PacingBar pacing={pacing} /> : (
              <p className="text-xs text-gray-500">
                {sheet.errors.pacing?.includes("Aucun budget") || !sheet.errors.pacing
                  ? <>Aucun budget mensuel configuré. Saisissez-le dans le champ « Budget mensuel » ci-dessus.</>
                  : <>Pacing indisponible — {sheet.errors.pacing}</>}
              </p>
            )}
          </Section>
          {funnel && (
            <Section title="Entonnoir" bodyClassName="p-4">
              <div className="flex items-end justify-between gap-2">
                {funnel.steps.map((s) => (
                  <div key={s.label} className="text-center flex-1">
                    <div className="text-sm font-bold text-white tabular-nums">{fmtNumber(s.value)}</div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wide">{s.label}</div>
                  </div>
                ))}
              </div>
              <div className="flex justify-around mt-2 text-[11px] text-gray-400">
                {funnel.rates.map((r) => <span key={r.label}>{r.label} {r.pct} %</span>)}
              </div>
            </Section>
          )}
        </div>
      </div>

      {platforms?.rows?.length ? (
        <Section title="Vue par plateforme" bodyClassName="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-950/50">
              <tr>
                {["Plateforme", "Coût", "Impr.", "CTR", "Clics", "CPC", "CR", "Conv.", "CPA"].map((h, i) => (
                  <th key={h} className={`px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide ${i === 0 ? "text-left" : "text-right"}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {platforms.rows.map((r) => (
                <tr key={String(r.platform)} className="border-t border-gray-800">
                  <td className="px-3 py-2 text-white font-medium">{String(r.platform)}</td>
                  {(["cost", "impressions", "ctr", "clicks", "cpc", "cr", "conversions", "cpa"] as const).map((k) => (
                    <td key={k} className="px-3 py-2 text-right tabular-nums">
                      <div className="text-gray-200">{fmtMetric(k === "cost" ? "spend" : k === "conversions" ? "purchases" : k, Number(r[k] ?? 0), (r.currency as string | null) ?? cur)}</div>
                      <DeltaBadge metric={k === "cost" ? "spend" : k} deltaPct={(r[`${k}DeltaPct`] as number | null) ?? null} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      <div className="grid lg:grid-cols-2 gap-4">
        {[{ label: "Campagnes Meta", rows: campaignsMeta, err: sheet.errors["campaigns:meta"] }, { label: "Campagnes Google Ads", rows: campaignsGoogle, err: sheet.errors["campaigns:google"] }]
          .filter((t) => t.rows.length > 0 || t.err)
          .map((t) => (
            <Section key={t.label} title={t.label} bodyClassName="overflow-x-auto">
              {t.err ? <div className="px-4 py-6 text-xs text-gray-500">{t.err}</div> : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-950/50">
                    <tr>
                      <th className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase">Campagne</th>
                      <th className="text-right px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase">Dépenses</th>
                      <th className="text-right px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase">Conv.</th>
                      <th className="text-right px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase">ROAS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.rows.map((r) => (
                      <tr key={r.name} className={`border-t border-gray-800 ${r.spend > 50 && r.conversions === 0 ? "bg-red-500/5" : ""}`}>
                        <td className="px-3 py-2 text-gray-200 truncate max-w-[260px]" title={r.name}>{r.name}</td>
                        <td className="px-3 py-2 text-right text-white tabular-nums">{fmtMoney(r.spend, cur)}</td>
                        <td className="px-3 py-2 text-right text-gray-300 tabular-nums">{fmtNumber(r.conversions)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${r.roas >= 2 ? "text-emerald-400" : r.roas > 0 && r.roas < 1 ? "text-red-400" : "text-gray-300"}`}>{fmtRoas(r.roas)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          ))}
      </div>

      {creatives.length > 0 && (
        <Section title="Top créas Meta (par dépense)" action={c.metaAccountId ? <Link href={`/creatives?accountId=act_${c.metaAccountId}`} className="text-xs text-violet-400 hover:text-white">Analyse créas →</Link> : undefined} bodyClassName="p-3">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
            {creatives.map((cr) => (
              <div key={cr.adId} className="bg-gray-950 border border-gray-800 rounded-lg overflow-hidden">
                <div className="aspect-square bg-gray-900">
                  {cr.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/media/proxy-image?url=${encodeURIComponent(cr.imageUrl)}&upgrade=1`} alt="" className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="px-2 py-1.5">
                  <div className="text-[10px] text-gray-300 truncate" title={cr.name}>{cr.name}</div>
                  <div className="text-[10px] text-gray-500 tabular-nums">{fmtMoney(cr.spend, cur)} · ROAS {fmtRoas(cr.roas, { estimated: cr.estimated })} · hook {cr.hookRate} %</div>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      <SourcesPanel dashboardId={c.id} onToast={setToast} />

      <CrmAttributionCard crm={sheet.crm} error={sheet.errors.crm} currency={cur} refreshing={refreshing} onRefresh={() => load(true)} />

      <div className="grid lg:grid-cols-2 gap-4">
        <Section title="Rapports IA" action={<Link href={`/reports?dashboardId=${c.id}`} className="text-xs text-violet-400 hover:text-white">Tous →</Link>}>
          {sheet.reports.length === 0 ? (
            <div className="px-4 py-6 text-xs text-gray-500">Aucun rapport pour ce client. <Link href={`/reports?new=1&dashboardId=${c.id}`} className="text-violet-400">Générer le premier →</Link></div>
          ) : (
            <div className="divide-y divide-gray-800">
              {sheet.reports.slice(0, 6).map((r) => (
                <Link key={r.id} href={`/reports/${r.id}`} className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-800/30">
                  <div className="min-w-0">
                    <div className="text-sm text-white truncate">{r.title}</div>
                    <div className="text-[11px] text-gray-500">{new Date(r.createdAt).toLocaleDateString("fr-FR")}{r.trigger === "cron" ? " · automatique" : ""}{r.nextStepsCount > 0 ? ` · ${r.nextStepsDone}/${r.nextStepsCount} actions` : ""}</div>
                  </div>
                  <Pill tone={r.status === "ready" ? "emerald" : r.status === "failed" ? "red" : "blue"}>{r.status === "ready" ? "Prêt" : r.status === "failed" ? "Échec" : "En cours"}</Pill>
                </Link>
              ))}
            </div>
          )}
        </Section>
        <Section title="Dernières alertes">
          {alerts.length === 0 ? (
            <div className="px-4 py-6 text-xs text-gray-500">Aucune alerte sur ce client.</div>
          ) : (
            <div className="divide-y divide-gray-800">
              {alerts.map((a) => (
                <div key={a.id} className={`px-4 py-2.5 ${a.acknowledged ? "opacity-60" : ""}`}>
                  <div className="text-sm text-white">{a.message}</div>
                  <div className="text-[11px] text-gray-500">{new Date(a.triggeredAt).toLocaleString("fr-FR")}{a.acknowledged ? " · acquittée" : ""}</div>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      {Object.keys(sheet.errors).length > 0 && (
        <Card padded className="text-[11px] text-gray-500">
          <details>
            <summary className="cursor-pointer">Données indisponibles ({Object.keys(sheet.errors).length})</summary>
            <ul className="mt-1 space-y-0.5">{Object.entries(sheet.errors).map(([k, v]) => <li key={k}>{k} : {v}</li>)}</ul>
          </details>
        </Card>
      )}
    </div>
  );
}

function mergeDaily(meta: Array<{ date: string; value: number }>, google: Array<{ date: string; value: number }>) {
  const byDate = new Map<string, { date: string; meta?: number; google?: number }>();
  for (const p of meta) byDate.set(p.date, { ...(byDate.get(p.date) ?? { date: p.date }), meta: p.value });
  for (const p of google) byDate.set(p.date, { ...(byDate.get(p.date) ?? { date: p.date }), google: p.value });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
