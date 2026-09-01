"use client";

import { useMemo, useState } from "react";
import { useCreativesContext, useMoney } from "@/lib/creatives-context";
import { MessageSquare, ChevronUp, ChevronDown, Trophy, Flame, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNamingConfig } from "@/lib/use-naming-config";
import { bySegment, findSegmentIndex, sortGroups, UNCATEGORIZED_KEY, type Group, type RankMetric } from "@/lib/creative-stats";
import { fmtPct, plural } from "@/lib/creative-format";
import { PageHelp } from "@/components/ui/page-help";
import { Kpi, PageHeader, Section, Pill } from "@/components/ui/surface";
import { MetricInfoButton } from "@/components/metric-info-button";
import { RoasValue } from "@/components/roas-value";
import Link from "next/link";

type SortKey = RankMetric | "count" | "hitRate";

const ANGLE_PATTERN = /angle/i;

function HitBadge({ rate }: { rate: number }) {
  if (rate >= 30)
    return <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-semibold"><Trophy className="w-3 h-3" />Proven</span>;
  if (rate < 10)
    return <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 font-semibold"><Flame className="w-3 h-3" />Weak</span>;
  return <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-400 border border-gray-600 font-semibold"><Activity className="w-3 h-3" />Testing</span>;
}

function SortIcon({ k, sortKey, sortAsc }: { k: SortKey; sortKey: SortKey; sortAsc: boolean }) {
  if (sortKey !== k) return <ChevronUp className="w-3 h-3 opacity-30" />;
  return sortAsc ? <ChevronUp className="w-3 h-3 text-violet-400" /> : <ChevronDown className="w-3 h-3 text-violet-400" />;
}

function sortAngles(groups: Group[], key: SortKey, asc: boolean): Group[] {
  const known = groups.filter((g) => g.key !== UNCATEGORIZED_KEY);
  const unknown = groups.filter((g) => g.key === UNCATEGORIZED_KEY);
  const sorted =
    key === "hitRate"
      ? [...known].sort((a, b) => (asc ? a.stats.hitRate - b.stats.hitRate : b.stats.hitRate - a.stats.hitRate))
      : sortGroups(known, key, asc);
  return [...sorted, ...unknown];
}

export default function AnglesPage() {
  const { creatives, isLoading } = useCreativesContext();
  const money = useMoney();
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortAsc, setSortAsc] = useState(false);
  const namingConfig = useNamingConfig();

  const segmentIdx = findSegmentIndex(namingConfig, ANGLE_PATTERN);
  const segment = segmentIdx >= 0 ? namingConfig.segments[segmentIdx] : null;
  const isFallback = !!segment && !ANGLE_PATTERN.test(segment.label);

  const groups = useMemo(() => {
    if (segmentIdx < 0) return [];
    return bySegment(creatives, namingConfig, segmentIdx);
  }, [creatives, namingConfig, segmentIdx]);

  const sorted = useMemo(() => sortAngles(groups, sortKey, sortAsc), [groups, sortKey, sortAsc]);
  const known = groups.filter((g) => g.key !== UNCATEGORIZED_KEY);
  const uncategorized = groups.find((g) => g.key === UNCATEGORIZED_KEY) ?? null;
  const totalSpend = groups.reduce((s, g) => s + g.stats.spend, 0);
  const proven = known.filter((g) => g.stats.hitRate >= 30);
  const bestRoas = sortGroups(known.filter((g) => g.stats.spend > 0 && g.stats.roas !== null && g.stats.roas > 0), "roas")[0] ?? null;

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((a) => !a);
    else {
      setSortKey(key);
      setSortAsc(key === "cpa");
    }
  }

  const sortIcon = (k: SortKey) => <SortIcon k={k} sortKey={sortKey} sortAsc={sortAsc} />;

  return (
    <div className="flex-1 overflow-auto bg-gray-950 p-6 space-y-6">
      <PageHelp
        title="Angles — Quel message résonne le mieux ?"
        description="Les angles sont lus dans le nom de chaque annonce, sur le segment de ta naming convention dont le libellé contient « Angle » (sinon le dernier segment). Spend, clics et achats sont cumulés par angle."
        steps={[
          "Vérifie que ta naming convention est configurée (page Naming) avec un segment libellé « Angle ».",
          "Trie par Spend pour voir où va le budget, par ROAS ou CPA pour identifier les messages rentables.",
          "Un angle « Proven » (Hit Rate ≥ 30 % de winners) mérite d'être décliné dans d'autres formats.",
        ]}
        tip="Le Hit Rate repose sur le statut Winner/Loser calculé par l'outil à partir du ROAS, du CTR et du hook rate — pas sur un champ Meta."
      />

      <PageHeader
        title="Angles"
        subtitle={
          segment ? (
            <span>
              Segment lu : <span className="font-mono text-gray-300">{segment.label}</span> (position {segment.position + 1}
              , séparateur « {namingConfig.separator} »)
              {isFallback && (
                <span className="text-amber-400"> — aucun segment nommé « Angle », dernier segment utilisé par défaut</span>
              )}
            </span>
          ) : (
            <span>
              Aucun segment configuré — <Link href="/naming" className="text-violet-400 hover:text-violet-300">configurer la naming convention</Link>
            </span>
          )
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Angles testés" value={known.length} icon={<MessageSquare className="w-4 h-4" />} sub={uncategorized ? `${plural(uncategorized.stats.count, "annonce")} non catégorisée${uncategorized.stats.count > 1 ? "s" : ""}` : undefined} />
        <Kpi label="Angles Proven" value={proven.length} accent="emerald" />
        <Kpi label="Spend total" value={money(totalSpend)} accent="gray" />
        <Kpi
          label="Meilleur ROAS"
          value={bestRoas ? bestRoas.label : "—"}
          sub={bestRoas ? <RoasValue value={bestRoas.stats.roas} estimated={bestRoas.stats.estimated} /> : "aucun revenu attribué"}
          accent="violet"
        />
      </div>

      {proven.length > 0 && (
        <Section tone="positive" title="Angles Proven (Hit Rate ≥ 30 %)" icon={<Trophy className="w-4 h-4 text-emerald-400" />} bodyClassName="p-4 flex flex-wrap gap-2">
          {proven.map((g) => (
            <div key={g.key} className="bg-emerald-900/30 border border-emerald-500/30 rounded-lg px-3 py-1.5">
              <span className="text-emerald-300 font-semibold text-sm">{g.label}</span>
              <span className="text-emerald-500 text-xs ml-2">
                {fmtPct(g.stats.hitRate, 0)} · ROAS <RoasValue value={g.stats.roas} estimated={g.stats.estimated} />
              </span>
            </div>
          ))}
        </Section>
      )}

      <Section bodyClassName="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500 text-xs">
              <th className="text-left px-4 py-3 font-medium">Angle</th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("count")}>
                <span className="flex items-center justify-end gap-1"># Ads {sortIcon("count")}</span>
              </th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("spend")}>
                <span className="flex items-center justify-end gap-1">Spend <MetricInfoButton metricKey="spend" /> {sortIcon("spend")}</span>
              </th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("roas")}>
                <span className="flex items-center justify-end gap-1">ROAS <MetricInfoButton metricKey="roas" /> {sortIcon("roas")}</span>
              </th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("cpa")}>
                <span className="flex items-center justify-end gap-1">CPA <MetricInfoButton metricKey="cpa" /> {sortIcon("cpa")}</span>
              </th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("ctr")}>
                <span className="flex items-center justify-end gap-1">CTR <MetricInfoButton metricKey="ctr" /> {sortIcon("ctr")}</span>
              </th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleSort("hitRate")}>
                <span className="flex items-center justify-end gap-1">Hit Rate <MetricInfoButton metricKey="hitRate" /> {sortIcon("hitRate")}</span>
              </th>
              <th className="text-right px-4 py-3 font-medium">Statut</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((g, i) => {
              const isUnknown = g.key === UNCATEGORIZED_KEY;
              return (
                <tr key={g.key} className={cn("border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors", i === sorted.length - 1 && "border-0", isUnknown && "opacity-60")}>
                  <td className="px-4 py-3 text-gray-200 font-medium">
                    {isUnknown ? <span className="italic text-gray-500">{g.label}</span> : g.label}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400">{g.stats.count}</td>
                  <td className="px-4 py-3 text-right text-gray-200">{money(g.stats.spend)}</td>
                  <td className="px-4 py-3 text-right font-semibold"><RoasValue value={g.stats.roas} estimated={g.stats.estimated} tone /></td>
                  <td className="px-4 py-3 text-right text-gray-200">{money(g.stats.cpa, 2)}</td>
                  <td className="px-4 py-3 text-right text-gray-200">{fmtPct(g.stats.ctr)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div className={cn("h-full rounded-full", g.stats.hitRate >= 30 ? "bg-emerald-500" : g.stats.hitRate >= 10 ? "bg-amber-500" : "bg-red-500")} style={{ width: `${Math.min(100, g.stats.hitRate)}%` }} />
                      </div>
                      <span className={cn("font-semibold text-xs w-8 text-right", g.stats.hitRate >= 30 ? "text-emerald-400" : g.stats.hitRate < 10 ? "text-red-400" : "text-gray-400")}>
                        {fmtPct(g.stats.hitRate, 0)}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">{isUnknown ? <Pill>n/a</Pill> : <HitBadge rate={g.stats.hitRate} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {!isLoading && sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-600">
            <MessageSquare className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">Aucun angle trouvé</p>
            <p className="text-xs mt-1">Configure ta naming convention sur la page Naming</p>
          </div>
        )}
        {isLoading && <div className="text-center py-16 text-gray-500 text-sm">Chargement…</div>}
      </Section>
    </div>
  );
}
