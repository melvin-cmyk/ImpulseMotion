"use client";

import { useMemo, useState } from "react";
import type { Creative } from "@/lib/creative-types";
import { useCreativesContext, useMoney } from "@/lib/creatives-context";
import { byAdset, groupBy, sortGroups, median, aggregate, type Group, type RankMetric } from "@/lib/creative-stats";
import type { AudienceTags } from "@/lib/audience-config";
import { useAudienceTags, replaceAudienceTags } from "@/lib/use-audience-tags";
import { fmtPct, fmtX, plural, type MoneyFmt } from "@/lib/creative-format";
import { Users, ChevronUp, ChevronDown, X, Save, Tag, Calculator, Layers, ChevronRight } from "lucide-react";
import { MetricInfoButton } from "@/components/metric-info-button";
import { PageHelp } from "@/components/ui/page-help";
import { Card, Kpi, PageHeader, Section, Pill } from "@/components/ui/surface";
import { DateRangePicker } from "@/components/date-range-picker";
import { GroupAdsList } from "@/components/group-ads-list";
import { CreativeModal } from "@/components/creative-modal";
import { RoasValue } from "@/components/roas-value";
import { cn } from "@/lib/utils";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

type Tab = "adset" | "tags";
type SortKey = RankMetric | "count" | "frequency" | "hitRate";

const UNASSIGNED = "Unassigned";

// ── Shared bits ───────────────────────────────────────────────────────────────

function MiniThumbs({ creatives, max = 4 }: { creatives: Creative[]; max?: number }) {
  const shown = creatives.slice(0, max);
  return (
    <div className="flex gap-1">
      {shown.map((c) =>
        c.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={c.id} src={c.thumbnailUrl} alt={c.name} className="w-7 h-7 rounded object-cover border border-gray-700" />
        ) : (
          <div key={c.id} className={`w-7 h-7 rounded border border-gray-700 bg-gradient-to-br ${c.thumbnailColor}`} />
        ),
      )}
      {creatives.length > max && (
        <div className="w-7 h-7 rounded border border-gray-700 bg-gray-800 flex items-center justify-center text-gray-400 text-xs font-semibold">
          +{creatives.length - max}
        </div>
      )}
    </div>
  );
}

interface TooltipEntry {
  dataKey: string;
  name: string;
  value: number | null;
  fill: string;
  color: string;
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipEntry[]; label?: string }) {
  const money = useMoney();
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs shadow-xl max-w-xs">
      <p className="text-gray-200 font-semibold mb-2 break-words">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex justify-between gap-4">
          <span style={{ color: p.fill ?? p.color }}>{p.name}</span>
          <span className="text-gray-200 font-medium">
            {p.dataKey === "Spend" ? money(p.value) : fmtX(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function sortBy<T>(groups: Group<T>[], key: SortKey, asc: boolean, lastKey?: string): Group<T>[] {
  const main = lastKey ? groups.filter((g) => g.key !== lastKey) : groups;
  const tail = lastKey ? groups.filter((g) => g.key === lastKey) : [];
  let sorted: Group<T>[];
  if (key === "frequency" || key === "hitRate") {
    sorted = [...main].sort((a, b) => {
      const av = a.stats[key];
      const bv = b.stats[key];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return asc ? av - bv : bv - av;
    });
  } else {
    sorted = sortGroups(main, key, asc);
  }
  return [...sorted, ...tail];
}

function SortIcon({ k, sortKey, sortAsc }: { k: SortKey; sortKey: SortKey; sortAsc: boolean }) {
  if (sortKey !== k) return <ChevronUp className="w-3 h-3 opacity-30" />;
  return sortAsc ? <ChevronUp className="w-3 h-3 text-violet-400" /> : <ChevronDown className="w-3 h-3 text-violet-400" />;
}

function useSort(initial: SortKey) {
  const [sortKey, setSortKey] = useState<SortKey>(initial);
  const [sortAsc, setSortAsc] = useState(false);
  function toggle(key: SortKey) {
    if (sortKey === key) setSortAsc((a) => !a);
    else {
      setSortKey(key);
      setSortAsc(key === "cpa");
    }
  }
  const icon = (k: SortKey) => <SortIcon k={k} sortKey={sortKey} sortAsc={sortAsc} />;
  return { sortKey, sortAsc, toggle, icon };
}

function Th({ children, onClick, className }: { children: React.ReactNode; onClick?: () => void; className?: string }) {
  return (
    <th
      className={cn("px-4 py-3 font-medium whitespace-nowrap", onClick && "cursor-pointer hover:text-gray-300", className ?? "text-right")}
      onClick={onClick}
    >
      <span className={cn("flex items-center gap-1", className?.includes("text-left") ? "" : "justify-end")}>{children}</span>
    </th>
  );
}

// ── Adset view (primary) ──────────────────────────────────────────────────────

function computeFacts(groups: Group[], money: MoneyFmt): { label: string; text: string; tone: "emerald" | "amber" | "blue" }[] {
  const facts: { label: string; text: string; tone: "emerald" | "amber" | "blue" }[] = [];
  if (groups.length === 0) return facts;

  const withRoas = groups.filter((g) => g.stats.spend > 0 && g.stats.roas !== null && g.stats.roas > 0);
  const topRoas = sortGroups(withRoas, "roas")[0];
  facts.push({
    label: "Meilleur ROAS",
    tone: "emerald",
    text: topRoas
      ? `${topRoas.label} — ${fmtX(topRoas.stats.roas)}${topRoas.stats.estimated ? "*" : ""} sur ${money(topRoas.stats.spend)} de spend (${plural(topRoas.stats.count, "annonce")}).`
      : "Aucun adset n'a de revenu attribué sur la période.",
  });

  const medianSpend = median(groups.map((g) => g.stats.spend)) ?? 0;
  const heavy = groups.filter((g) => g.stats.spend > medianSpend && g.stats.cpa !== null);
  const worstCpa = sortGroups(heavy, "cpa")[0];
  facts.push({
    label: "CPA le plus élevé (spend > médiane)",
    tone: "amber",
    text: worstCpa
      ? `${worstCpa.label} — CPA ${money(worstCpa.stats.cpa, 2)} pour ${worstCpa.stats.conversions} achat${worstCpa.stats.conversions > 1 ? "s" : ""} (${money(worstCpa.stats.spend)} dépensés, médiane ${money(medianSpend)}).`
      : `Aucun adset au-dessus de la médiane de spend (${money(medianSpend)}) n'a d'achat attribué.`,
  });

  const withFreq = groups.filter((g) => g.stats.frequency !== null);
  const mostFrequent = sortBy(withFreq, "frequency", false)[0];
  facts.push({
    label: "Fréquence la plus haute",
    tone: "blue",
    text: mostFrequent
      ? `${mostFrequent.label} — ${fmtX(mostFrequent.stats.frequency)} impressions par personne touchée (${plural(mostFrequent.stats.count, "annonce")}).`
      : "Le reach n'est pas disponible sur ces annonces.",
  });

  return facts;
}

function AdsetView({ creatives, onSelect }: { creatives: Creative[]; onSelect: (c: Creative) => void }) {
  const { sortKey, sortAsc, toggle, icon } = useSort("spend");
  const [expanded, setExpanded] = useState<string | null>(null);

  const groups = useMemo(() => byAdset(creatives), [creatives]);
  const sorted = useMemo(() => sortBy(groups, sortKey, sortAsc), [groups, sortKey, sortAsc]);
  const total = useMemo(() => aggregate(creatives), [creatives]);
  const money = useMoney();
  const facts = useMemo(() => computeFacts(groups, money), [groups, money]);

  const chartData = useMemo(
    () =>
      groups.slice(0, 12).map((g) => ({
        name: g.label.length > 18 ? `${g.label.slice(0, 17)}…` : g.label,
        fullName: g.label,
        Spend: Math.round(g.stats.spend),
        ROAS: g.stats.roas,
      })),
    [groups],
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Adsets" value={groups.length} icon={<Layers className="w-4 h-4" />} sub={plural(creatives.length, "annonce")} />
        <Kpi label="Spend total" value={money(total.spend)} accent="gray" />
        <Kpi label="ROAS global" value={<RoasValue value={total.roas} estimated={total.estimated} />} accent="emerald" sub="revenu / spend cumulés" />
        <Kpi label="Fréquence moyenne" value={fmtX(total.frequency)} accent="blue" sub="impressions / reach" />
      </div>

      {chartData.length > 0 && (
        <Section title="Spend vs ROAS par adset" bodyClassName="p-4">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData} margin={{ top: 4, right: 24, left: 8, bottom: 4 }} barGap={4}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="name" tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="spend" orientation="left" tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => money(v)} />
              <YAxis yAxisId="roas" orientation="right" tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}x`} />
              <Tooltip content={<ChartTooltip />} labelFormatter={(_, payload) => (payload?.[0]?.payload as { fullName?: string } | undefined)?.fullName ?? ""} />
              <Legend wrapperStyle={{ fontSize: 12, color: "#9ca3af" }} />
              <Bar yAxisId="spend" dataKey="Spend" fill="#8b5cf6" radius={[4, 4, 0, 0]} barSize={28} />
              <Bar yAxisId="roas" dataKey="ROAS" fill="#10b981" radius={[4, 4, 0, 0]} barSize={28} />
            </BarChart>
          </ResponsiveContainer>
        </Section>
      )}

      <Section title="Performance par adset" bodyClassName="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500 text-xs">
              <Th className="text-left">Adset</Th>
              <Th className="text-left">Créas</Th>
              <Th onClick={() => toggle("count")}># {icon("count")}</Th>
              <Th onClick={() => toggle("spend")}>Spend <MetricInfoButton metricKey="spend" /> {icon("spend")}</Th>
              <Th onClick={() => toggle("ctr")}>CTR <MetricInfoButton metricKey="ctr" /> {icon("ctr")}</Th>
              <Th onClick={() => toggle("cpa")}>CPA <MetricInfoButton metricKey="cpa" /> {icon("cpa")}</Th>
              <Th onClick={() => toggle("roas")}>ROAS <MetricInfoButton metricKey="roas" /> {icon("roas")}</Th>
              <Th onClick={() => toggle("frequency")}>Fréquence <MetricInfoButton metricKey="frequency" /> {icon("frequency")}</Th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((g) => {
              const isOpen = expanded === g.key;
              const campaign = g.creatives[0]?.campaignName;
              return (
                <RowGroup key={g.key}>
                  <tr
                    className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors cursor-pointer"
                    onClick={() => setExpanded(isOpen ? null : g.key)}
                  >
                    <td className="px-4 py-3 max-w-xs">
                      <p className="text-gray-200 font-medium truncate" title={g.label}>{g.label}</p>
                      {campaign && <p className="text-[11px] text-gray-500 truncate" title={campaign}>{campaign}</p>}
                    </td>
                    <td className="px-4 py-3"><MiniThumbs creatives={g.creatives} /></td>
                    <td className="px-4 py-3 text-right text-gray-400">{g.stats.count}</td>
                    <td className="px-4 py-3 text-right text-gray-200">{money(g.stats.spend)}</td>
                    <td className="px-4 py-3 text-right text-gray-200">{fmtPct(g.stats.ctr)}</td>
                    <td className="px-4 py-3 text-right text-gray-200">{money(g.stats.cpa, 2)}</td>
                    <td className="px-4 py-3 text-right font-semibold"><RoasValue value={g.stats.roas} estimated={g.stats.estimated} tone /></td>
                    <td className="px-4 py-3 text-right text-gray-200">{fmtX(g.stats.frequency)}</td>
                    <td className="px-2 py-3 text-gray-500">{isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-gray-800/50 bg-gray-950/40">
                      <td colSpan={9} className="p-4">
                        <GroupAdsList creatives={g.creatives} onSelect={onSelect} />
                      </td>
                    </tr>
                  )}
                </RowGroup>
              );
            })}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-600">
            <Users className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">Aucune annonce sur la période</p>
          </div>
        )}
      </Section>

      <Section
        title="Faits calculés"
        icon={<Calculator className="w-4 h-4 text-violet-400" />}
        action={<span className="text-[11px] text-gray-500">Calculés sur les totaux par adset — pas une analyse IA</span>}
        bodyClassName="p-4 space-y-2"
      >
        {facts.map((f) => (
          <div key={f.label} className="flex items-start gap-3 p-3 rounded-lg border border-gray-800 bg-gray-950/40">
            <Pill tone={f.tone} className="shrink-0 mt-0.5">{f.label}</Pill>
            <p className="text-sm text-gray-300">{f.text}</p>
          </div>
        ))}
      </Section>
    </div>
  );
}

// ── Manual tags view (secondary) ──────────────────────────────────────────────

function TaggingPanel({
  creatives,
  tags,
  onSave,
  onClose,
}: {
  creatives: Creative[];
  tags: AudienceTags;
  onSave: (tags: AudienceTags) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AudienceTags>({ ...tags });
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const existing = useMemo(() => Array.from(new Set(Object.values(draft).filter(Boolean))).sort(), [draft]);
  const suggestionsFor = (id: string) => {
    const v = (draft[id] ?? "").trim().toLowerCase();
    if (!v) return [];
    return existing.filter((a) => a.toLowerCase().includes(v) && a !== draft[id]);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md h-full bg-gray-900 border-l border-gray-800 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-2">
            <Tag className="w-4 h-4 text-violet-400" />
            <span className="text-sm font-semibold text-gray-100">Tagger les annonces</span>
          </div>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-200 transition-colors" aria-label="Fermer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {existing.length > 0 && (
          <div className="px-5 py-3 border-b border-gray-800 shrink-0">
            <p className="text-xs text-gray-500 mb-2">Audiences existantes</p>
            <div className="flex flex-wrap gap-1.5">
              {existing.map((a) => (
                <Pill key={a} tone="violet">{a}</Pill>
              ))}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {creatives.map((c) => {
            const suggestions = focusedId === c.id ? suggestionsFor(c.id) : [];
            return (
              <div key={c.id} className="flex items-center gap-3 relative">
                {c.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.thumbnailUrl} alt={c.name} className="w-9 h-9 rounded-lg object-cover border border-gray-700 shrink-0" />
                ) : (
                  <div className={`w-9 h-9 rounded-lg border border-gray-700 shrink-0 bg-gradient-to-br ${c.thumbnailColor}`} />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-300 truncate">{c.name}</p>
                  <div className="relative mt-0.5">
                    <input
                      type="text"
                      value={draft[c.id] ?? ""}
                      onChange={(e) => setDraft((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      onFocus={() => setFocusedId(c.id)}
                      onBlur={() => setTimeout(() => setFocusedId((cur) => (cur === c.id ? null : cur)), 150)}
                      placeholder="Audience…"
                      className="w-full text-xs bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/30"
                    />
                    {suggestions.length > 0 && (
                      <div className="absolute top-full left-0 right-0 z-20 mt-0.5 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden">
                        {suggestions.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onMouseDown={() => setDraft((prev) => ({ ...prev, [c.id]: s }))}
                            className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-700 transition-colors"
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-5 py-4 border-t border-gray-800 shrink-0">
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="w-full flex items-center justify-center gap-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
          >
            <Save className="w-4 h-4" />
            Enregistrer les tags
          </button>
        </div>
      </div>
    </div>
  );
}

function TagsView({ creatives }: { creatives: Creative[] }) {
  const money = useMoney();
  const tags = useAudienceTags();
  const [open, setOpen] = useState(false);
  const { sortKey, sortAsc, toggle, icon } = useSort("spend");

  const groups = useMemo(
    () => groupBy(creatives, (c) => tags[c.id]?.trim() || UNASSIGNED, { lastKeys: [UNASSIGNED] }),
    [creatives, tags],
  );
  const sorted = useMemo(() => sortBy(groups, sortKey, sortAsc, UNASSIGNED), [groups, sortKey, sortAsc]);
  const assigned = groups.filter((g) => g.key !== UNASSIGNED);
  const unassigned = groups.find((g) => g.key === UNASSIGNED) ?? null;

  function handleSave(draft: AudienceTags) {
    replaceAudienceTags(draft);
    setOpen(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-gray-500">
          Étiquettes saisies à la main et stockées dans ce navigateur — utile quand le nom d&apos;adset ne décrit pas l&apos;audience.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
        >
          <Tag className="w-4 h-4" />
          Tagger les annonces
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Kpi label="Audiences taguées" value={assigned.length} icon={<Users className="w-4 h-4" />} />
        <Kpi label="Annonces taguées" value={creatives.length - (unassigned?.stats.count ?? 0)} accent="blue" sub={`sur ${creatives.length}`} />
        <Kpi label="Spend tagué" value={money(assigned.reduce((s, g) => s + g.stats.spend, 0))} accent="gray" />
      </div>

      <Section title="Performance par audience taguée" bodyClassName="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500 text-xs">
              <Th className="text-left">Audience</Th>
              <Th className="text-left">Créas</Th>
              <Th onClick={() => toggle("count")}># {icon("count")}</Th>
              <Th onClick={() => toggle("spend")}>Spend <MetricInfoButton metricKey="spend" /> {icon("spend")}</Th>
              <Th onClick={() => toggle("roas")}>ROAS <MetricInfoButton metricKey="roas" /> {icon("roas")}</Th>
              <Th onClick={() => toggle("cpa")}>CPA <MetricInfoButton metricKey="cpa" /> {icon("cpa")}</Th>
              <Th onClick={() => toggle("ctr")}>CTR <MetricInfoButton metricKey="ctr" /> {icon("ctr")}</Th>
              <Th onClick={() => toggle("hitRate")}>Hit Rate <MetricInfoButton metricKey="hitRate" /> {icon("hitRate")}</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((g) => {
              const isUnassigned = g.key === UNASSIGNED;
              return (
                <tr key={g.key} className={cn("border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors", isUnassigned && "opacity-60")}>
                  <td className="px-4 py-3 text-gray-200 font-medium">{isUnassigned ? <span className="italic text-gray-500">Non taguées</span> : g.label}</td>
                  <td className="px-4 py-3"><MiniThumbs creatives={g.creatives} /></td>
                  <td className="px-4 py-3 text-right text-gray-400">{g.stats.count}</td>
                  <td className="px-4 py-3 text-right text-gray-200">{money(g.stats.spend)}</td>
                  <td className="px-4 py-3 text-right font-semibold"><RoasValue value={g.stats.roas} estimated={g.stats.estimated} tone /></td>
                  <td className="px-4 py-3 text-right text-gray-200">{money(g.stats.cpa, 2)}</td>
                  <td className="px-4 py-3 text-right text-gray-200">{fmtPct(g.stats.ctr)}</td>
                  <td className="px-4 py-3 text-right text-gray-200">{fmtPct(g.stats.hitRate, 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {assigned.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-gray-600">
            <Tag className="w-6 h-6 mb-2 opacity-40" />
            <p className="text-sm">Aucune audience taguée</p>
            <p className="text-xs mt-1">Clique sur « Tagger les annonces » pour attribuer des étiquettes</p>
          </div>
        )}
      </Section>

      {open && <TaggingPanel creatives={creatives} tags={tags} onSave={handleSave} onClose={() => setOpen(false)} />}
    </div>
  );
}

function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AudiencePage() {
  const { creatives, isLoading, isRealData } = useCreativesContext();
  const [tab, setTab] = useState<Tab>("adset");
  const [selected, setSelected] = useState<Creative | null>(null);

  return (
    <div className="flex-1 overflow-auto bg-gray-950 p-6 space-y-6">
      <PageHelp
        title="Audience — Performance par adset"
        description="Sur Meta, l'audience ciblée est portée par l'adset. Cette page regroupe les annonces par adset réel (nom, campagne) et cumule spend, clics, achats et reach pour comparer les ciblages entre eux."
        steps={[
          "Trie par ROAS ou CPA pour voir quel ciblage transforme le mieux, par fréquence pour repérer les audiences saturées.",
          "Déplie un adset pour voir ses annonces et ouvrir chaque créa.",
          "L'onglet « Tags manuels » permet d'étiqueter des annonces à la main quand le nom d'adset n'est pas parlant.",
        ]}
        tip="Une fréquence supérieure à 3 sur une courte période signale souvent une audience trop étroite ou une créa à renouveler."
      />

      <PageHeader
        title="Audience"
        subtitle={isRealData ? "Adsets réels du compte Meta connecté" : "Données de démonstration — connecte un compte Meta"}
        action={<DateRangePicker />}
      />

      <div className="flex gap-1 bg-gray-900 rounded-xl p-1 w-fit">
        {([
          { key: "adset", label: "Par adset" },
          { key: "tags", label: "Tags manuels" },
        ] as { key: Tab; label: string }[]).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
              tab === t.key ? "bg-violet-600 text-white" : "text-gray-400 hover:text-gray-200",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <Card padded className="text-center text-gray-500 text-sm">Chargement…</Card>
      ) : tab === "adset" ? (
        <AdsetView creatives={creatives} onSelect={setSelected} />
      ) : (
        <TagsView creatives={creatives} />
      )}

      <CreativeModal creative={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
