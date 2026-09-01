"use client";

import { useMemo, useState } from "react";
import type { Creative } from "@/lib/creative-types";
import { useCreativesContext, useMoney } from "@/lib/creatives-context";
import { byCopy, sortGroups, bestCreative, worstCreative, NO_COPY_KEY, type Group, type CopyMeta, type RankMetric } from "@/lib/creative-stats";
import { fmtPct, plural } from "@/lib/creative-format";
import { FileText, ArrowUpDown, ChevronDown, ChevronUp, Video } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHelp } from "@/components/ui/page-help";
import { Card, Kpi, PageHeader, Pill } from "@/components/ui/surface";
import { MetricInfoButton } from "@/components/metric-info-button";
import { DateRangePicker } from "@/components/date-range-picker";
import { GroupAdsList } from "@/components/group-ads-list";
import { CreativeModal } from "@/components/creative-modal";
import { RoasValue } from "@/components/roas-value";

type SortKey = Extract<RankMetric, "spend" | "roas" | "ctr" | "cpa">;

const SORT_OPTIONS: { key: SortKey; label: string; asc?: boolean }[] = [
  { key: "spend", label: "Spend" },
  { key: "roas", label: "ROAS" },
  { key: "ctr", label: "CTR" },
  { key: "cpa", label: "CPA", asc: true },
];

function AdRef({ label, creative, onSelect }: { label: string; creative: Creative | null; onSelect: (c: Creative) => void }) {
  if (!creative) return null;
  return (
    <button
      type="button"
      onClick={() => onSelect(creative)}
      className="flex items-center gap-2 text-left min-w-0 hover:text-white transition-colors"
      title={creative.name}
    >
      <span className="text-[10px] uppercase tracking-wide text-gray-500 shrink-0">{label}</span>
      <span className="text-xs text-gray-300 truncate">{creative.name}</span>
      <RoasValue value={creative.spend > 0 && !creative.roasUnavailable ? creative.roas : null} estimated={creative.roasEstimated && !creative.roasUnavailable} tone className="text-xs font-semibold shrink-0" />
    </button>
  );
}

function CopyRow({
  group,
  rank,
  totalSpend,
  onSelect,
}: {
  group: Group<CopyMeta>;
  rank: number;
  totalSpend: number;
  onSelect: (c: Creative) => void;
}) {
  const money = useMoney();
  const [expanded, setExpanded] = useState(false);
  const [fullText, setFullText] = useState(false);
  const { stats, meta } = group;
  const isTop = rank <= 3 && group.key !== NO_COPY_KEY;
  const share = totalSpend > 0 ? (stats.spend / totalSpend) * 100 : 0;
  const best = stats.count > 1 ? bestCreative(group.creatives, "roas") : null;
  const worst = stats.count > 1 ? worstCreative(group.creatives, "roas") : null;

  return (
    <Card className={cn("overflow-hidden", isTop && "border-violet-500/40")}>
      <div className="p-4 flex gap-4">
        {/* Rank */}
        <div
          className={cn(
            "w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold shrink-0",
            isTop ? "bg-violet-600 text-white" : "bg-gray-800 text-gray-400",
          )}
        >
          {group.key === NO_COPY_KEY ? "—" : rank}
        </div>

        {/* Copy */}
        <div className="flex-1 min-w-0 space-y-2">
          {meta.headline && (
            <p className="text-sm font-semibold text-white leading-snug">{meta.headline}</p>
          )}
          {meta.body ? (
            <div>
              <p className={cn("text-xs text-gray-400 leading-relaxed whitespace-pre-line", !fullText && "line-clamp-3")}>
                {meta.body}
              </p>
              {meta.body.length > 180 && (
                <button
                  type="button"
                  onClick={() => setFullText((v) => !v)}
                  className="text-[11px] text-violet-400 hover:text-violet-300 mt-1"
                >
                  {fullText ? "Réduire" : "Voir le texte complet"}
                </button>
              )}
            </div>
          ) : group.key === NO_COPY_KEY ? (
            <p className="text-xs text-gray-500 italic">Ces annonces n&apos;exposent ni texte principal ni titre dans l&apos;API Meta.</p>
          ) : (
            <p className="text-xs text-gray-500 italic">Titre seul — pas de texte principal renvoyé par l&apos;API.</p>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <Pill tone={isTop ? "violet" : "default"}>{plural(stats.count, "annonce")}</Pill>
            {stats.videoCount > 0 && (
              <Pill>
                <Video className="w-3 h-3 inline mr-1 -mt-0.5" />
                {stats.videoCount} vidéo{stats.videoCount > 1 ? "s" : ""}
              </Pill>
            )}
            <span className="text-[11px] text-gray-500">{share.toFixed(0)}% du spend</span>
          </div>

          {(best || worst) && (
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 pt-1 border-t border-gray-800/60">
              <AdRef label="Meilleure" creative={best} onSelect={onSelect} />
              {worst && worst.id !== best?.id && <AdRef label="Pire" creative={worst} onSelect={onSelect} />}
            </div>
          )}
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-x-5 gap-y-2 shrink-0 text-right self-start">
          <Metric label="Spend" metricKey="spend" value={money(stats.spend)} />
          <Metric label="CTR" metricKey="ctr" value={fmtPct(stats.ctr)} />
          <Metric label="CPA" metricKey="cpa" value={money(stats.cpa, 2)} />
          <Metric label="ROAS" metricKey="roas" value={<RoasValue value={stats.roas} estimated={stats.estimated} tone />} />
          <Metric label="Hook" metricKey="hookRate" value={stats.videoCount > 0 ? fmtPct(stats.hookRate, 1) : "—"} />
        </div>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-gray-500 hover:text-gray-200 border-t border-gray-800/60 hover:bg-gray-800/30 transition-colors"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        {expanded ? "Masquer les annonces" : `Voir les ${plural(stats.count, "annonce")}`}
      </button>
      {expanded && (
        <div className="p-4 pt-3 bg-gray-950/40 border-t border-gray-800/60">
          <GroupAdsList creatives={group.creatives} onSelect={onSelect} />
        </div>
      )}
    </Card>
  );
}

function Metric({ label, metricKey, value }: { label: string; metricKey: string; value: React.ReactNode }) {
  return (
    <div className="min-w-[56px]">
      <p className="text-[10px] uppercase tracking-wide text-gray-500 flex items-center justify-end gap-0.5">
        {label} <MetricInfoButton metricKey={metricKey} />
      </p>
      <p className="text-sm font-semibold text-gray-100">{value}</p>
    </div>
  );
}

export default function TopCopyPage() {
  const { creatives, isLoading, isRealData } = useCreativesContext();
  const money = useMoney();
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [selected, setSelected] = useState<Creative | null>(null);

  const groups = useMemo(() => byCopy(creatives), [creatives]);

  const sorted = useMemo(() => {
    const opt = SORT_OPTIONS.find((o) => o.key === sortKey)!;
    const withCopy = groups.filter((g) => g.key !== NO_COPY_KEY);
    const noCopy = groups.filter((g) => g.key === NO_COPY_KEY);
    return [...sortGroups(withCopy, sortKey, opt.asc), ...noCopy];
  }, [groups, sortKey]);

  const totalSpend = useMemo(() => groups.reduce((s, g) => s + g.stats.spend, 0), [groups]);
  const variants = groups.filter((g) => g.key !== NO_COPY_KEY);
  const bestRoas = useMemo(() => sortGroups(variants.filter((g) => g.stats.roas !== null && g.stats.spend > 0), "roas")[0] ?? null, [variants]);
  const noCopyCount = groups.find((g) => g.key === NO_COPY_KEY)?.stats.count ?? 0;

  return (
    <div className="flex-1 overflow-auto bg-gray-950 p-6 space-y-6">
      <PageHelp
        title="Top Copy — Textes d'annonce qui convertissent"
        description="Les annonces sont regroupées par texte principal (body) identique, avec le titre le plus utilisé. Chaque variante cumule le spend, les clics et les achats réels de ses annonces : les taux sont recalculés sur les totaux, pas moyennés."
        steps={[
          "Trie par ROAS ou CPA pour repérer les formulations rentables, par Spend pour voir où part le budget.",
          "Déplie une variante pour voir les annonces qui l'utilisent et ouvrir chaque créa.",
          "Compare la meilleure et la pire annonce d'une même variante : si l'écart est grand, le visuel compte plus que le texte.",
        ]}
        tip="Un ROAS suivi d'un astérisque est estimé à partir du panier moyen (le compte ne remonte pas la valeur des achats)."
      />

      <PageHeader
        title="Top Copy"
        subtitle={
          isRealData
            ? `${plural(variants.length, "variante")} de texte sur ${plural(creatives.length, "annonce")}`
            : "Données de démonstration — connecte un compte Meta pour tes vrais textes"
        }
        action={<DateRangePicker />}
      />

      {!isLoading && creatives.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi label="Variantes de texte" value={variants.length} icon={<FileText className="w-4 h-4" />} sub={noCopyCount > 0 ? `${noCopyCount} sans texte` : undefined} />
          <Kpi label="Annonces" value={creatives.length} accent="blue" />
          <Kpi label="Spend total" value={money(totalSpend)} accent="gray" />
          <Kpi
            label="Meilleur ROAS"
            value={bestRoas ? <RoasValue value={bestRoas.stats.roas} estimated={bestRoas.stats.estimated} /> : "—"}
            sub={bestRoas ? bestRoas.label : "aucun spend sur la période"}
            accent="emerald"
          />
        </div>
      )}

      <div className="flex items-center gap-1 flex-wrap">
        <ArrowUpDown className="w-3.5 h-3.5 text-gray-500" />
        <span className="text-xs text-gray-500 mr-1">Trier par</span>
        {SORT_OPTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSortKey(s.key)}
            className={cn(
              "px-2.5 py-1 rounded-lg text-xs font-medium transition-all",
              sortKey === s.key ? "bg-violet-600 text-white" : "bg-gray-900 text-gray-400 hover:text-gray-200",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-16 text-gray-500 text-sm">Chargement…</div>
      ) : sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-gray-600">
          <FileText className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">Aucune annonce sur la période</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((g, i) => (
            <CopyRow key={g.key} group={g} rank={i + 1} totalSpend={totalSpend} onSelect={setSelected} />
          ))}
        </div>
      )}

      <CreativeModal creative={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
