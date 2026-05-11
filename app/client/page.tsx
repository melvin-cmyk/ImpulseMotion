"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  Activity,
  DollarSign,
  Target,
  ShoppingCart,
  Loader2,
  TrendingUp,
  TrendingDown,
  Sparkles,
  ArrowRight,
  AlertCircle,
} from "lucide-react";
import { Section, Kpi, PageHeader, Card, Pill } from "@/components/ui/surface";

type Kpis = {
  spend: number;
  revenue: number;
  conversions: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpm: number;
  cpc: number;
  cpa: number;
  roas: number;
};

type MetaCreative = {
  id: string;
  name: string;
  spend: number;
  impressions: number;
  ctr: number;
  roas: number;
  cpa: number;
  hookRate: number | null;
  thumbnailUrl: string | null;
};

type GoogleCampaign = { id: string; name: string; spend: number; clicks: number; conversions: number; revenue: number; roas: number };
type GoogleKeyword = { keyword: string; matchType: string; campaign: string; impressions: number; clicks: number; spend: number; conversions: number; ctr: number; roas: number };
type GoogleSearchTerm = { term: string; impressions: number; clicks: number; spend: number; conversions: number };

type Overview = {
  range: { since: string; until: string };
  metaAccount: { id: string; label: string | null };
  googleAccount: { id: string; label: string | null } | null;
  meta: { kpi: Kpis; topCreatives: MetaCreative[] };
  google: { kpi: Kpis; topCampaigns: GoogleCampaign[]; topKeywords: GoogleKeyword[]; topSearchTerms: GoogleSearchTerm[] } | null;
  combined: Kpis;
};

type Plan = {
  currentRoas: number;
  potentialRoas: number;
  rationale: string;
  levers: { title: string; platform: "meta" | "google" | "cross"; impactEur: number; effort: "low" | "medium" | "high"; detail: string }[];
};

const eur = (n: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
const pct = (n: number) => `${n.toFixed(1)}%`;
const x = (n: number) => (n > 0 ? `${n.toFixed(2)}x` : "—");

function PRESETS() {
  return [
    { days: 7, label: "7j" },
    { days: 30, label: "30j" },
    { days: 90, label: "90j" },
  ] as const;
}

function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

export default function ClientPage() {
  const [metaAccountId, setMetaAccountId] = useState<string>("");
  const [metaAccountName, setMetaAccountName] = useState<string>("");
  const [days, setDays] = useState<number>(30);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [plan, setPlan] = useState<Plan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  // Restore selected account from localStorage (set by AccountPicker)
  useEffect(() => {
    const raw = localStorage.getItem("impulse_meta_account");
    if (raw) {
      try {
        const data = JSON.parse(raw);
        setMetaAccountId(data.accountId ?? "");
        setMetaAccountName(data.accountName ?? "");
      } catch { /* ignore */ }
    }
    // React to changes from the picker (other components dispatch storage events)
    const onStorage = (e: StorageEvent) => {
      if (e.key === "impulse_meta_account" && e.newValue) {
        try {
          const data = JSON.parse(e.newValue);
          setMetaAccountId(data.accountId ?? "");
          setMetaAccountName(data.accountName ?? "");
        } catch { /* ignore */ }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!metaAccountId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPlan(null);
    setPlanError(null);
    const since = offsetDate(-days);
    const until = offsetDate(0);
    fetch(`/api/client/overview?metaAccountId=${encodeURIComponent(metaAccountId)}&since=${since}&until=${until}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        return (await r.json()) as Overview;
      })
      .then((data) => {
        if (!cancelled) setOverview(data);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [metaAccountId, days]);

  const clientName = overview?.metaAccount.label ?? metaAccountName ?? metaAccountId ?? "—";

  async function runPlan() {
    if (!overview) return;
    setPlanLoading(true);
    setPlanError(null);
    setPlan(null);
    try {
      const ctx = {
        client: clientName,
        period: overview.range,
        combined: overview.combined,
        meta: {
          kpi: overview.meta.kpi,
          topCreatives: overview.meta.topCreatives.slice(0, 8),
        },
        google: overview.google
          ? {
              kpi: overview.google.kpi,
              topCampaigns: overview.google.topCampaigns.slice(0, 8),
              topKeywords: overview.google.topKeywords.slice(0, 15),
              topSearchTerms: overview.google.topSearchTerms.slice(0, 10),
            }
          : null,
      };
      const res = await fetch("/api/client/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: ctx }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`;
        throw new Error(err);
      }
      setPlan((await res.json()) as Plan);
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : "plan failed");
    } finally {
      setPlanLoading(false);
    }
  }

  const meta = overview?.meta;
  const google = overview?.google;
  const combined = overview?.combined;

  return (
    <div className="px-6 py-6 max-w-[1400px] mx-auto space-y-6">
      <PageHeader
        title={`Vue client · ${clientName}`}
        subtitle={
          overview
            ? `${overview.range.since} → ${overview.range.until} · Meta${
                overview.googleAccount ? " + Google Ads" : " seul (pas de Google Ads dans l'ACL)"
              }`
            : "Sélectionne un compte dans le picker ↑K"
        }
        action={
          <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1">
            {PRESETS().map((p) => (
              <button
                key={p.days}
                onClick={() => setDays(p.days)}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                  days === p.days ? "bg-violet-600 text-white" : "text-gray-400 hover:text-gray-100"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        }
      />

      {!metaAccountId && (
        <Card padded className="text-center text-gray-400">
          Aucun compte sélectionné. Ouvre le picker en haut (Cmd+K).
        </Card>
      )}

      {error && (
        <Card padded className="border-red-900/40 bg-red-950/30">
          <div className="flex items-center gap-2 text-red-300">
            <AlertCircle className="w-4 h-4" />
            <span className="text-sm">{error}</span>
          </div>
        </Card>
      )}

      {/* Cross-platform KPI bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi
          icon={<DollarSign className="w-4 h-4" />}
          label="Spend total"
          value={loading && !overview ? "…" : eur(combined?.spend ?? 0)}
          sub={
            combined && meta && google
              ? `Meta ${eur(meta.kpi.spend)} · Google ${eur(google.kpi.spend)}`
              : combined && meta
                ? `Meta uniquement`
                : undefined
          }
        />
        <Kpi
          icon={<ShoppingCart className="w-4 h-4" />}
          label="Revenue"
          value={loading && !overview ? "…" : eur(combined?.revenue ?? 0)}
          accent="emerald"
        />
        <Kpi
          icon={<Target className="w-4 h-4" />}
          label="ROAS"
          value={loading && !overview ? "…" : x(combined?.roas ?? 0)}
          accent={combined && combined.roas >= 2 ? "emerald" : "amber"}
        />
        <Kpi
          icon={<Activity className="w-4 h-4" />}
          label="Conversions"
          value={loading && !overview ? "…" : Math.round(combined?.conversions ?? 0).toLocaleString("fr-FR")}
          accent="blue"
        />
      </div>

      {/* Plateformes */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <MetaCol kpi={meta?.kpi} creatives={meta?.topCreatives ?? []} loading={loading} />
        <GoogleCol
          kpi={google?.kpi}
          campaigns={google?.topCampaigns ?? []}
          keywords={google?.topKeywords ?? []}
          searchTerms={google?.topSearchTerms ?? []}
          loading={loading}
          enabled={!!overview?.googleAccount}
        />
      </div>

      {/* Plan IA */}
      <Section
        title={
          <span className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-violet-400" /> Plan IA · ROAS potentiel
          </span>
        }
        action={
          <button
            onClick={runPlan}
            disabled={!overview || planLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-violet-600 hover:bg-violet-500 disabled:bg-gray-800 disabled:text-gray-500 text-white transition-colors"
          >
            {planLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {planLoading ? "Analyse en cours…" : plan ? "Re-générer" : "Analyser"}
          </button>
        }
      >
        {planError && (
          <div className="text-sm text-red-300 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {planError}
          </div>
        )}
        {!plan && !planLoading && !planError && (
          <p className="text-sm text-gray-400">
            Clique sur <span className="text-violet-300">Analyser</span> pour générer un plan d&apos;action chiffré
            basé sur la data ci-dessus. L&apos;IA pioche les leviers cross-platform les plus impactants et estime
            le ROAS atteignable à 30j.
          </p>
        )}
        {plan && <PlanView plan={plan} />}
      </Section>
    </div>
  );
}

function PlanView({ plan }: { plan: Plan }) {
  const gain = plan.potentialRoas - plan.currentRoas;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <Kpi label="ROAS actuel" value={x(plan.currentRoas)} accent="violet" />
        <Kpi
          label="ROAS potentiel"
          value={x(plan.potentialRoas)}
          accent={plan.potentialRoas > plan.currentRoas ? "emerald" : "amber"}
          sub={gain > 0 ? `+${gain.toFixed(2)}x` : undefined}
          icon={gain > 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
        />
        <Kpi
          label="Gain mensuel"
          value={eur(plan.levers.reduce((s, l) => s + (l.impactEur > 0 ? l.impactEur : 0), 0))}
          accent="emerald"
        />
      </div>
      <p className="text-sm text-gray-300 italic">{plan.rationale}</p>
      <ul className="space-y-2">
        {plan.levers.map((l, i) => (
          <li key={i}>
            <Card padded className="hover:bg-gray-800/30 transition-colors">
              <div className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-violet-500/20 text-violet-300 flex items-center justify-center text-xs font-semibold shrink-0">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="text-sm font-semibold text-white">{l.title}</h4>
                    <Pill tone={l.platform === "meta" ? "blue" : l.platform === "google" ? "amber" : "violet"}>
                      {l.platform === "cross" ? "Cross-plat" : l.platform === "meta" ? "Meta" : "Google"}
                    </Pill>
                    <Pill tone={l.effort === "low" ? "emerald" : l.effort === "medium" ? "amber" : "red"}>
                      Effort {l.effort}
                    </Pill>
                    {l.impactEur !== 0 && (
                      <Pill tone={l.impactEur > 0 ? "emerald" : "red"}>
                        {l.impactEur > 0 ? "+" : ""}
                        {eur(l.impactEur)}/mois
                      </Pill>
                    )}
                  </div>
                  <p className="text-sm text-gray-300 mt-1.5">{l.detail}</p>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MetaCol({
  kpi,
  creatives,
  loading,
}: {
  kpi: Kpis | undefined;
  creatives: MetaCreative[];
  loading: boolean;
}) {
  return (
    <Section
      title={<span className="flex items-center gap-2">Meta Ads</span>}
      action={
        kpi ? (
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span>CTR <span className="text-white font-medium">{pct(kpi.ctr)}</span></span>
            <span>CPM <span className="text-white font-medium">{eur(kpi.cpm)}</span></span>
            <span>ROAS <span className="text-white font-medium">{x(kpi.roas)}</span></span>
          </div>
        ) : null
      }
    >
      {loading && !kpi ? (
        <div className="text-sm text-gray-500 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Chargement des créas…
        </div>
      ) : creatives.length === 0 ? (
        <p className="text-sm text-gray-500">Aucune créa active sur la période.</p>
      ) : (
        <ul className="space-y-2">
          {creatives.slice(0, 6).map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-1.5 border-b border-gray-800/60 last:border-0">
              <div className="w-12 h-12 rounded-lg bg-gray-800 overflow-hidden shrink-0 relative">
                {c.thumbnailUrl ? (
                  <Image
                    src={`/api/deck/proxy-image?url=${encodeURIComponent(c.thumbnailUrl)}`}
                    alt={c.name}
                    fill
                    sizes="48px"
                    className="object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">—</div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{c.name}</p>
                <div className="flex items-center gap-3 text-[11px] text-gray-500 mt-0.5">
                  <span>{eur(c.spend)}</span>
                  <span>CTR {pct(c.ctr)}</span>
                  {c.hookRate !== null && <span>Hook {pct(c.hookRate)}</span>}
                  <span className={c.roas >= 2 ? "text-emerald-400" : "text-amber-400"}>ROAS {x(c.roas)}</span>
                </div>
              </div>
              <ArrowRight className="w-3.5 h-3.5 text-gray-700 shrink-0" />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function GoogleCol({
  kpi,
  campaigns,
  keywords,
  searchTerms,
  loading,
  enabled,
}: {
  kpi: Kpis | undefined;
  campaigns: GoogleCampaign[];
  keywords: GoogleKeyword[];
  searchTerms: GoogleSearchTerm[];
  loading: boolean;
  enabled: boolean;
}) {
  const [tab, setTab] = useState<"campaigns" | "keywords" | "search">("keywords");
  if (!enabled) {
    return (
      <Section title="Google Ads">
        <p className="text-sm text-gray-500">
          Aucun compte Google Ads associé à ce client dans l&apos;ACL. Demande à l&apos;admin de l&apos;ajouter dans
          Réglages → Utilisateurs.
        </p>
      </Section>
    );
  }
  return (
    <Section
      title="Google Ads"
      action={
        kpi ? (
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span>CTR <span className="text-white font-medium">{pct(kpi.ctr)}</span></span>
            <span>CPC <span className="text-white font-medium">{eur(kpi.cpc)}</span></span>
            <span>ROAS <span className="text-white font-medium">{x(kpi.roas)}</span></span>
          </div>
        ) : null
      }
    >
      {loading && !kpi ? (
        <div className="text-sm text-gray-500 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Chargement Google Ads…
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1 mb-3 border-b border-gray-800">
            {(
              [
                { k: "keywords", l: `Mots-clés (${keywords.length})` },
                { k: "search", l: `Search terms (${searchTerms.length})` },
                { k: "campaigns", l: `Campagnes (${campaigns.length})` },
              ] as const
            ).map((t) => (
              <button
                key={t.k}
                onClick={() => setTab(t.k)}
                className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                  tab === t.k
                    ? "border-violet-500 text-violet-300"
                    : "border-transparent text-gray-500 hover:text-gray-300"
                }`}
              >
                {t.l}
              </button>
            ))}
          </div>

          {tab === "keywords" && (
            <KeywordTable rows={keywords.slice(0, 15)} />
          )}
          {tab === "search" && (
            <SearchTermTable rows={searchTerms.slice(0, 15)} />
          )}
          {tab === "campaigns" && (
            <CampaignTable rows={campaigns.slice(0, 10)} />
          )}
        </>
      )}
    </Section>
  );
}

function KeywordTable({ rows }: { rows: GoogleKeyword[] }) {
  if (rows.length === 0) return <p className="text-sm text-gray-500">Aucun mot-clé actif sur la période.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-[10px] uppercase tracking-wider text-gray-500">
          <tr className="text-left">
            <th className="py-1.5">Mot-clé</th>
            <th className="py-1.5 text-right">Spend</th>
            <th className="py-1.5 text-right">CTR</th>
            <th className="py-1.5 text-right">Conv.</th>
            <th className="py-1.5 text-right">ROAS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((k, i) => (
            <tr key={i} className="border-t border-gray-800/40">
              <td className="py-1.5 pr-2">
                <div className="text-gray-100 truncate max-w-[200px]">{k.keyword}</div>
                <div className="text-[10px] text-gray-600 truncate max-w-[200px]">
                  {k.matchType} · {k.campaign}
                </div>
              </td>
              <td className="py-1.5 text-right text-gray-200">{eur(k.spend)}</td>
              <td className="py-1.5 text-right text-gray-300">{pct(k.ctr)}</td>
              <td className="py-1.5 text-right text-gray-300">{k.conversions.toFixed(1)}</td>
              <td className={`py-1.5 text-right font-medium ${k.roas >= 2 ? "text-emerald-400" : k.roas > 0 ? "text-amber-400" : "text-gray-600"}`}>
                {x(k.roas)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SearchTermTable({ rows }: { rows: GoogleSearchTerm[] }) {
  if (rows.length === 0) return <p className="text-sm text-gray-500">Aucun search term sur la période.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-[10px] uppercase tracking-wider text-gray-500">
          <tr className="text-left">
            <th className="py-1.5">Requête utilisateur</th>
            <th className="py-1.5 text-right">Spend</th>
            <th className="py-1.5 text-right">Clicks</th>
            <th className="py-1.5 text-right">Conv.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={i} className="border-t border-gray-800/40">
              <td className="py-1.5 pr-2 text-gray-100 truncate max-w-[280px]">{t.term}</td>
              <td className="py-1.5 text-right text-gray-200">{eur(t.spend)}</td>
              <td className="py-1.5 text-right text-gray-300">{t.clicks}</td>
              <td className="py-1.5 text-right text-gray-300">{t.conversions.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CampaignTable({ rows }: { rows: GoogleCampaign[] }) {
  if (rows.length === 0) return <p className="text-sm text-gray-500">Aucune campagne active.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-[10px] uppercase tracking-wider text-gray-500">
          <tr className="text-left">
            <th className="py-1.5">Campagne</th>
            <th className="py-1.5 text-right">Spend</th>
            <th className="py-1.5 text-right">Conv.</th>
            <th className="py-1.5 text-right">Rev.</th>
            <th className="py-1.5 text-right">ROAS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="border-t border-gray-800/40">
              <td className="py-1.5 pr-2 text-gray-100 truncate max-w-[200px]">{c.name}</td>
              <td className="py-1.5 text-right text-gray-200">{eur(c.spend)}</td>
              <td className="py-1.5 text-right text-gray-300">{c.conversions.toFixed(1)}</td>
              <td className="py-1.5 text-right text-gray-300">{eur(c.revenue)}</td>
              <td className={`py-1.5 text-right font-medium ${c.roas >= 2 ? "text-emerald-400" : c.roas > 0 ? "text-amber-400" : "text-gray-600"}`}>
                {x(c.roas)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
