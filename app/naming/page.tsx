"use client";

import { useMemo, useState, useEffect } from "react";
import { Creative } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Tag, Settings, ChevronDown, ChevronUp, AlertCircle, HelpCircle, Lightbulb, X } from "lucide-react";

interface SegmentDef {
  label: string;
  position: number; // index in split parts (-1 = skip)
}

interface NamingConfig {
  separator: string;
  segments: SegmentDef[];
}

const DEFAULT_CONFIG: NamingConfig = {
  separator: "_",
  segments: [
    { label: "Product", position: 0 },
    { label: "Format", position: 1 },
    { label: "Angle", position: 2 },
  ],
};

const SEPARATOR_OPTIONS = [
  { value: "_", label: "Underscore (_)" },
  { value: "-", label: "Tiret (-)" },
  { value: "|", label: "Pipe (|)" },
  { value: " ", label: "Espace ( )" },
  { value: "/", label: "Slash (/)" },
];

interface GroupStats {
  key: string;
  count: number;
  spend: number;
  roas: number;
  cpa: number;
  ctr: number;
  winners: number;
}

const COLORS = [
  "#8b5cf6", "#6366f1", "#3b82f6", "#06b6d4", "#10b981",
  "#f59e0b", "#ef4444", "#ec4899", "#a78bfa", "#34d399",
];

function parseSegment(name: string, position: number, separator: string): string {
  const parts = name.split(separator).map((p) => p.trim()).filter(Boolean);
  const val = parts[position];
  if (!val || val === "") return "Non catégorisé";
  return val;
}

function groupBySegment(seg: SegmentDef, separator: string, creatives: Creative[]): GroupStats[] {
  const map: Record<string, GroupStats> = {};
  for (const c of creatives) {
    const key = parseSegment(c.name, seg.position, separator);
    if (!map[key]) {
      map[key] = { key, count: 0, spend: 0, roas: 0, cpa: 0, ctr: 0, winners: 0 };
    }
    map[key].count++;
    map[key].spend += c.spend;
    map[key].roas += c.roas;
    map[key].cpa += c.cpa;
    map[key].ctr += c.ctr;
    if (c.status === "Winner") map[key].winners++;
  }
  return Object.values(map).map((g) => ({
    ...g,
    spend: Math.round(g.spend),
    roas: Math.round((g.roas / g.count) * 100) / 100,
    cpa: Math.round((g.cpa / g.count) * 100) / 100,
    ctr: Math.round((g.ctr / g.count) * 100) / 100,
  })).sort((a, b) => {
    // Push "Non catégorisé" to the end
    if (a.key === "Non catégorisé") return 1;
    if (b.key === "Non catégorisé") return -1;
    return b.roas - a.roas;
  });
}

function StatTable({ data }: { data: GroupStats[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 text-xs uppercase tracking-wide border-b border-gray-800">
            <th className="text-left py-2 pr-4">Nom</th>
            <th className="text-right py-2 px-3">Créas</th>
            <th className="text-right py-2 px-3">Spend</th>
            <th className="text-right py-2 px-3">ROAS moy</th>
            <th className="text-right py-2 px-3">CPA moy</th>
            <th className="text-right py-2 px-3">CTR moy</th>
            <th className="text-right py-2 px-3">Winners</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr
              key={row.key}
              className={`border-b border-gray-800/50 hover:bg-gray-800/30 ${
                row.key === "Non catégorisé" ? "opacity-50" : ""
              }`}
            >
              <td className="py-2.5 pr-4">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: row.key === "Non catégorisé" ? "#4b5563" : COLORS[i % COLORS.length] }}
                  />
                  <span className="font-mono font-medium text-gray-200 truncate max-w-[200px]">{row.key}</span>
                </div>
              </td>
              <td className="text-right py-2.5 px-3 text-gray-300">{row.count}</td>
              <td className="text-right py-2.5 px-3 text-gray-300">${(row.spend / 1000).toFixed(1)}k</td>
              <td className="text-right py-2.5 px-3">
                {row.key === "Non catégorisé" ? (
                  <span className="text-gray-600">—</span>
                ) : (
                  <span className={`font-semibold ${row.roas >= 3 ? "text-green-400" : row.roas >= 2 ? "text-yellow-400" : "text-red-400"}`}>
                    {row.roas}x
                  </span>
                )}
              </td>
              <td className="text-right py-2.5 px-3 text-gray-300">${row.cpa}</td>
              <td className="text-right py-2.5 px-3 text-gray-300">{row.ctr}%</td>
              <td className="text-right py-2.5 px-3">
                {row.winners > 0 ? (
                  <span className="text-green-400 font-semibold">{row.winners} 🏆</span>
                ) : (
                  <span className="text-gray-600">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConfigPanel({
  config,
  onChange,
  sampleNames,
}: {
  config: NamingConfig;
  onChange: (c: NamingConfig) => void;
  sampleNames: string[];
}) {
  const preview = sampleNames.slice(0, 3).map((name) => {
    const parts = name.split(config.separator).map((p) => p.trim()).filter(Boolean);
    return { name, parts };
  });

  const uncategorizedCount = sampleNames.filter((n) => {
    const parts = n.split(config.separator).map((p) => p.trim()).filter(Boolean);
    return parts.length <= 1;
  }).length;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-5">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Configuration</h2>

      {/* Separator */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5 w-32 shrink-0">
          <label className="text-sm text-gray-300">Séparateur</label>
          <span title="Le caractère qui sépare les segments dans ton nom d'ad. Ex: PRODUIT_FORMAT_ANGLE → séparateur = _" className="cursor-help">
            <HelpCircle className="w-3.5 h-3.5 text-gray-600 hover:text-gray-400" />
          </span>
        </div>
        <div className="flex gap-2 flex-wrap">
          {SEPARATOR_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onChange({ ...config, separator: opt.value })}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium border transition-colors ${
                config.separator === opt.value
                  ? "bg-violet-600 border-violet-500 text-white"
                  : "border-gray-700 text-gray-400 hover:text-white hover:border-gray-500"
              }`}
            >
              {opt.label}
            </button>
          ))}
          {/* Custom separator */}
          {!SEPARATOR_OPTIONS.find((o) => o.value === config.separator) && (
            <span className="px-3 py-1.5 rounded-lg text-xs font-mono font-medium border bg-violet-600 border-violet-500 text-white">
              &quot;{config.separator}&quot;
            </span>
          )}
        </div>
      </div>

      {/* Segment positions */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <label className="text-sm text-gray-300">Segments (position dans le nom)</label>
          <span title="Chaque segment correspond à une partie du nom après découpage. Position 1 = premier mot, Position 2 = deuxième mot, etc." className="cursor-help">
            <HelpCircle className="w-3.5 h-3.5 text-gray-600 hover:text-gray-400" />
          </span>
        </div>
        <div className="flex flex-wrap gap-3">
          {config.segments.map((seg, idx) => (
            <div key={idx} className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2">
              <input
                className="bg-transparent text-gray-200 text-sm font-medium w-24 outline-none"
                value={seg.label}
                onChange={(e) => {
                  const segs = [...config.segments];
                  segs[idx] = { ...segs[idx], label: e.target.value };
                  onChange({ ...config, segments: segs });
                }}
              />
              <span className="text-gray-600 text-xs">pos</span>
              <select
                className="bg-gray-900 text-gray-300 text-xs rounded-lg px-2 py-1 outline-none border border-gray-700"
                value={seg.position}
                onChange={(e) => {
                  const segs = [...config.segments];
                  segs[idx] = { ...segs[idx], position: Number(e.target.value) };
                  onChange({ ...config, segments: segs });
                }}
              >
                {[0, 1, 2, 3, 4, 5].map((p) => (
                  <option key={p} value={p}>{p + 1}ère partie</option>
                ))}
              </select>
            </div>
          ))}
          <button
            onClick={() => onChange({ ...config, segments: [...config.segments, { label: "Segment", position: config.segments.length }] })}
            className="px-3 py-2 rounded-xl text-xs text-gray-400 border border-dashed border-gray-700 hover:border-violet-600 hover:text-violet-400 transition-colors"
          >
            + Ajouter
          </button>
        </div>
      </div>

      {/* Preview */}
      {preview.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-300">Aperçu (3 premiers ads)</label>
            {uncategorizedCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-full">
                <AlertCircle className="w-3 h-3" />
                {uncategorizedCount} ad{uncategorizedCount > 1 ? "s" : ""} non catégorisé{uncategorizedCount > 1 ? "s" : ""}
              </span>
            )}
          </div>
          <div className="space-y-1.5">
            {preview.map(({ name, parts }, i) => (
              <div key={i} className="flex items-start gap-3 text-xs">
                <span className="font-mono text-gray-500 truncate max-w-[200px] shrink-0">{name}</span>
                <span className="text-gray-700">→</span>
                <div className="flex gap-2 flex-wrap">
                  {config.segments.map((seg) => {
                    const val = parts[seg.position];
                    return (
                      <span
                        key={seg.label}
                        className={`px-2 py-0.5 rounded-md font-mono ${
                          val
                            ? "bg-violet-900/40 text-violet-300"
                            : "bg-gray-800 text-gray-600"
                        }`}
                      >
                        {seg.label}: {val ?? "—"}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const STORAGE_KEY = "impulsemotion_naming_config";

function NamingGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="bg-gradient-to-br from-violet-950/60 to-gray-900 border border-violet-800/40 rounded-2xl p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-5 h-5 text-violet-400 shrink-0" />
          <h2 className="text-base font-semibold text-white">Comment fonctionne la Naming Convention ?</h2>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Concept */}
      <div className="space-y-2">
        <p className="text-sm text-gray-300 leading-relaxed">
          La naming convention, c&apos;est un système de nommage structuré pour tes publicités Meta. En donnant un nom cohérent à chaque créa, l&apos;outil peut automatiquement les regrouper et comparer leurs performances par catégorie.
        </p>
      </div>

      {/* Example */}
      <div className="bg-gray-900/80 border border-gray-800 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Exemple concret</p>
        <div className="font-mono text-sm">
          <span className="text-amber-300">OMEGA3</span>
          <span className="text-gray-600">_</span>
          <span className="text-blue-300">VIDEO</span>
          <span className="text-gray-600">_</span>
          <span className="text-green-300">PROMO_ETE</span>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="px-2 py-1 rounded-md bg-amber-900/30 text-amber-300 font-mono">Product: OMEGA3</span>
          <span className="px-2 py-1 rounded-md bg-blue-900/30 text-blue-300 font-mono">Format: VIDEO</span>
          <span className="px-2 py-1 rounded-md bg-green-900/30 text-green-300 font-mono">Angle: PROMO_ETE</span>
        </div>
        <p className="text-xs text-gray-500">Séparateur : underscore ( _ ) · 3 segments · position 1-2-3</p>
      </div>

      {/* Steps */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Comment configurer</p>
        <div className="space-y-2.5">
          {[
            { step: "1", text: "Clique sur \"Configurer\" → choisis le séparateur que tu utilises dans tes noms d'ads (_  -  |  etc.)" },
            { step: "2", text: "Définis tes segments et leur position : Product en position 1, Format en 2, Angle en 3 (ou adapte selon ton naming)." },
            { step: "3", text: "L'aperçu en temps réel montre comment tes vraies créas sont parsées — ajuste jusqu'à avoir 80%+ catégorisés (badge vert)." },
            { step: "4", text: "Une fois configuré, reviens sur cette page pour voir le ROAS moyen par segment et identifier tes angles/formats gagnants." },
          ].map(({ step, text }) => (
            <div key={step} className="flex gap-3 text-sm">
              <span className="w-5 h-5 rounded-full bg-violet-800/60 text-violet-300 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{step}</span>
              <span className="text-gray-300">{text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Tips */}
      <div className="bg-amber-950/30 border border-amber-800/30 rounded-xl px-4 py-3 flex gap-3">
        <span className="text-amber-400 text-base shrink-0">💡</span>
        <p className="text-xs text-amber-200/80 leading-relaxed">
          <strong>Conseil :</strong> Même si tes noms ne sont pas 100% standardisés, commence par le séparateur le plus fréquent. Le badge de santé (% catégorisés) te guide. Les créas non catégorisées apparaissent grisées en bas du tableau et n&apos;impactent pas les stats.
        </p>
      </div>
    </div>
  );
}

export default function NamingPage() {
  const { creatives } = useCreativesContext();
  const [config, setConfig] = useState<NamingConfig>(DEFAULT_CONFIG);
  const [activeSegmentIdx, setActiveSegmentIdx] = useState(0);
  const [showConfig, setShowConfig] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  // Load saved config from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setConfig(JSON.parse(saved));
    } catch {}
  }, []);

  // Save config when it changes
  const handleConfigChange = (c: NamingConfig) => {
    setConfig(c);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
    } catch {}
    // Reset to first segment if current index is out of bounds
    if (activeSegmentIdx >= c.segments.length) setActiveSegmentIdx(0);
  };

  const activeSeg = config.segments[activeSegmentIdx] ?? config.segments[0];
  const data = useMemo(
    () => groupBySegment(activeSeg, config.separator, creatives),
    [activeSeg, config.separator, creatives]
  );

  const sampleNames = useMemo(() => creatives.slice(0, 10).map((c) => c.name), [creatives]);

  // Compute format preview string
  const formatPreview = config.segments.map((s) => s.label.toUpperCase()).join(config.separator === " " ? " " : config.separator);

  // Check health: % of creatives that parse cleanly for current segment
  const uncategorizedCount = creatives.filter((c) => {
    const parts = c.name.split(config.separator).map((p) => p.trim()).filter(Boolean);
    return !parts[activeSeg.position];
  }).length;
  const healthPct = creatives.length > 0 ? Math.round(((creatives.length - uncategorizedCount) / creatives.length) * 100) : 0;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Tag className="w-5 h-5 text-violet-400" />
            <h1 className="text-2xl font-bold text-white">Naming Convention</h1>
          </div>
          <p className="text-gray-400 text-sm">
            Analyse par segment — format actuel :{" "}
            <span className="font-mono text-gray-300">{formatPreview}</span>
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Health indicator */}
          {creatives.length > 0 && (
            <div className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full ${
              healthPct >= 80 ? "bg-green-900/30 text-green-400" :
              healthPct >= 50 ? "bg-amber-900/30 text-amber-400" :
              "bg-red-900/30 text-red-400"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                healthPct >= 80 ? "bg-green-400" : healthPct >= 50 ? "bg-amber-400" : "bg-red-400"
              }`} />
              {healthPct}% catégorisés
            </div>
          )}

          {/* Help toggle */}
          <button
            onClick={() => setShowGuide((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm border transition-colors ${
              showGuide
                ? "bg-violet-900/40 border-violet-600 text-violet-300"
                : "text-gray-400 border-gray-700 hover:border-violet-600 hover:text-violet-400"
            }`}
          >
            <HelpCircle className="w-4 h-4" />
            Comment ça marche ?
          </button>

          {/* Config toggle */}
          <button
            onClick={() => setShowConfig((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-gray-400 border border-gray-700 hover:border-violet-600 hover:text-violet-400 transition-colors"
          >
            <Settings className="w-4 h-4" />
            Configurer
            {showConfig ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Guide panel */}
      {showGuide && <NamingGuide onClose={() => setShowGuide(false)} />}

      {/* Config panel */}
      {showConfig && (
        <ConfigPanel
          config={config}
          onChange={handleConfigChange}
          sampleNames={sampleNames}
        />
      )}

      {/* Segment selector */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {config.segments.map((seg, idx) => (
          <button
            key={idx}
            onClick={() => setActiveSegmentIdx(idx)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              activeSegmentIdx === idx
                ? "bg-violet-600 text-white"
                : "text-gray-400 hover:text-white"
            }`}
          >
            {seg.label}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">
          ROAS moyen par {activeSeg.label}
        </h2>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={data.filter((d) => d.key !== "Non catégorisé")}
            margin={{ top: 4, right: 8, left: -12, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis
              dataKey="key"
              tick={{ fill: "#9ca3af", fontSize: 11 }}
              tickFormatter={(v) => v.length > 15 ? v.slice(0, 15) + "…" : v}
            />
            <YAxis tick={{ fill: "#9ca3af", fontSize: 12 }} />
            <Tooltip
              contentStyle={{
                background: "#111827",
                border: "1px solid #374151",
                borderRadius: "8px",
                fontSize: "12px",
                color: "#e5e7eb",
              }}
              formatter={(v: unknown) => [`${v}x`, "ROAS moyen"]}
            />
            <Bar dataKey="roas" radius={[6, 6, 0, 0]}>
              {data.filter((d) => d.key !== "Non catégorisé").map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">
          Performance par {activeSeg.label}
        </h2>
        <StatTable data={data} />
      </div>

      {/* Insights */}
      {data.filter((d) => d.key !== "Non catégorisé").length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">
            Key Insights
          </h2>
          <div className="space-y-3">
            {data.filter((d) => d.key !== "Non catégorisé").slice(0, 3).map((row, i) => {
              const rank = ["🥇", "🥈", "🥉"][i];
              return (
                <div key={row.key} className="flex items-start gap-3 text-sm">
                  <span className="text-lg leading-none">{rank}</span>
                  <div>
                    <span className="font-mono font-semibold text-gray-200">{row.key}</span>
                    <span className="text-gray-400">
                      {" "}— {row.roas}x ROAS · ${row.cpa} CPA · {row.count} créa{row.count > 1 ? "s" : ""}
                      {row.winners > 0 && ` · ${row.winners} winner${row.winners > 1 ? "s" : ""}`}
                    </span>
                  </div>
                </div>
              );
            })}
            {data.filter((d) => d.key !== "Non catégorisé").length > 3 && (() => {
              const worst = data.filter((d) => d.key !== "Non catégorisé").at(-1)!;
              return (
                <div className="flex items-start gap-3 text-sm">
                  <span className="text-lg leading-none">⚠️</span>
                  <div>
                    <span className="font-mono font-semibold text-gray-200">{worst.key}</span>
                    <span className="text-gray-400">
                      {" "}— moins performant à {worst.roas}x ROAS · envisage de pauser ou renouveler
                    </span>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
