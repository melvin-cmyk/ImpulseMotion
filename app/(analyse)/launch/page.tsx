"use client";

/**
 * Launch Analysis — suivi des créas récemment lancées.
 * Tout est dérivé de champs réels : date de lancement = `createdTime` Meta,
 * croissance = dépense des 7 derniers jours de `trend` vs les 7 précédents
 * (null → "—" quand il n'y a pas assez d'historique), statut = seuils sur
 * spend / CTR / hook / ROAS + médianes du compte.
 */

import { useState, useMemo } from "react";
import type { Creative } from "@/lib/creative-types";
import { useCreativesContext } from "@/lib/creatives-context";
import { fmtMoney, fmtRoas } from "@/lib/creative-format";

/** Known ROAS (null / unavailable → 0). */
const roasOf = (c: Creative) => (c.roas !== null && c.roas !== undefined && !c.roasUnavailable ? c.roas : 0);
import { CreativeThumbnail } from "@/components/creative-thumbnail";
import { CreativeModal } from "@/components/creative-modal";
import { DateRangePicker } from "@/components/date-range-picker";
import { PageHelp } from "@/components/ui/page-help";
import { PageHeader, Pill } from "@/components/ui/surface";
import { Trophy, TrendingUp, TrendingDown, FlaskConical, Minus } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type LaunchStatus = "Winner" | "Scaling" | "Stable" | "Declining" | "Testing";

interface LaunchCreative {
  creative: Creative;
  launchStatus: LaunchStatus;
  /** ISO date from Meta `created_time`, undefined when the API did not return it. */
  launchDate: string | undefined;
  /** Spend last 7 trend days vs previous 7 (%), null when not enough data. */
  spendGrowthPct: number | null;
}

const RECENT_DAYS = 30;
const TESTING_SPEND = 50;

// ── Real computations ─────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

/**
 * Spend growth from the daily trend: last 7 calendar days (anchored on the
 * last trend date) vs the 7 days before. Requires at least 4 delivery days in
 * the previous window and non-zero previous spend, otherwise null.
 */
function computeSpendGrowth(creative: Creative): number | null {
  const points = creative.trend.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date));
  if (points.length < 8) return null;
  const last = points.reduce((m, d) => (d.date > m ? d.date : m), points[0].date);
  const lastStart = addDays(last, -6);
  const prevStart = addDays(last, -13);
  const recent = points.filter((d) => d.date >= lastStart);
  const previous = points.filter((d) => d.date >= prevStart && d.date < lastStart);
  if (previous.length < 4 || recent.length < 4) return null;
  const recentSpend = recent.reduce((s, d) => s + d.spend, 0);
  const prevSpend = previous.reduce((s, d) => s + d.spend, 0);
  if (prevSpend <= 0) return null;
  return Math.round(((recentSpend - prevSpend) / prevSpend) * 1000) / 10;
}

function computeLaunchStatus(
  creative: Creative,
  medians: { spend: number; roas: number; ctr: number },
  growth: number | null,
): LaunchStatus {
  if (creative.spend < TESTING_SPEND) return "Testing";

  const weakHook = creative.format === "Video" && creative.hookRate > 0 && creative.hookRate < 20;
  const roas = roasOf(creative);
  const belowBoth = roas > 0 && roas < medians.roas && creative.ctr < medians.ctr;
  if (creative.ctr < 0.5 || weakHook || belowBoth) return "Declining";

  if (creative.spend > medians.spend && roas > medians.roas && creative.ctr > medians.ctr) return "Winner";

  if (growth !== null && growth > 20 && (roas >= medians.roas || creative.ctr >= medians.ctr)) return "Scaling";

  return "Stable";
}

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  LaunchStatus,
  { label: string; icon: React.ElementType; badgeClass: string; iconClass: string; borderClass: string; hint: string }
> = {
  Winner: {
    label: "Gagnante",
    icon: Trophy,
    badgeClass: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
    iconClass: "text-emerald-400",
    borderClass: "border-emerald-800/40",
    hint: "Spend, ROAS et CTR au-dessus des médianes du compte",
  },
  Scaling: {
    label: "En scaling",
    icon: TrendingUp,
    badgeClass: "bg-blue-500/15 text-blue-300 border border-blue-500/30",
    iconClass: "text-blue-400",
    borderClass: "border-blue-800/40",
    hint: "Dépense 7 j en hausse de plus de 20 % avec ROAS ou CTR au niveau de la médiane",
  },
  Stable: {
    label: "Stable",
    icon: Minus,
    badgeClass: "bg-gray-500/15 text-gray-300 border border-gray-500/30",
    iconClass: "text-gray-400",
    borderClass: "border-gray-800",
    hint: "Aucun signal fort dans un sens ou dans l'autre",
  },
  Declining: {
    label: "En déclin",
    icon: TrendingDown,
    badgeClass: "bg-red-500/15 text-red-300 border border-red-500/30",
    iconClass: "text-red-400",
    borderClass: "border-red-800/40",
    hint: "CTR < 0,5 %, hook rate < 20 % ou ROAS et CTR sous les médianes",
  },
  Testing: {
    label: "En test",
    icon: FlaskConical,
    badgeClass: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
    iconClass: "text-amber-400",
    borderClass: "border-amber-800/40",
    hint: `Moins de ${TESTING_SPEND} dépensés : pas encore concluant`,
  },
};

const STATUS_ORDER: LaunchStatus[] = ["Winner", "Scaling", "Stable", "Declining", "Testing"];

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

// ── LaunchCard ────────────────────────────────────────────────────────────────

function LaunchCard({ item, currency, onClick }: { item: LaunchCreative; currency: string | null; onClick: () => void }) {
  const { creative, launchStatus, launchDate, spendGrowthPct } = item;
  const config = STATUS_CONFIG[launchStatus];
  const Icon = config.icon;
  const isActive = creative.effectiveStatus === "ACTIVE";

  return (
    <div
      onClick={onClick}
      className={`bg-gray-900 border ${config.borderClass} rounded-2xl overflow-hidden hover:shadow-lg transition-all duration-200 cursor-pointer hover:scale-[1.01]`}
    >
      <div className="flex gap-4 p-4">
        <div className="w-16 h-16 rounded-xl overflow-hidden shrink-0">
          <CreativeThumbnail
            format={creative.format}
            thumbnailColor={creative.thumbnailColor}
            thumbnailUrl={creative.thumbnailUrl}
            videoUrl={creative.videoUrl}
            videoId={creative.videoId}
            className="w-16 h-16"
          />
        </div>

        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-mono text-gray-200 truncate" title={creative.name}>{creative.name}</p>
              {creative.campaignName && (
                <p className="text-[11px] text-gray-500 truncate" title={creative.campaignName}>{creative.campaignName}</p>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {creative.effectiveStatus && (
                <Pill tone={isActive ? "emerald" : "default"}>{isActive ? "Active" : "En pause"}</Pill>
              )}
              <span className={`flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${config.badgeClass}`} title={config.hint}>
                <Icon className={`w-3 h-3 ${config.iconClass}`} />
                {config.label}
              </span>
            </div>
          </div>

          <p className="text-[11px] text-gray-500">
            Lancée le <span className="text-gray-400 font-medium">{formatDate(launchDate)}</span>
            <span className="text-gray-600"> · {creative.format}</span>
          </p>

          <div className="flex items-center gap-4">
            <div className="text-center">
              <p className="text-[9px] text-gray-600 uppercase tracking-wide">Spend</p>
              <p className="text-xs font-bold text-gray-300">{fmtMoney(creative.spend, currency)}</p>
            </div>
            <div className="text-center">
              <p className="text-[9px] text-gray-600 uppercase tracking-wide">CTR</p>
              <p className="text-xs font-bold text-gray-300">{creative.ctr.toFixed(2)} %</p>
            </div>
            <div className="text-center">
              <p className="text-[9px] text-gray-600 uppercase tracking-wide">ROAS</p>
              <p className="text-xs font-bold text-gray-300" title={creative.roasEstimated && !creative.roasUnavailable ? "ROAS estimé (panier moyen)" : undefined}>
                {fmtRoas(creative.roasUnavailable ? null : creative.roas, { estimated: creative.roasEstimated })}
              </p>
            </div>
            {creative.format === "Video" && (
              <div className="text-center">
                <p className="text-[9px] text-gray-600 uppercase tracking-wide">Hook 3 s</p>
                <p className="text-xs font-bold text-gray-300">{creative.hookRate > 0 ? `${creative.hookRate.toFixed(1)} %` : "—"}</p>
              </div>
            )}
            <div className="text-center" title="Dépense des 7 derniers jours vs les 7 précédents (tendance quotidienne)">
              <p className="text-[9px] text-gray-600 uppercase tracking-wide">Spend 7 j</p>
              <p className={`text-xs font-bold ${spendGrowthPct === null ? "text-gray-500" : spendGrowthPct >= 0 ? "text-blue-400" : "text-red-400"}`}>
                {spendGrowthPct === null ? "—" : `${spendGrowthPct >= 0 ? "+" : ""}${spendGrowthPct} %`}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function LaunchPage() {
  const { creatives, isLoading: loading, isRealData, dateRange, currency } = useCreativesContext();
  const [selectedCreative, setSelectedCreative] = useState<Creative | null>(null);
  const [statusFilter, setStatusFilter] = useState<LaunchStatus | "All">("All");
  const [scope, setScope] = useState<"recent" | "all">("recent");

  // "Récemment lancée" = créée dans la période sélectionnée ou dans les 30 derniers jours.
  const recentSince = useMemo(() => {
    const thirty = addDays(new Date().toISOString().split("T")[0], -RECENT_DAYS);
    return dateRange.since < thirty ? dateRange.since : thirty;
  }, [dateRange.since]);

  const launchCreatives = useMemo((): LaunchCreative[] => {
    if (creatives.length === 0) return [];
    const medians = {
      spend: median(creatives.map((c) => c.spend)),
      roas: median(creatives.filter((c) => roasOf(c) > 0).map((c) => roasOf(c))),
      ctr: median(creatives.map((c) => c.ctr)),
    };
    return creatives.map((creative) => {
      const growth = computeSpendGrowth(creative);
      return {
        creative,
        launchStatus: computeLaunchStatus(creative, medians, growth),
        launchDate: creative.createdTime,
        spendGrowthPct: growth,
      };
    });
  }, [creatives]);

  const scoped = useMemo(() => {
    if (scope === "all") return launchCreatives;
    return launchCreatives.filter((lc) => lc.launchDate && lc.launchDate.slice(0, 10) >= recentSince);
  }, [launchCreatives, scope, recentSince]);

  const withoutDate = useMemo(() => launchCreatives.filter((lc) => !lc.launchDate).length, [launchCreatives]);

  const filtered = useMemo(() => {
    const list = statusFilter === "All" ? scoped : scoped.filter((lc) => lc.launchStatus === statusFilter);
    return [...list].sort((a, b) => (b.launchDate ?? "").localeCompare(a.launchDate ?? ""));
  }, [scoped, statusFilter]);

  const counts = useMemo(() => {
    const c: Record<LaunchStatus, number> = { Winner: 0, Scaling: 0, Stable: 0, Declining: 0, Testing: 0 };
    scoped.forEach((lc) => c[lc.launchStatus]++);
    return c;
  }, [scoped]);

  return (
    <div className="p-6 space-y-6">
      <PageHelp
        title="Launch Analysis — Suivi des lancements"
        description="Suit les créas lancées récemment (date de création Meta) et leur statut de performance, calculé uniquement à partir de chiffres réels : dépense, CTR, hook rate, ROAS et médianes du compte."
        steps={[
          "Choisis la période : une créa est « récente » si elle a été créée dans la période ou dans les 30 derniers jours.",
          "Lis les compteurs par statut, puis filtre pour isoler les gagnantes à scaler ou les créas en déclin à remplacer.",
          "La colonne « Spend 7 j » compare la dépense des 7 derniers jours à celle des 7 jours précédents ; « — » signifie qu'il n'y a pas assez d'historique.",
        ]}
        tip="Une créa « En test » (moins de 50 dépensés) n'est pas concluante : laisse-la tourner avant de trancher."
      />

      <PageHeader
        title="Launch Analysis"
        subtitle="Créas lancées récemment et leur statut de performance"
        action={<Pill tone={isRealData ? "emerald" : "default"}>{isRealData ? "Données réelles" : "Démo"}</Pill>}
      />

      <DateRangePicker />

      {!loading && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {STATUS_ORDER.map((s) => {
            const cfg = STATUS_CONFIG[s];
            const Icon = cfg.icon;
            return (
              <div key={s} className={`bg-gray-900 border ${cfg.borderClass} rounded-2xl p-4 flex items-center gap-3`} title={cfg.hint}>
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${cfg.badgeClass}`}>
                  <Icon className={`w-4 h-4 ${cfg.iconClass}`} />
                </div>
                <div>
                  <p className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">{cfg.label}</p>
                  <p className="text-xl font-bold text-white">{counts[s]}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!loading && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
            {(["All", ...STATUS_ORDER] as (LaunchStatus | "All")[]).map((s) => {
              const cfg = s !== "All" ? STATUS_CONFIG[s] : null;
              return (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    statusFilter === s ? "bg-violet-600 text-white" : "text-gray-400 hover:text-white"
                  }`}
                >
                  {cfg && <cfg.icon className="w-3.5 h-3.5" />}
                  {cfg ? cfg.label : "Toutes"}
                  {s !== "All" && <span className="text-[10px] opacity-70">({counts[s as LaunchStatus]})</span>}
                </button>
              );
            })}
          </div>

          <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit ml-auto">
            {([
              { id: "recent", label: `Lancées depuis le ${formatDate(recentSince)}` },
              { id: "all", label: "Toutes les créas" },
            ] as const).map((o) => (
              <button
                key={o.id}
                onClick={() => setScope(o.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  scope === o.id ? "bg-violet-600 text-white" : "text-gray-400 hover:text-white"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!loading && scope === "recent" && withoutDate > 0 && (
        <p className="text-[11px] text-gray-500">
          {withoutDate} créa{withoutDate > 1 ? "s" : ""} sans date de création renvoyée par Meta : masquée{withoutDate > 1 ? "s" : ""} de la vue « récentes ».
        </p>
      )}

      {loading && <div className="text-center py-12 text-gray-500 text-sm">Chargement des créas…</div>}

      {!loading && (
        <div className="space-y-3">
          {filtered.map((item) => (
            <LaunchCard key={item.creative.id} item={item} currency={currency} onClick={() => setSelectedCreative(item.creative)} />
          ))}
          {filtered.length === 0 && (
            <div className="flex items-center justify-center h-40 text-gray-600 text-sm">
              {scope === "recent"
                ? "Aucune créa lancée récemment avec ce statut. Passe sur « Toutes les créas » ou élargis la période."
                : "Aucune créa avec ce statut."}
            </div>
          )}
        </div>
      )}

      {!loading && filtered.some((f) => f.creative.roasEstimated) && (
        <p className="text-[10px] text-gray-600">* ROAS estimé (achats × panier moyen) : le compte ne remonte pas la valeur d&apos;achat.</p>
      )}

      <CreativeModal creative={selectedCreative} onClose={() => setSelectedCreative(null)} />
    </div>
  );
}
