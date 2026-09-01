"use client";

import { useState, useMemo, useCallback } from "react";
import type { Platform, Format, Status, Creative, WowMetrics } from "@/lib/creative-types";
import { useCreativesContext } from "@/lib/creatives-context";
import { aggregate, median as medianOf, FATIGUE_FREQUENCY_WEEKLY } from "@/lib/creative-stats";
import { fmtMoney, fmtRoas, fmtPct } from "@/lib/creative-format";
import { RoasValue } from "@/components/roas-value";
import { CreativeThumbnail } from "@/components/creative-thumbnail";
import { CreativeModal } from "@/components/creative-modal";
import { DateRangePicker } from "@/components/date-range-picker";
import { WowBanner, WowChip } from "@/components/wow-indicator";
import { LineChart, Line, ResponsiveContainer, Tooltip } from "recharts";
import { ArrowUpDown, DollarSign, MousePointerClick, Play, TrendingUp, Rocket, Scissors, ChevronDown, ChevronUp, LayoutGrid, Table2, ChevronUp as ChevronUpSort, X, Tag, Sparkles } from "lucide-react";
import { Section, Kpi, Pill } from "@/components/ui/surface";
import { CreativeAiAnalysis } from "@/components/creatives/ai-analysis";
import { FiltersBar, AdStatus } from "@/components/ui/filters-bar";
import { PageHelp } from "@/components/ui/page-help";
import { MetricInfoButton } from "@/components/metric-info-button";

type SortKey = "roas" | "cpa" | "spend" | "ctr" | "hookRate";
type ViewMode = "card" | "table";
type TableSortKey = "name" | "spend" | "ctr" | "hookRate" | "roas" | "cpa" | "status";

// ── localStorage helpers for tags ─────────────────────────────────────────────

function getTagsForCreative(creativeId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(`impulse_tags_${creativeId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function getAllUsedTags(creatives: Creative[]): string[] {
  const set = new Set<string>();
  creatives.forEach((c) => {
    getTagsForCreative(c.id).forEach((t) => set.add(t));
  });
  return Array.from(set).sort();
}

// ── Score badge (A/B/C/D) ─────────────────────────────────────────────────────

/** Usable ROAS for rules: null / unavailable counts as 0 (never a made-up value). */
function roasOf(c: Creative): number {
  return c.roas !== null && c.roas !== undefined && !c.roasUnavailable ? c.roas : 0;
}

/** True when Meta reports the ad as not delivering (paused at any level, archived…). */
function isPaused(c: Creative): boolean {
  return !!c.effectiveStatus && c.effectiveStatus !== "ACTIVE";
}

function getScore(creative: Creative): "A" | "B" | "C" | "D" {
  const roas = roasOf(creative);
  // For video creatives: use hookRate + ROAS composite
  if (creative.hookRate > 0) {
    if (creative.hookRate >= 30 && roas >= 4) return "A";
    if (creative.hookRate >= 20 || roas >= 3.5) return "B";
    if (creative.hookRate >= 10 || roas >= 2) return "C";
    return "D";
  }
  // For image/carousel: use ROAS + CTR
  if (roas >= 4 && creative.ctr >= 2.5) return "A";
  if (roas >= 3 || creative.ctr >= 2) return "B";
  if (roas >= 1.5 || creative.ctr >= 1) return "C";
  return "D";
}

function ScoreBadge({ creative }: { creative: Creative }) {
  const score = getScore(creative);
  const styles: Record<string, string> = {
    A: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-emerald-900/30",
    B: "bg-blue-500/20 text-blue-300 border border-blue-500/40 shadow-blue-900/30",
    C: "bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-amber-900/30",
    D: "bg-red-500/20 text-red-300 border border-red-500/40 shadow-red-900/30",
  };
  return (
    <span className={`text-xs font-bold px-1.5 py-0.5 rounded-md shadow-sm ${styles[score]}`}>
      {score}
    </span>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent: string;
}

function KpiCard({ label, value, sub, icon: Icon, accent }: KpiCardProps) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex items-start gap-3">
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${accent}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div>
        <p className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">{label}</p>
        <p className="text-xl font-bold text-white mt-0.5">{value}</p>
        {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function PlatformBadge({ platform }: { platform: Platform }) {
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
        platform === "Meta"
          ? "bg-blue-900/70 text-blue-300 border border-blue-800"
          : "bg-pink-900/70 text-pink-300 border border-pink-800"
      }`}
    >
      {platform}
    </span>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const map: Record<Status, string> = {
    Winner: "bg-green-900/60 text-green-300 border border-green-800",
    Loser: "bg-red-900/60 text-red-300 border border-red-800",
    Fatigued: "bg-orange-900/60 text-orange-300 border border-orange-800",
    Active: "bg-blue-900/60 text-blue-300 border border-blue-800",
  };
  const icons: Record<Status, string> = {
    Winner: "🏆",
    Loser: "❌",
    Fatigued: "⚠️",
    Active: "●",
  };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${map[status]}`}>
      {icons[status]} {status}
    </span>
  );
}

// ── Sparkline (CTR trend) ─────────────────────────────────────────────────────

function Sparkline({ data }: { data: { date: string; roas: number; ctr?: number }[] }) {
  // Build per-day CTR from trend data (clicks/impressions * 100)
  const sparkData = data.map((d) => ({
    date: d.date,
    ctr: d.ctr ?? ((d as { clicks?: number }).clicks && (d as { impressions?: number }).impressions
      ? (((d as { clicks?: number }).clicks ?? 0) / ((d as { impressions?: number }).impressions ?? 1)) * 100
      : d.roas),
    roas: d.roas,
  }));

  return (
    <ResponsiveContainer width="100%" height={36}>
      <LineChart data={sparkData}>
        <Line
          type="monotone"
          dataKey="roas"
          stroke="#8b5cf6"
          strokeWidth={1.5}
          dot={false}
        />
        <Tooltip
          contentStyle={{
            background: "#1f2937",
            border: "1px solid #374151",
            borderRadius: "6px",
            fontSize: "11px",
            color: "#e5e7eb",
          }}
          formatter={(v: unknown) => [`${Number(v).toFixed(2)}x`, "ROAS"]}
          labelFormatter={(l) => l}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</span>
      <span className="text-xs font-semibold text-gray-200">{value}</span>
    </div>
  );
}

// ── Creatives to Scale section ────────────────────────────────────────────────

function CreativesToScaleSection({
  creatives,
  currency,
  onCreativeClick,
}: {
  creatives: Creative[];
  currency: string | null;
  onCreativeClick: (c: Creative) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // Low spend + ROAS above the median of the (filtered, delivering) creatives
  // with a known ROAS. Paused ads can't be scaled and are excluded.
  const toScale = useMemo(() => {
    const pool = creatives.filter((c) => !isPaused(c) && c.spend > 0);
    const withRoas = pool.filter((c) => c.roas !== null && !c.roasUnavailable && (c.roas ?? 0) > 0);
    if (withRoas.length < 2) return [];
    const medianSpend = medianOf(pool.map((c) => c.spend)) ?? 0;
    const medianRoas = medianOf(withRoas.map((c) => c.roas as number)) ?? 0;
    return withRoas
      .filter((c) => c.spend < medianSpend && (c.roas as number) > medianRoas)
      .sort((a, b) => (b.roas as number) - (a.roas as number))
      .slice(0, 5);
  }, [creatives]);

  if (toScale.length === 0) return null;

  return (
    <div className="bg-gray-900 border border-emerald-800/40 rounded-2xl overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 border-b border-gray-800 hover:bg-gray-800/30 transition-colors"
      >
        <div className="w-8 h-8 rounded-xl bg-emerald-500/20 flex items-center justify-center shrink-0">
          <Rocket className="w-4 h-4 text-emerald-400" />
        </div>
        <div className="text-left flex-1">
          <h2 className="text-sm font-semibold text-emerald-300">Creatives to Scale</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Low spend + high ROAS — untapped scaling potential ({toScale.length})
          </p>
        </div>
        {collapsed ? (
          <ChevronDown className="w-4 h-4 text-gray-500" />
        ) : (
          <ChevronUp className="w-4 h-4 text-gray-500" />
        )}
      </button>

      {!collapsed && (
        <div className="divide-y divide-gray-800">
          {toScale.map((c) => (
            <div
              key={c.id}
              onClick={() => onCreativeClick(c)}
              className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-800/40 cursor-pointer transition-colors"
            >
              <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0">
                <CreativeThumbnail
                  format={c.format}
                  thumbnailColor={c.thumbnailColor}
                  thumbnailUrl={c.thumbnailUrl}
                  videoUrl={c.videoUrl}
                  videoId={c.videoId}
                  className="w-10 h-10"
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-mono text-gray-200 truncate">{c.name}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <PlatformBadge platform={c.platform} />
                  <span className="text-[10px] text-gray-500 uppercase">{c.format}</span>
                </div>
              </div>
              <div className="flex items-center gap-6 shrink-0">
                <div className="text-center">
                  <p className="text-[10px] text-gray-500 uppercase flex items-center justify-center gap-0.5">Spend <MetricInfoButton metricKey="spend" /></p>
                  <p className="text-xs font-semibold text-gray-300">
                    {fmtMoney(c.spend, currency)}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] text-gray-500 uppercase flex items-center justify-center gap-0.5">ROAS <MetricInfoButton metricKey="roas" /></p>
                  <p className="text-xs font-semibold text-emerald-400"><RoasValue value={c.roas} estimated={c.roasEstimated && !c.roasUnavailable} /></p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] text-gray-500 uppercase flex items-center justify-center gap-0.5">CTR <MetricInfoButton metricKey="ctr" /></p>
                  <p className="text-xs font-semibold text-gray-300">{c.ctr}%</p>
                </div>
                <ScoreBadge creative={c} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Creatives to Cut section ──────────────────────────────────────────────────

function CreativesToCutSection({
  creatives,
  currency,
  onCreativeClick,
}: {
  creatives: Creative[];
  currency: string | null;
  onCreativeClick: (c: Creative) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // Real Meta frequency (normalised per 7 days) ≥ 3.5 AND CTR below 70 % of
  // the account CTR (Σ clicks / Σ impressions) or already flagged Fatigued.
  // Paused ads are already cut and are excluded.
  const toCut = useMemo(() => {
    const pool = creatives.filter((c) => !isPaused(c) && c.spend > 0);
    if (pool.length === 0) return [];
    const accountCtr = aggregate(pool).ctr ?? 0;
    return pool
      .filter((c) => {
        const frequencyHigh = typeof c.frequencyWeekly === "number" && c.frequencyWeekly >= FATIGUE_FREQUENCY_WEEKLY;
        const ctrDeclined = c.ctr < accountCtr * 0.7 || c.status === "Fatigued";
        return frequencyHigh && ctrDeclined;
      })
      .sort((a, b) => a.ctr - b.ctr)
      .slice(0, 5);
  }, [creatives]);

  if (toCut.length === 0) return null;

  return (
    <div className="bg-gray-900 border border-red-800/40 rounded-2xl overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 border-b border-gray-800 hover:bg-gray-800/30 transition-colors"
      >
        <div className="w-8 h-8 rounded-xl bg-red-500/20 flex items-center justify-center shrink-0">
          <Scissors className="w-4 h-4 text-red-400" />
        </div>
        <div className="text-left flex-1">
          <h2 className="text-sm font-semibold text-red-300">Creatives to Cut</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Fréquence hebdo ≥ {FATIGUE_FREQUENCY_WEEKLY} + CTR sous 70 % du compte — fatigue confirmée ({toCut.length})
          </p>
        </div>
        {collapsed ? (
          <ChevronDown className="w-4 h-4 text-gray-500" />
        ) : (
          <ChevronUp className="w-4 h-4 text-gray-500" />
        )}
      </button>

      {!collapsed && (
        <div className="divide-y divide-gray-800">
          {toCut.map((c) => {
            const frequency = typeof c.frequencyWeekly === "number" ? c.frequencyWeekly.toFixed(2) : "—";
            return (
              <div
                key={c.id}
                onClick={() => onCreativeClick(c)}
                className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-800/40 cursor-pointer transition-colors"
              >
                <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0">
                  <CreativeThumbnail
                    format={c.format}
                    thumbnailColor={c.thumbnailColor}
                    thumbnailUrl={c.thumbnailUrl}
                    videoUrl={c.videoUrl}
                    videoId={c.videoId}
                    className="w-10 h-10"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-gray-200 truncate">{c.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <PlatformBadge platform={c.platform} />
                    <StatusBadge status={c.status} />
                  </div>
                </div>
                <div className="flex items-center gap-6 shrink-0">
                  <div className="text-center">
                    <p className="text-[10px] text-gray-500 uppercase flex items-center justify-center gap-0.5">Freq. hebdo <MetricInfoButton metricKey="frequencyWeekly" /></p>
                    <p className="text-xs font-semibold text-red-400">{frequency}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-gray-500 uppercase flex items-center justify-center gap-0.5">Spend <MetricInfoButton metricKey="spend" /></p>
                    <p className="text-xs font-semibold text-gray-300">{fmtMoney(c.spend, currency)}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-gray-500 uppercase flex items-center justify-center gap-0.5">CTR <MetricInfoButton metricKey="ctr" /></p>
                    <p className="text-xs font-semibold text-gray-300">{c.ctr}%</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-gray-500 uppercase flex items-center justify-center gap-0.5">ROAS <MetricInfoButton metricKey="roas" /></p>
                    <p className="text-xs font-semibold text-gray-400"><RoasValue value={c.roas} estimated={c.roasEstimated && !c.roasUnavailable} /></p>
                  </div>
                  <ScoreBadge creative={c} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Creative Labels/Tags ──────────────────────────────────────────────────────

export interface CreativeLabel {
  text: string;
  emoji: string;
  style: string;
}

export function getCreativeLabels(
  creative: Creative,
  allCreatives: Creative[]
): CreativeLabel[] {
  const labels: CreativeLabel[] = [];
  if (allCreatives.length === 0) return labels;

  // "Top Performer" — known ROAS in the top 10 % of the creatives with a known ROAS
  const withRoas = allCreatives.filter((c) => c.roas !== null && !c.roasUnavailable && (c.roas ?? 0) > 0);
  const sortedByRoas = [...withRoas].sort((a, b) => (b.roas as number) - (a.roas as number));
  const top10pctIndex = Math.ceil(withRoas.length * 0.1);
  const roasThreshold = sortedByRoas[top10pctIndex - 1]?.roas ?? null;
  if (roasThreshold !== null && withRoas.length >= 3 && roasOf(creative) > 0 && roasOf(creative) >= roasThreshold) {
    labels.push({
      text: "Top Performer",
      emoji: "🏅",
      style: "bg-amber-500/20 text-amber-300 border border-amber-500/40",
    });
  }

  // "Winner" — account-relative status (see classifyStatus)
  if (creative.status === "Winner") {
    labels.push({
      text: "Winner",
      emoji: "🏆",
      style: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40",
    });
  }

  // "Fatigué" — real weekly frequency ≥ 3.5 AND CTR below the account CTR (Σ clicks / Σ impressions)
  const accountCtr = aggregate(allCreatives).ctr ?? 0;
  if (typeof creative.frequencyWeekly === "number" && creative.frequencyWeekly >= FATIGUE_FREQUENCY_WEEKLY && creative.ctr < accountCtr) {
    labels.push({
      text: "Fatigué",
      emoji: "😴",
      style: "bg-orange-500/20 text-orange-300 border border-orange-500/40",
    });
  }

  // "En test" — spend below 20 % of the median spend of the list (currency-agnostic)
  const medianSpend = medianOf(allCreatives.filter((c) => c.spend > 0).map((c) => c.spend)) ?? 0;
  if (medianSpend > 0 && creative.spend < medianSpend * 0.2) {
    labels.push({
      text: "En test",
      emoji: "🧪",
      style: "bg-blue-500/20 text-blue-300 border border-blue-500/40",
    });
  }

  return labels;
}

function CreativeLabelTags({
  creative,
  allCreatives,
}: {
  creative: Creative;
  allCreatives: Creative[];
}) {
  const labels = useMemo(
    () => getCreativeLabels(creative, allCreatives),
    [creative, allCreatives]
  );
  if (labels.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {labels.map((label) => (
        <span
          key={label.text}
          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${label.style}`}
        >
          {label.emoji} {label.text}
        </span>
      ))}
    </div>
  );
}

// ── Médianes du compte ────────────────────────────────────────────────────────
// Repères calculés sur les créas chargées (pas un benchmark sectoriel).

/**
 * Medians over the FILTERED creatives — single definition shared by the
 * "Médianes du compte" section and the table cell colouring:
 * CTR over all, hook over videos with a hook, CPA over creatives with a
 * conversion, ROAS over creatives with a KNOWN positive ROAS.
 */
function computeMedians(creatives: Creative[]) {
  const videos = creatives.filter((c) => c.format === "Video" && c.hookRate > 0);
  const withCpa = creatives.filter((c) => c.cpa > 0);
  const withRoas = creatives.filter((c) => c.roas !== null && !c.roasUnavailable && (c.roas ?? 0) > 0);
  const withSpend = creatives.filter((c) => c.spend > 0);
  return {
    spend: { value: medianOf(withSpend.map((c) => c.spend)), n: withSpend.length },
    ctr: { value: medianOf(creatives.map((c) => c.ctr)), n: creatives.length },
    hookRate: { value: medianOf(videos.map((c) => c.hookRate)), n: videos.length },
    cpa: { value: medianOf(withCpa.map((c) => c.cpa)), n: withCpa.length },
    roas: { value: medianOf(withRoas.map((c) => c.roas as number)), n: withRoas.length, estimated: withRoas.some((c) => c.roasEstimated) },
  };
}

function AccountMediansSection({ creatives, currency, conversionLabel }: { creatives: Creative[]; currency: string | null; conversionLabel: string }) {
  const stats = useMemo(() => computeMedians(creatives), [creatives]);

  const sub = (n: number, what: string) => (n > 0 ? `médiane sur ${n} ${what}` : "aucune donnée");

  return (
    <Section
      title="Médianes du compte"
      icon={<TrendingUp className="w-4 h-4 text-blue-400" />}
      action={<span className="text-[11px] text-gray-500">Calculées sur les créas filtrées de la période — pas un benchmark sectoriel</span>}
      bodyClassName="p-4 grid grid-cols-2 lg:grid-cols-4 gap-3"
    >
      <Kpi label="CTR médian" value={stats.ctr.value !== null ? `${stats.ctr.value.toFixed(2)} %` : "—"} sub={sub(stats.ctr.n, "créas")} icon={<MousePointerClick className="w-4 h-4" />} accent="blue" />
      <Kpi label="Hook médian (démarrages / impr.)" value={stats.hookRate.value !== null ? `${stats.hookRate.value.toFixed(1)} %` : "—"} sub={sub(stats.hookRate.n, "vidéos")} icon={<Play className="w-4 h-4" />} accent="violet" />
      <Kpi label="CPA médian" value={fmtMoney(stats.cpa.value, currency, 2)} sub={sub(stats.cpa.n, `créas avec ${conversionLabel}`)} icon={<DollarSign className="w-4 h-4" />} accent="amber" />
      <Kpi label="ROAS médian" value={fmtRoas(stats.roas.value, { estimated: stats.roas.estimated })} sub={stats.roas.estimated ? "* estimé (panier moyen)" : sub(stats.roas.n, "créas avec revenu")} icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
    </Section>
  );
}

// ── Table View ────────────────────────────────────────────────────────────────

interface TableViewProps {
  creatives: Creative[];
  currency: string | null;
  onCreativeClick: (c: Creative) => void;
}

function TableView({ creatives, currency, onCreativeClick }: TableViewProps) {
  const [sortKey, setSortKey] = useState<TableSortKey>("roas");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function handleSort(key: TableSortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "cpa" ? "asc" : "desc");
    }
  }

  // Same medians as the "Médianes du compte" section (filtered list, 0/null excluded).
  const medians = useMemo(() => {
    const m = computeMedians(creatives);
    return {
      spend: m.spend.value ?? 0,
      ctr: m.ctr.value ?? 0,
      hookRate: m.hookRate.value ?? 0,
      roas: m.roas.value ?? 0,
      cpa: m.cpa.value ?? 0,
    };
  }, [creatives]);

  const sorted = useMemo(() => {
    const list = [...creatives];
    list.sort((a, b) => {
      let aVal: number | string = 0;
      let bVal: number | string = 0;
      if (sortKey === "name") { aVal = a.name; bVal = b.name; }
      else if (sortKey === "spend") { aVal = a.spend; bVal = b.spend; }
      else if (sortKey === "ctr") { aVal = a.ctr; bVal = b.ctr; }
      else if (sortKey === "hookRate") { aVal = a.hookRate; bVal = b.hookRate; }
      else if (sortKey === "roas") { aVal = roasOf(a); bVal = roasOf(b); }
      else if (sortKey === "cpa") { aVal = a.cpa; bVal = b.cpa; }
      else if (sortKey === "status") { aVal = a.status; bVal = b.status; }

      if (typeof aVal === "string") {
        return sortDir === "asc"
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal);
      }
      return sortDir === "asc"
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return list;
  }, [creatives, sortKey, sortDir]);

  function cellColor(value: number, median: number, higherIsBetter = true): string {
    if (value === 0 || median === 0) return "";
    const isGood = higherIsBetter ? value > median : value < median;
    return isGood
      ? "bg-emerald-900/30 text-emerald-300"
      : "bg-red-900/30 text-red-300";
  }

  function SortIcon({ col }: { col: TableSortKey }) {
    if (col !== sortKey)
      return <ChevronUpSort className="w-3 h-3 text-gray-600 opacity-40" />;
    return sortDir === "asc" ? (
      <ChevronUpSort className="w-3 h-3 text-violet-400" />
    ) : (
      <ChevronUpSort className="w-3 h-3 text-violet-400 rotate-180" />
    );
  }

  const columns: { key: TableSortKey; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "spend", label: "Spend" },
    { key: "ctr", label: "CTR" },
    { key: "hookRate", label: "Hook (démarrages / impr.)" },
    { key: "roas", label: "ROAS" },
    { key: "cpa", label: "CPA" },
    { key: "status", label: "Status" },
  ];

  return (
    <div className="overflow-x-auto rounded-2xl border border-gray-800 bg-gray-900">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="px-3 py-3 text-left text-[10px] text-gray-500 uppercase tracking-wide w-12">
              Thumb
            </th>
            {columns.map((col) => (
              <th
                key={col.key}
                onClick={() => handleSort(col.key)}
                className="px-3 py-3 text-left text-[10px] text-gray-500 uppercase tracking-wide cursor-pointer hover:text-gray-300 transition-colors select-none"
              >
                <div className="flex items-center gap-1">
                  {col.label}
                  <SortIcon col={col.key} />
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/60">
          {sorted.map((c) => {
            const statusMap: Record<Status, string> = {
              Winner: "bg-green-900/60 text-green-300 border border-green-800",
              Loser: "bg-red-900/60 text-red-300 border border-red-800",
              Fatigued: "bg-orange-900/60 text-orange-300 border border-orange-800",
              Active: "bg-blue-900/60 text-blue-300 border border-blue-800",
            };

            return (
              <tr
                key={c.id}
                onClick={() => onCreativeClick(c)}
                className="hover:bg-gray-800/40 cursor-pointer transition-colors"
              >
                {/* Thumbnail */}
                <td className="px-3 py-2">
                  <div className="w-12 h-12 rounded-lg overflow-hidden shrink-0">
                    <CreativeThumbnail
                      format={c.format}
                      thumbnailColor={c.thumbnailColor}
                      thumbnailUrl={c.thumbnailUrl}
                      videoUrl={c.videoUrl}
                      videoId={c.videoId}
                      className="w-12 h-12"
                    />
                  </div>
                </td>
                {/* Name */}
                <td className="px-3 py-2 max-w-[200px]">
                  <p className="text-xs font-mono text-gray-200 truncate" title={c.name}>
                    {c.name}
                  </p>
                  {c.campaignName && (
                    <p className="text-[10px] text-gray-500 truncate" title={c.campaignName}>{c.campaignName}</p>
                  )}
                </td>
                {/* Spend */}
                <td className={`px-3 py-2 text-xs font-semibold rounded-none ${cellColor(c.spend, medians.spend)}`}>
                  {fmtMoney(c.spend, currency)}
                </td>
                {/* CTR */}
                <td className={`px-3 py-2 text-xs font-semibold ${cellColor(c.ctr, medians.ctr)}`}>
                  {c.ctr.toFixed(2)}%
                </td>
                {/* Hook Rate */}
                <td className={`px-3 py-2 text-xs font-semibold ${cellColor(c.hookRate, medians.hookRate)}`}>
                  {c.hookRate > 0 ? `${c.hookRate.toFixed(1)}%` : "—"}
                </td>
                {/* ROAS */}
                <td className={`px-3 py-2 text-xs font-semibold ${cellColor(roasOf(c), medians.roas)}`}>
                  <RoasValue value={c.roasUnavailable ? null : c.roas} estimated={c.roasEstimated && !c.roasUnavailable} />
                </td>
                {/* CPA */}
                <td className={`px-3 py-2 text-xs font-semibold ${cellColor(c.cpa, medians.cpa, false)}`}>
                  {c.cpa > 0 ? fmtMoney(c.cpa, currency, 2) : "—"}
                </td>
                {/* Status */}
                <td className="px-3 py-2">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusMap[c.status]}`}>
                    {c.status}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && (
        <div className="flex items-center justify-center h-24 text-gray-600 text-sm">
          No creatives match the selected filters.
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CreativesPage() {
  const [platform, setPlatform] = useState<"All" | Platform>("All");
  const [status, setStatus] = useState<"All" | Status>("All");
  const [format, setFormat] = useState<"All" | Format>("All");
  const [sortBy, setSortBy] = useState<SortKey>("roas");
  const [adStatus, setAdStatus] = useState<AdStatus>("ALL");
  const [selectedCreative, setSelectedCreative] = useState<Creative | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("card");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  // Key to re-compute tags after modal closes (localStorage update)
  const [tagsKey, setTagsKey] = useState(0);

  const { creatives, isLoading: loading, error, isRealData, wowData, isWowLoading, metaAccountId, dateRange, currency, meta } = useCreativesContext();
  const conversionLabel = meta?.conversionEvent === "lead" ? "leads" : meta?.conversionEvent && meta.conversionEvent !== "purchase" ? "conversions" : "achats";

  // Refresh tags list when modal closes
  const handleModalClose = useCallback(() => {
    setSelectedCreative(null);
    setTagsKey((k) => k + 1);
  }, []);

  const allTags = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    tagsKey; // dependency to recompute
    return getAllUsedTags(creatives);
  }, [creatives, tagsKey]);

  const filtered = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    tagsKey; // tags live in localStorage: recompute when the drawer closes
    let list = [...creatives];
    if (platform !== "All") list = list.filter((c) => c.platform === platform);
    if (status !== "All") list = list.filter((c) => c.status === status);
    if (format !== "All") list = list.filter((c) => c.format === format);
    // Meta delivery status (ACTIVE vs anything else = paused / inactive) — distinct from the performance status.
    if (adStatus === "ACTIVE") {
      list = list.filter((c) => c.effectiveStatus === "ACTIVE");
    } else if (adStatus === "PAUSED") {
      list = list.filter((c) => !!c.effectiveStatus && c.effectiveStatus !== "ACTIVE");
    }
    if (selectedTag) {
      list = list.filter((c) => getTagsForCreative(c.id).includes(selectedTag));
    }
    list.sort((a, b) => {
      if (sortBy === "cpa") return (a.cpa > 0 ? a.cpa : Infinity) - (b.cpa > 0 ? b.cpa : Infinity);
      if (sortBy === "roas") return roasOf(b) - roasOf(a);
      return (b[sortBy] as number) - (a[sortBy] as number);
    });
    return list;
  }, [creatives, platform, status, format, sortBy, adStatus, selectedTag, tagsKey]);

  // ── KPI summary: Σ then ratio (aggregate), never an average of ratios ─────
  const kpiData = useMemo(() => aggregate(filtered), [filtered]);
  const isEmptyReal = !loading && isRealData && creatives.length === 0 && !error;

  return (
    <div className="p-6 space-y-5">
      {/* Page Help */}
      <PageHelp
        title="Creative Feed — Toutes tes créas"
        description="Analyse toutes tes créas publicitaires en un coup d'oeil. Filtre par spend, type, statut ou tag. Clique sur une créa pour voir le funnel détaillé et les métriques semaine par semaine."
        steps={[
          "Utilise les filtres (statut, format, plateforme) pour cibler les créas qui t'intéressent.",
          "Trie par ROAS, CPA ou Spend pour repérer les top performers et les losers rapidement.",
          "Clique sur une créa pour ouvrir la vue détaillée : funnel, tendances CTR/CPA sur 7 jours, et comparaison WoW.",
        ]}
        tip="Bascule en vue tableau (icône grille en haut à droite) pour comparer plusieurs créas côte à côte en un seul coup d'oeil."
      />
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Creative Feed</h1>
          <p className="text-gray-400 text-sm mt-0.5">{filtered.length} creatives</p>
        </div>
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
            <button
              onClick={() => setViewMode("card")}
              title="Card view"
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                viewMode === "card"
                  ? "bg-violet-600 text-white"
                  : "text-gray-500 hover:text-gray-200"
              }`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode("table")}
              title="Table view"
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                viewMode === "table"
                  ? "bg-violet-600 text-white"
                  : "text-gray-500 hover:text-gray-200"
              }`}
            >
              <Table2 className="w-4 h-4" />
            </button>
          </div>
          {!isRealData && <Pill>Démo</Pill>}
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-900/20 border border-red-800/40 rounded-xl text-xs text-red-300">
          {error}
        </div>
      )}

      {loading && (
        <div className="text-center py-12 text-gray-500 text-sm">Loading creatives...</div>
      )}

      {/* Date Range Picker */}
      <DateRangePicker />

      {/* Explicit empty state: connected account, nothing delivered in the range */}
      {isEmptyReal && (
        <div className="p-6 bg-gray-900 border border-gray-800 rounded-2xl text-center space-y-1">
          <p className="text-sm text-gray-300 font-medium">Aucune annonce avec des impressions sur la période</p>
          <p className="text-xs text-gray-500">
            {dateRange.since} → {dateRange.until}{meta?.accountTotals && meta.accountTotals.spend > 0 ? ` · le compte a pourtant dépensé ${fmtMoney(meta.accountTotals.spend, currency)}` : ""}. Élargis la période ou vérifie le compte sélectionné.
          </p>
        </div>
      )}

      {/* KPI Summary Cards — Σ then ratio over the filtered creatives */}
      {!loading && !isEmptyReal && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            label="Total Spend"
            value={fmtMoney(kpiData.spend, currency)}
            sub={`${filtered.length} créa${filtered.length > 1 ? "s" : ""}${meta?.accountTotals ? ` · compte ${fmtMoney(meta.accountTotals.spend, currency)}` : ""}`}
            icon={DollarSign}
            accent="bg-violet-500/20 text-violet-400"
          />
          <KpiCard
            label="CTR"
            value={fmtPct(kpiData.ctr)}
            sub="Σ clics / Σ impressions"
            icon={MousePointerClick}
            accent="bg-blue-500/20 text-blue-400"
          />
          <KpiCard
            label="Hook (démarrages / impr.)"
            value={kpiData.hookRate !== null ? `${kpiData.hookRate.toFixed(1)}%` : "—"}
            sub={`pondéré par impressions · ${kpiData.videoCount} vidéo${kpiData.videoCount > 1 ? "s" : ""}`}
            icon={Play}
            accent="bg-pink-500/20 text-pink-400"
          />
          <KpiCard
            label="ROAS"
            value={fmtRoas(kpiData.unavailable ? null : kpiData.roas, { estimated: kpiData.estimated })}
            sub={kpiData.unavailable ? "revenu indisponible (pas de valeur trackée ni de panier moyen)" : `Σ revenu / Σ spend · CPA ${fmtMoney(kpiData.cpa, currency, 2)}`}
            icon={TrendingUp}
            accent="bg-emerald-500/20 text-emerald-400"
          />
        </div>
      )}

      {/* Week over Week Banner */}
      {!loading && !isWowLoading && wowData && (
        <WowBanner
          wow={wowData.aggregateWow}
          currentPeriod={wowData.currentPeriod}
          prevPeriod={wowData.prevPeriod}
        />
      )}
      {!loading && isWowLoading && (
        <div className="h-28 bg-gray-900 border border-gray-800 rounded-2xl animate-pulse" />
      )}

      {/* Analyse IA (relay, données réelles uniquement) */}
      {!loading && (
        isRealData && metaAccountId ? (
          <CreativeAiAnalysis accountId={metaAccountId} since={dateRange.since} until={dateRange.until} />
        ) : (
          <Section title="Analyse IA des créas" icon={<Sparkles className="w-4 h-4 text-violet-400" />} bodyClassName="p-4">
            <p className="text-xs text-gray-500">Disponible uniquement sur des données réelles : connecte un compte Meta pour lancer l&apos;analyse.</p>
          </Section>
        )
      )}

      {/* Médianes du compte */}
      {!loading && !isEmptyReal && (
        <AccountMediansSection creatives={filtered} currency={currency} conversionLabel={conversionLabel} />
      )}

      {/* Filters Bar (campaign + ad status) */}
      <FiltersBar
        accountId={metaAccountId}
        adStatus={adStatus}
        onAdStatusChange={setAdStatus}
      />

      {/* Creatives to Scale (filtered list, delivering ads only) */}
      {!loading && (
        <CreativesToScaleSection
          creatives={filtered}
          currency={currency}
          onCreativeClick={setSelectedCreative}
        />
      )}

      {/* Creatives to Cut (filtered list, delivering ads only) */}
      {!loading && (
        <CreativesToCutSection
          creatives={filtered}
          currency={currency}
          onCreativeClick={setSelectedCreative}
        />
      )}

      {/* Filter Bar */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Platform */}
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
          {(["All", "Meta", "TikTok"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                platform === p
                  ? "bg-violet-600 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Status */}
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
          {(["All", "Winner", "Active", "Fatigued", "Loser"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                status === s
                  ? "bg-violet-600 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Format */}
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
          {(["All", "Video", "Image", "Carousel"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFormat(f)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                format === f
                  ? "bg-violet-600 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-2 ml-auto bg-gray-900 border border-gray-800 rounded-xl px-3 py-2">
          <ArrowUpDown className="w-4 h-4 text-gray-500" />
          <span className="text-gray-500 text-sm">Sort:</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            className="bg-transparent text-gray-300 text-sm outline-none cursor-pointer"
          >
            <option value="roas">ROAS</option>
            <option value="cpa">CPA (low→high)</option>
            <option value="spend">Spend</option>
            <option value="ctr">CTR</option>
            <option value="hookRate">Hook (démarrages / impr.)</option>
          </select>
        </div>
      </div>

      {/* Tag filter */}
      {allTags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Tag className="w-3.5 h-3.5" />
            <span>Tags:</span>
          </div>
          <button
            onClick={() => setSelectedTag(null)}
            className={`text-xs font-semibold px-2.5 py-1 rounded-full border transition-colors ${
              selectedTag === null
                ? "bg-violet-600 border-violet-500 text-white"
                : "bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200"
            }`}
          >
            All
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
              className={`flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border transition-colors ${
                selectedTag === tag
                  ? "bg-violet-500/20 border-violet-500/50 text-violet-300"
                  : "bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200"
              }`}
            >
              {tag}
              {selectedTag === tag && <X className="w-3 h-3" />}
            </button>
          ))}
        </div>
      )}

      {/* Table View */}
      {!loading && viewMode === "table" && (
        <TableView creatives={filtered} currency={currency} onCreativeClick={setSelectedCreative} />
      )}

      {/* Grid */}
      {!loading && viewMode === "card" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((creative) => (
            <div
              key={creative.id}
              onClick={() => setSelectedCreative(creative)}
              className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden hover:border-violet-700/60 hover:shadow-xl hover:shadow-violet-900/20 transition-all duration-200 group cursor-pointer"
            >
              {/* Thumbnail */}
              <div className="relative">
                <CreativeThumbnail
                  format={creative.format}
                  thumbnailColor={creative.thumbnailColor}
                  thumbnailUrl={creative.thumbnailUrl}
                  videoUrl={creative.videoUrl}
                  videoId={creative.videoId}
                  className="h-36"
                />
                <div className="absolute top-2 left-2 z-10">
                  <PlatformBadge platform={creative.platform} />
                </div>
                <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
                  <ScoreBadge creative={creative} />
                  <StatusBadge status={creative.status} />
                </div>
                <div className="absolute bottom-2 left-2 z-10 text-[10px] font-medium text-white/60 uppercase tracking-wide">
                  {creative.format}
                </div>
              </div>

              {/* Body */}
              <div className="p-3 space-y-3">
                <div>
                  <p className="text-xs font-mono text-gray-300 truncate" title={creative.name}>
                    {creative.name}
                  </p>
                  <CreativeLabelTags creative={creative} allCreatives={creatives} />
                </div>

                {/* Sparkline (ROAS trend — last 7 points) */}
                <div className="h-9">
                  <Sparkline data={creative.trend} />
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-3 gap-1 pt-1 border-t border-gray-800">
                  <MetricPill label="Spend" value={fmtMoney(creative.spend, currency)} />
                  <MetricPill label="ROAS" value={fmtRoas(creative.roasUnavailable ? null : creative.roas, { estimated: creative.roasEstimated })} />
                  <MetricPill label="CPA" value={creative.cpa > 0 ? fmtMoney(creative.cpa, currency, 2) : "—"} />
                </div>
                <div className="grid grid-cols-3 gap-1">
                  <MetricPill label="CTR" value={`${creative.ctr}%`} />
                  <MetricPill
                    label="Hook"
                    value={creative.hookRate > 0 ? `${creative.hookRate}%` : "—"}
                  />
                  <MetricPill
                    label="Hold"
                    value={creative.holdRate > 0 ? `${creative.holdRate}%` : "—"}
                  />
                </div>

                {/* Week-over-Week indicators */}
                {wowData && (() => {
                  const wow: WowMetrics | undefined = wowData.wowByAdId[creative.id];
                  if (!wow) return null;
                  const hasAnyData = [
                    wow.spendChange,
                    wow.roasChange,
                    wow.ctrChange,
                    wow.cpaChange,
                    wow.hookRateChange,
                  ].some((v) => v !== null);
                  if (!hasAnyData) return null;
                  return (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1.5 border-t border-gray-800/60">
                      <WowChip metricKey="roasChange" change={wow.roasChange} label="ROAS" />
                      <WowChip metricKey="ctrChange" change={wow.ctrChange} label="CTR" />
                      <WowChip metricKey="cpaChange" change={wow.cpaChange} label="CPA" />
                      {creative.hookRate > 0 && (
                        <WowChip metricKey="hookRateChange" change={wow.hookRateChange} label="Hook" />
                      )}
                      <WowChip metricKey="spendChange" change={wow.spendChange} label="Spend" />
                      <span className="text-[9px] text-gray-700 self-center">WoW</span>
                    </div>
                  );
                })()}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && !isEmptyReal && filtered.length === 0 && viewMode === "card" && (
        <div className="flex items-center justify-center h-48 text-gray-600">
          Aucune créa ne correspond aux filtres sélectionnés.
        </div>
      )}

      {!loading && filtered.some((c) => c.roasEstimated && !c.roasUnavailable) && (
        <p className="text-[10px] text-gray-600">* ROAS estimé (conversions × panier moyen) : le compte ne remonte pas la valeur d&apos;achat.</p>
      )}
      {!loading && filtered.length > 0 && filtered.every((c) => c.roasUnavailable) && (
        <p className="text-[10px] text-gray-600">ROAS indisponible : le compte ne remonte pas de valeur d&apos;achat et aucun panier moyen n&apos;est configuré (Admin → Comptes).</p>
      )}

      {/* Creative Detail Modal */}
      <CreativeModal
        creative={selectedCreative}
        onClose={handleModalClose}
      />
    </div>
  );
}
