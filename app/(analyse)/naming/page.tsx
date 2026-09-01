"use client";

import { useMemo, useState } from "react";
import { useCreativesContext, useMoney } from "@/lib/creatives-context";
import { parseSegmentValue, type NamingConfig } from "@/lib/naming-config";
import { useNamingConfig, updateNamingConfig } from "@/lib/use-naming-config";
import { bySegment, sortGroups, UNCATEGORIZED_KEY, type Group } from "@/lib/creative-stats";
import { fmtPct } from "@/lib/creative-format";
import { RoasValue } from "@/components/roas-value";
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
import { PageHelp } from "@/components/ui/page-help";

const SEPARATOR_OPTIONS = [
  { value: "_", label: "Underscore (_)" },
  { value: "-", label: "Tiret (-)" },
  { value: "|", label: "Pipe (|)" },
  { value: " ", label: "Espace ( )" },
  { value: "/", label: "Slash (/)" },
];

const COLORS = [
  "#8b5cf6", "#6366f1", "#3b82f6", "#06b6d4", "#10b981",
  "#f59e0b", "#ef4444", "#ec4899", "#a78bfa", "#34d399",
];

/** Groups sorted by ROAS desc (null ROAS last), "Non catégorisé" pinned at the end. */
function groupBySegment(creatives: Parameters<typeof bySegment>[0], config: NamingConfig, segmentIdx: number): Group[] {
  const groups = bySegment(creatives, config, segmentIdx);
  const known = groups.filter((g) => g.key !== UNCATEGORIZED_KEY);
  const unknown = groups.filter((g) => g.key === UNCATEGORIZED_KEY);
  return [...sortGroups(known, "roas"), ...unknown];
}

function StatTable({ data }: { data: Group[] }) {
  const money = useMoney();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 text-xs uppercase tracking-wide border-b border-gray-800">
            <th className="text-left py-2 pr-4">Nom</th>
            <th className="text-right py-2 px-3">Créas</th>
            <th className="text-right py-2 px-3">Spend</th>
            <th className="text-right py-2 px-3">ROAS</th>
            <th className="text-right py-2 px-3">CPA</th>
            <th className="text-right py-2 px-3">CTR</th>
            <th className="text-right py-2 px-3">Winners</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => {
            const isUnknown = row.key === UNCATEGORIZED_KEY;
            return (
              <tr
                key={row.key}
                className={`border-b border-gray-800/50 hover:bg-gray-800/30 ${isUnknown ? "opacity-50" : ""}`}
              >
                <td className="py-2.5 pr-4">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: isUnknown ? "#4b5563" : COLORS[i % COLORS.length] }}
                    />
                    <span className="font-mono font-medium text-gray-200 truncate max-w-[200px]">{row.label}</span>
                  </div>
                </td>
                <td className="text-right py-2.5 px-3 text-gray-300">{row.stats.count}</td>
                <td className="text-right py-2.5 px-3 text-gray-300">{money(row.stats.spend)}</td>
                <td className="text-right py-2.5 px-3">
                  {isUnknown ? (
                    <span className="text-gray-600">—</span>
                  ) : (
                    <RoasValue value={row.stats.roas} estimated={row.stats.estimated} tone className="font-semibold" />
                  )}
                </td>
                <td className="text-right py-2.5 px-3 text-gray-300">{money(row.stats.cpa, 2)}</td>
                <td className="text-right py-2.5 px-3 text-gray-300">{fmtPct(row.stats.ctr)}</td>
                <td className="text-right py-2.5 px-3">
                  {row.stats.winners > 0 ? (
                    <span className="text-green-400 font-semibold">{row.stats.winners}</span>
                  ) : (
                    <span className="text-gray-600">—</span>
                  )}
                </td>
              </tr>
            );
          })}
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
  const money = useMoney();
  const config = useNamingConfig();
  const [activeSegmentIdx, setActiveSegmentIdx] = useState(0);
  const [showConfig, setShowConfig] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  // Persist config (shared with Angles / Patterns) — the hook re-renders on save
  const handleConfigChange = (c: NamingConfig) => {
    updateNamingConfig(c);
    // Reset to first segment if current index is out of bounds
    if (activeSegmentIdx >= c.segments.length) setActiveSegmentIdx(0);
  };

  const safeIdx = config.segments[activeSegmentIdx] ? activeSegmentIdx : 0;
  const activeSeg = config.segments[safeIdx];
  const data = useMemo(
    () => groupBySegment(creatives, config, safeIdx),
    [config, safeIdx, creatives]
  );
  const known = useMemo(() => data.filter((d) => d.key !== UNCATEGORIZED_KEY), [data]);

  const sampleNames = useMemo(() => creatives.slice(0, 10).map((c) => c.name), [creatives]);

  // Compute format preview string
  const formatPreview = config.segments.map((s) => s.label.toUpperCase()).join(config.separator === " " ? " " : config.separator);

  // Check health: % of creatives that parse cleanly for current segment
  const uncategorizedCount = activeSeg
    ? creatives.filter((c) => parseSegmentValue(c.name, activeSeg.position, config.separator) === UNCATEGORIZED_KEY).length
    : creatives.length;
  const healthPct = creatives.length > 0 ? Math.round(((creatives.length - uncategorizedCount) / creatives.length) * 100) : 0;

  return (
    <div className="p-6 space-y-6">
      {/* Page Help */}
      <PageHelp
        title="Naming Convention — Configure l'interprétation de tes noms d'ads"
        description="Configure comment tes noms d'ads sont interprétés pour déverrouiller les pages Patterns et Angles. Ex: PRODUIT_FORMAT_ANGLE avec _ comme séparateur permet d'agréger automatiquement les perfs par catégorie."
        steps={[
          "Clique sur 'Configurer' et choisis le séparateur utilisé dans tes noms d'ads (_ - | etc.).",
          "Définis tes segments et leur position : Product en pos.1, Format en pos.2, Angle en pos.3 (adapte selon ton naming).",
          "Vérifie l'aperçu en temps réel sur 3 créas — ajuste jusqu'à avoir le badge vert (80%+ catégorisés).",
        ]}
        tip="Même si tes noms ne sont pas 100% standardisés, commence par le séparateur le plus fréquent. Les créas non catégorisées apparaissent grisées et n'impactent pas les statistiques."
      />
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
          ROAS par {activeSeg?.label ?? "segment"}
        </h2>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={known.map((d) => ({ key: d.label, roas: d.stats.roas }))}
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
              formatter={(v: unknown) => [typeof v === "number" ? `${v}x` : "—", "ROAS"]}
            />
            <Bar dataKey="roas" radius={[6, 6, 0, 0]}>
              {known.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">
          Performance par {activeSeg?.label ?? "segment"}
        </h2>
        <StatTable data={data} />
      </div>

      {/* Insights */}
      {known.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">
            Classement par ROAS
          </h2>
          <div className="space-y-3">
            {known.slice(0, 3).map((row, i) => (
              <div key={row.key} className="flex items-start gap-3 text-sm">
                <span className="w-6 h-6 rounded-full bg-violet-800/60 text-violet-300 text-xs font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                <div>
                  <span className="font-mono font-semibold text-gray-200">{row.label}</span>
                  <span className="text-gray-400">
                    {" "}— ROAS <RoasValue value={row.stats.roas} estimated={row.stats.estimated} /> · CPA {money(row.stats.cpa, 2)} · {row.stats.count} créa{row.stats.count > 1 ? "s" : ""}
                    {row.stats.winners > 0 && ` · ${row.stats.winners} winner${row.stats.winners > 1 ? "s" : ""}`}
                  </span>
                </div>
              </div>
            ))}
            {known.length > 3 && (() => {
              const worst = known[known.length - 1];
              return (
                <div className="flex items-start gap-3 text-sm">
                  <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                  <div>
                    <span className="font-mono font-semibold text-gray-200">{worst.label}</span>
                    <span className="text-gray-400">
                      {" "}— ROAS le plus faible (<RoasValue value={worst.stats.roas} estimated={worst.stats.estimated} />) sur {money(worst.stats.spend)} de spend
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
