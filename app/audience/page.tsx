"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { Creative } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import { Users, ChevronUp, ChevronDown, X, Save, Sparkles, TrendingUp, Trophy, AlertTriangle, Tag } from "lucide-react";
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

const LS_KEY = "impulsemotion_audience_tags";

type AudienceTags = Record<string, string>;

type SortKey = "spend" | "roas" | "cpa" | "ctr" | "hitRate" | "count";

interface AudienceStats {
  audience: string;
  count: number;
  spend: number;
  roas: number;
  cpa: number;
  ctr: number;
  hitRate: number;
  creatives: Creative[];
}

function loadTags(): AudienceTags {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveTags(tags: AudienceTags) {
  if (typeof window === "undefined") return;
  localStorage.setItem(LS_KEY, JSON.stringify(tags));
}

function buildAudienceStats(creatives: Creative[], tags: AudienceTags): AudienceStats[] {
  const map = new Map<string, Creative[]>();
  for (const c of creatives) {
    const audience = tags[c.id] ?? "Unassigned";
    if (!map.has(audience)) map.set(audience, []);
    map.get(audience)!.push(c);
  }

  return Array.from(map.entries()).map(([audience, items]) => {
    const spend = items.reduce((s, c) => s + c.spend, 0);
    const weightedRoas = spend > 0
      ? items.reduce((s, c) => s + c.roas * c.spend, 0) / spend
      : items.reduce((s, c) => s + c.roas, 0) / items.length;
    const cpa = items.reduce((s, c) => s + c.cpa, 0) / items.length;
    const ctr = items.reduce((s, c) => s + c.ctr, 0) / items.length;
    const winners = items.filter((c) => c.status === "Winner").length;
    const hitRate = items.length > 0 ? (winners / items.length) * 100 : 0;
    return { audience, count: items.length, spend, roas: weightedRoas, cpa, ctr, hitRate, creatives: items };
  });
}

interface TooltipEntry {
  dataKey: string;
  name: string;
  value: number;
  fill: string;
  color: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}

const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-gray-200 font-semibold mb-2">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex justify-between gap-4">
          <span style={{ color: p.fill ?? p.color }}>{p.name}</span>
          <span className="text-gray-200 font-medium">
            {p.dataKey === "Spend" ? `$${p.value.toLocaleString()}` : `${p.value.toFixed(2)}x`}
          </span>
        </div>
      ))}
    </div>
  );
};

interface ThumbnailGridProps {
  creatives: Creative[];
  max?: number;
}

function ThumbnailGrid({ creatives, max = 4 }: ThumbnailGridProps) {
  const shown = creatives.slice(0, max);
  return (
    <div className="flex gap-1">
      {shown.map((c) => (
        c.thumbnailUrl ? (
          <img key={c.id} src={c.thumbnailUrl} alt={c.name} className="w-7 h-7 rounded object-cover border border-gray-700" />
        ) : (
          <div key={c.id} className="w-7 h-7 rounded border border-gray-700" style={{ background: c.thumbnailColor }} />
        )
      ))}
      {creatives.length > max && (
        <div className="w-7 h-7 rounded border border-gray-700 bg-gray-800 flex items-center justify-center text-gray-400 text-xs font-semibold">
          +{creatives.length - max}
        </div>
      )}
    </div>
  );
}

interface TaggingPanelProps {
  creatives: Creative[];
  tags: AudienceTags;
  onSave: (tags: AudienceTags) => void;
  onClose: () => void;
}

function TaggingPanel({ creatives, tags, onSave, onClose }: TaggingPanelProps) {
  const [draft, setDraft] = useState<AudienceTags>({ ...tags });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const existingAudiences = useMemo(() => {
    const names = new Set(Object.values(draft).filter(Boolean));
    return Array.from(names).sort();
  }, [draft]);

  function handleChange(id: string, value: string) {
    setDraft((prev) => ({ ...prev, [id]: value }));
    if (value.trim()) {
      const filtered = existingAudiences.filter(
        (a) => a.toLowerCase().includes(value.toLowerCase()) && a !== value
      );
      setSuggestions(filtered);
    } else {
      setSuggestions([]);
    }
  }

  function applySuggestion(id: string, suggestion: string) {
    setDraft((prev) => ({ ...prev, [id]: suggestion }));
    setSuggestions([]);
    setFocusedId(null);
  }

  function handleSave() {
    const cleaned: AudienceTags = {};
    for (const [k, v] of Object.entries(draft)) {
      if (v.trim()) cleaned[k] = v.trim();
    }
    onSave(cleaned);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md h-full bg-gray-900 border-l border-gray-800 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-2">
            <Tag className="w-4 h-4 text-violet-400" />
            <span className="text-sm font-semibold text-gray-100">Tag Creatives</span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Existing audiences chips */}
        {existingAudiences.length > 0 && (
          <div className="px-5 py-3 border-b border-gray-800 shrink-0">
            <p className="text-xs text-gray-500 mb-2">Existing audiences</p>
            <div className="flex flex-wrap gap-1.5">
              {existingAudiences.map((a) => (
                <span key={a} className="text-xs px-2 py-0.5 rounded-full bg-violet-600/20 text-violet-300 border border-violet-500/30">
                  {a}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Creative list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {creatives.map((c) => (
            <div key={c.id} className="flex items-center gap-3 relative">
              {/* Thumbnail */}
              {c.thumbnailUrl ? (
                <img src={c.thumbnailUrl} alt={c.name} className="w-9 h-9 rounded-lg object-cover border border-gray-700 shrink-0" />
              ) : (
                <div className="w-9 h-9 rounded-lg border border-gray-700 shrink-0" style={{ background: c.thumbnailColor }} />
              )}
              {/* Name */}
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-300 truncate">{c.name}</p>
                {/* Input */}
                <div className="relative mt-0.5">
                  <input
                    type="text"
                    value={draft[c.id] ?? ""}
                    onChange={(e) => handleChange(c.id, e.target.value)}
                    onFocus={() => setFocusedId(c.id)}
                    onBlur={() => setTimeout(() => setFocusedId(null), 150)}
                    placeholder="Audience label..."
                    className="w-full text-xs bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/30"
                  />
                  {/* Autocomplete dropdown */}
                  {focusedId === c.id && suggestions.length > 0 && (
                    <div className="absolute top-full left-0 right-0 z-20 mt-0.5 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden">
                      {suggestions.map((s) => (
                        <button
                          key={s}
                          onMouseDown={() => applySuggestion(c.id, s)}
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
          ))}
        </div>

        {/* Save button */}
        <div className="px-5 py-4 border-t border-gray-800 shrink-0">
          <button
            onClick={handleSave}
            className="w-full flex items-center justify-center gap-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
          >
            <Save className="w-4 h-4" />
            Save Tags
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AudiencePage() {
  const { creatives } = useCreativesContext();
  const [tags, setTags] = useState<AudienceTags>({});
  const [taggingOpen, setTaggingOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    setTags(loadTags());
  }, []);

  const audienceStats = useMemo(
    () => buildAudienceStats(creatives, tags),
    [creatives, tags]
  );

  const assigned = useMemo(
    () => audienceStats.filter((a) => a.audience !== "Unassigned"),
    [audienceStats]
  );
  const unassigned = useMemo(
    () => audienceStats.find((a) => a.audience === "Unassigned"),
    [audienceStats]
  );

  const sorted = useMemo(() => {
    return [...assigned].sort((a, b) => {
      let diff = 0;
      if (sortKey === "spend") diff = a.spend - b.spend;
      else if (sortKey === "roas") diff = a.roas - b.roas;
      else if (sortKey === "cpa") diff = a.cpa - b.cpa;
      else if (sortKey === "ctr") diff = a.ctr - b.ctr;
      else if (sortKey === "hitRate") diff = a.hitRate - b.hitRate;
      else if (sortKey === "count") diff = a.count - b.count;
      return sortAsc ? diff : -diff;
    });
  }, [assigned, sortKey, sortAsc]);

  const chartData = useMemo(() => {
    return assigned.map((a) => ({
      name: a.audience.length > 14 ? a.audience.slice(0, 13) + "…" : a.audience,
      fullName: a.audience,
      Spend: Math.round(a.spend),
      ROAS: parseFloat(a.roas.toFixed(2)),
    }));
  }, [assigned]);

  // AI Insights
  const insights = useMemo(() => {
    if (assigned.length === 0) return [];
    const byRoas = [...assigned].sort((a, b) => b.roas - a.roas);
    const byHitRate = [...assigned].sort((a, b) => b.hitRate - a.hitRate);
    const burnWorst = [...assigned].sort((a, b) => b.spend - a.spend).find((a) => a.roas < 1.5);

    const bullets: string[] = [];
    if (byRoas[0]) {
      bullets.push(
        `Best performing audience by ROAS: "${byRoas[0].audience}" at ${byRoas[0].roas.toFixed(2)}x — consider scaling budget here.`
      );
    }
    if (byHitRate[0]) {
      bullets.push(
        `Highest winner hit rate: "${byHitRate[0].audience}" with ${byHitRate[0].hitRate.toFixed(0)}% of its ${byHitRate[0].count} creatives achieving Winner status.`
      );
    }
    if (burnWorst) {
      bullets.push(
        `Budget risk: "${burnWorst.audience}" is consuming $${burnWorst.spend.toLocaleString()} in spend but returns only ${burnWorst.roas.toFixed(2)}x ROAS — review or reallocate.`
      );
    } else {
      bullets.push("All tagged audiences are meeting a healthy ROAS threshold (≥1.5x).");
    }
    return bullets;
  }, [assigned]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((a) => !a);
    else {
      setSortKey(key);
      setSortAsc(false);
    }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <ChevronUp className="w-3 h-3 opacity-30" />;
    return sortAsc ? (
      <ChevronUp className="w-3 h-3 text-violet-400" />
    ) : (
      <ChevronDown className="w-3 h-3 text-violet-400" />
    );
  }

  function handleSaveTags(newTags: AudienceTags) {
    saveTags(newTags);
    setTags(newTags);
    setTaggingOpen(false);
  }

  const totalSpend = audienceStats.reduce((s, a) => s + a.spend, 0);
  const avgRoas =
    totalSpend > 0
      ? audienceStats.reduce((s, a) => s + a.roas * a.spend, 0) / totalSpend
      : 0;

  return (
    <div className="flex-1 overflow-auto bg-gray-950 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-violet-600/20 rounded-xl flex items-center justify-center">
            <Users className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-100">Intended Audience</h1>
            <p className="text-xs text-gray-500">Tag creatives by target audience and compare performance</p>
          </div>
        </div>
        <button
          onClick={() => setTaggingOpen(true)}
          className="flex items-center gap-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
        >
          <Tag className="w-4 h-4" />
          Tag Creatives
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Audiences</p>
          <p className="text-2xl font-bold text-gray-100">{assigned.length}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Tagged Creatives</p>
          <p className="text-2xl font-bold text-violet-400">
            {creatives.length - (unassigned?.count ?? 0)}
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Total Spend</p>
          <p className="text-2xl font-bold text-gray-100">${totalSpend.toLocaleString()}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Blended ROAS</p>
          <p className="text-2xl font-bold text-emerald-400">{avgRoas.toFixed(2)}x</p>
        </div>
      </div>

      {/* Dual-axis Bar Chart */}
      {assigned.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6">
          <h2 className="text-sm font-semibold text-gray-200 mb-4">Spend vs ROAS by Audience</h2>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData} margin={{ top: 4, right: 24, left: 8, bottom: 4 }} barGap={4}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis
                dataKey="name"
                tick={{ fill: "#9ca3af", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                yAxisId="spend"
                orientation="left"
                tick={{ fill: "#9ca3af", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
              />
              <YAxis
                yAxisId="roas"
                orientation="right"
                tick={{ fill: "#9ca3af", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v}x`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12, color: "#9ca3af" }} />
              <Bar yAxisId="spend" dataKey="Spend" fill="#8b5cf6" radius={[4, 4, 0, 0]} barSize={28} />
              <Bar yAxisId="roas" dataKey="ROAS" fill="#10b981" radius={[4, 4, 0, 0]} barSize={28} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-200">Audience Breakdown</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500 text-xs">
              <th className="text-left px-4 py-3 font-medium">Audience</th>
              <th className="text-left px-4 py-3 font-medium">Creatives</th>
              <th
                className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300"
                onClick={() => toggleSort("count")}
              >
                <span className="flex items-center justify-end gap-1"># <SortIcon k="count" /></span>
              </th>
              <th
                className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300"
                onClick={() => toggleSort("spend")}
              >
                <span className="flex items-center justify-end gap-1">Spend <SortIcon k="spend" /></span>
              </th>
              <th
                className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300"
                onClick={() => toggleSort("roas")}
              >
                <span className="flex items-center justify-end gap-1">ROAS <SortIcon k="roas" /></span>
              </th>
              <th
                className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300"
                onClick={() => toggleSort("cpa")}
              >
                <span className="flex items-center justify-end gap-1">CPA <SortIcon k="cpa" /></span>
              </th>
              <th
                className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300"
                onClick={() => toggleSort("ctr")}
              >
                <span className="flex items-center justify-end gap-1">CTR <SortIcon k="ctr" /></span>
              </th>
              <th
                className="text-right px-4 py-3 font-medium cursor-pointer hover:text-gray-300"
                onClick={() => toggleSort("hitRate")}
              >
                <span className="flex items-center justify-end gap-1">Hit Rate <SortIcon k="hitRate" /></span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a, i) => (
              <tr
                key={a.audience}
                className={cn(
                  "border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors",
                  i === sorted.length - 1 && !unassigned && "border-0"
                )}
              >
                <td className="px-4 py-3 text-gray-200 font-medium">{a.audience}</td>
                <td className="px-4 py-3">
                  <ThumbnailGrid creatives={a.creatives} max={4} />
                </td>
                <td className="px-4 py-3 text-right text-gray-400">{a.count}</td>
                <td className="px-4 py-3 text-right text-gray-200">${a.spend.toLocaleString()}</td>
                <td className="px-4 py-3 text-right">
                  <span
                    className={cn(
                      "font-semibold",
                      a.roas >= 3
                        ? "text-emerald-400"
                        : a.roas >= 2
                        ? "text-blue-400"
                        : "text-gray-400"
                    )}
                  >
                    {a.roas.toFixed(2)}x
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-gray-200">${a.cpa.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-gray-200">{a.ctr.toFixed(2)}%</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          a.hitRate >= 30
                            ? "bg-emerald-500"
                            : a.hitRate >= 10
                            ? "bg-amber-500"
                            : "bg-red-500"
                        )}
                        style={{ width: `${Math.min(100, a.hitRate)}%` }}
                      />
                    </div>
                    <span
                      className={cn(
                        "font-semibold text-xs w-8 text-right",
                        a.hitRate >= 30
                          ? "text-emerald-400"
                          : a.hitRate < 10
                          ? "text-red-400"
                          : "text-gray-400"
                      )}
                    >
                      {a.hitRate.toFixed(0)}%
                    </span>
                  </div>
                </td>
              </tr>
            ))}

            {/* Unassigned row */}
            {unassigned && (
              <tr className="border-0 opacity-60 hover:opacity-80 hover:bg-gray-800/20 transition-all">
                <td className="px-4 py-3">
                  <span className="text-gray-500 italic font-medium">Unassigned</span>
                </td>
                <td className="px-4 py-3">
                  <ThumbnailGrid creatives={unassigned.creatives} max={4} />
                </td>
                <td className="px-4 py-3 text-right text-gray-500">{unassigned.count}</td>
                <td className="px-4 py-3 text-right text-gray-500">${unassigned.spend.toLocaleString()}</td>
                <td className="px-4 py-3 text-right text-gray-500">{unassigned.roas.toFixed(2)}x</td>
                <td className="px-4 py-3 text-right text-gray-500">${unassigned.cpa.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-gray-500">{unassigned.ctr.toFixed(2)}%</td>
                <td className="px-4 py-3 text-right text-gray-500">{unassigned.hitRate.toFixed(0)}%</td>
              </tr>
            )}
          </tbody>
        </table>

        {sorted.length === 0 && !unassigned && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-600">
            <Users className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">No audiences tagged yet</p>
            <p className="text-xs mt-1">Click "Tag Creatives" to assign audience labels</p>
          </div>
        )}

        {sorted.length === 0 && unassigned && (
          <div className="flex flex-col items-center justify-center py-8 text-gray-600">
            <Tag className="w-6 h-6 mb-2 opacity-40" />
            <p className="text-sm">No audiences tagged</p>
            <p className="text-xs mt-1">{unassigned.count} creative{unassigned.count !== 1 ? "s" : ""} waiting to be assigned</p>
          </div>
        )}
      </div>

      {/* AI Insights */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-4 h-4 text-violet-400" />
          <h2 className="text-sm font-semibold text-gray-200">AI Insights</h2>
        </div>
        {insights.length === 0 ? (
          <p className="text-sm text-gray-500">Tag at least two audiences to generate insights.</p>
        ) : (
          <ul className="space-y-3">
            {insights.map((insight, i) => {
              const icons = [TrendingUp, Trophy, AlertTriangle];
              const colors = ["text-emerald-400", "text-violet-400", "text-amber-400"];
              const bgColors = ["bg-emerald-500/10 border-emerald-500/20", "bg-violet-500/10 border-violet-500/20", "bg-amber-500/10 border-amber-500/20"];
              const Icon = icons[i] ?? TrendingUp;
              return (
                <li key={i} className={cn("flex items-start gap-3 p-3 rounded-lg border", bgColors[i])}>
                  <Icon className={cn("w-4 h-4 mt-0.5 shrink-0", colors[i])} />
                  <p className="text-sm text-gray-300">{insight}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Tagging Panel */}
      {taggingOpen && (
        <TaggingPanel
          creatives={creatives}
          tags={tags}
          onSave={handleSaveTags}
          onClose={() => setTaggingOpen(false)}
        />
      )}
    </div>
  );
}
