"use client";

import { useCreativesContext } from "@/lib/creatives-context";
import { useSession } from "next-auth/react";
import Link from "next/link";
import {
  TrendingUp,
  DollarSign,
  MousePointerClick,
  Zap,
  Users,
  Sparkles,
  SendHorizonal,
  Image as ImageIcon,
  ChevronRight,
} from "lucide-react";
import { MetricInfoButton } from "@/components/metric-info-button";
import { useMemo, useEffect, useState, useRef } from "react";
import { DateRangePicker } from "@/components/date-range-picker";
import { WoWBanner } from "@/components/wow-banner";
import { PageHelp } from "@/components/ui/page-help";

// ─── KPI card ────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  metricKey?: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  gradient: string;
  accentText: string;
}

function KpiCard({ label, metricKey, value, sub, icon: Icon, gradient, accentText }: KpiCardProps) {
  return (
    <div
      className={`bg-gradient-to-br ${gradient} border border-gray-800 rounded-2xl p-5 flex flex-col gap-4`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-widest inline-flex items-center gap-1">
          {label}{metricKey && <MetricInfoButton metricKey={metricKey} />}
        </span>
        <div className="w-8 h-8 rounded-xl bg-gray-800/70 flex items-center justify-center">
          <Icon className={`w-4 h-4 ${accentText}`} />
        </div>
      </div>
      <div>
        <p className={`text-3xl font-extrabold ${accentText}`}>{value}</p>
        {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
      </div>
    </div>
  );
}

// ─── AI Prompt Bar ────────────────────────────────────────────────────────────

interface AiAnalysisResult {
  question: string;
  answer: string;
}

function analyzeCreatives(
  question: string,
  creatives: ReturnType<typeof useCreativesContext>["creatives"]
): string {
  const q = question.toLowerCase();

  if (creatives.length === 0) {
    return "Aucune créa disponible pour analyser. Connectez votre compte Meta et sélectionnez une période.";
  }

  const totalSpend = creatives.reduce((s, c) => s + c.spend, 0);
  const sorted = [...creatives].sort((a, b) => b.spend - a.spend);
  const topSpend = sorted[0];
  const winners = creatives.filter((c) => c.status === "Winner");
  const losers = creatives.filter((c) => c.status === "Loser");
  const fatigued = creatives.filter((c) => c.status === "Fatigued");
  const avgCpa = creatives.filter((c) => c.cpa > 0).reduce((s, c) => s + c.cpa, 0) / (creatives.filter((c) => c.cpa > 0).length || 1);
  const avgCtr = creatives.reduce((s, c) => s + c.ctr, 0) / creatives.length;
  const videoCreatives = creatives.filter((c) => c.format === "Video");
  const imageCreatives = creatives.filter((c) => c.format === "Image");

  if (q.includes("couper") || q.includes("arrêter") || q.includes("stop") || q.includes("off")) {
    if (losers.length === 0 && fatigued.length === 0) {
      return "Bonne nouvelle — aucune créa classée Loser ou Fatigued en ce moment. Continuez à monitorer les performances.";
    }
    let result = `Créas à considérer pour la coupe :\n\n`;
    if (losers.length > 0) {
      result += `🔴 ${losers.length} Loser(s) : ${losers.map((c) => c.name).join(", ")}\n`;
      result += `→ ROAS moyen : ${(losers.reduce((s, c) => s + c.roas, 0) / losers.length).toFixed(1)}x, CPA moyen : $${(losers.reduce((s, c) => s + c.cpa, 0) / losers.length).toFixed(0)}\n\n`;
    }
    if (fatigued.length > 0) {
      result += `🟡 ${fatigued.length} Fatiguée(s) : ${fatigued.map((c) => c.name).join(", ")}\n`;
      result += `→ Ces créas montrent une baisse de performance. Tester de nouvelles variations.`;
    }
    return result;
  }

  if (q.includes("scale") || q.includes("augmenter") || q.includes("opportunit")) {
    if (winners.length === 0) {
      return `Pas encore de Winners identifiés. La créa avec le meilleur ROAS est "${sorted.sort((a, b) => b.roas - a.roas)[0]?.name}" à ${sorted.sort((a, b) => b.roas - a.roas)[0]?.roas.toFixed(1)}x. Testez des variations similaires.`;
    }
    const topWinner = winners.sort((a, b) => b.roas - a.roas)[0];
    return `✅ ${winners.length} Winner(s) identifié(s). \n\nMeilleure opportunité de scale : "${topWinner.name}"\n→ ROAS : ${topWinner.roas.toFixed(1)}x | CPA : $${topWinner.cpa.toFixed(0)} | Spend actuel : $${topWinner.spend >= 1000 ? `${(topWinner.spend / 1000).toFixed(1)}k` : topWinner.spend}\n\nRecommandation : augmenter progressivement le budget de 20-30% par jour tout en surveillant le CPA.`;
  }

  if (q.includes("analys") || q.includes("meilleur") || q.includes("top")) {
    if (!topSpend) return "Aucune créa disponible.";
    return `📊 Analyse de la créa top spend :\n\n"${topSpend.name}"\n→ Spend : $${topSpend.spend >= 1000 ? `${(topSpend.spend / 1000).toFixed(1)}k` : topSpend.spend}\n→ ROAS : ${topSpend.roas.toFixed(1)}x | CPA : $${topSpend.cpa.toFixed(0)} | CTR : ${topSpend.ctr.toFixed(2)}%\n→ Statut : ${topSpend.status}\n\nCette créa représente ${totalSpend > 0 ? ((topSpend.spend / totalSpend) * 100).toFixed(0) : 0}% du budget total.`;
  }

  if (q.includes("format") || q.includes("video") || q.includes("image")) {
    const videoSpend = videoCreatives.reduce((s, c) => s + c.spend, 0);
    const imageSpend = imageCreatives.reduce((s, c) => s + c.spend, 0);
    const videoRoas = videoCreatives.length > 0 ? videoCreatives.reduce((s, c) => s + c.roas, 0) / videoCreatives.length : 0;
    const imageRoas = imageCreatives.length > 0 ? imageCreatives.reduce((s, c) => s + c.roas, 0) / imageCreatives.length : 0;
    return `📹 Vidéo : ${videoCreatives.length} créas, $${videoSpend >= 1000 ? `${(videoSpend / 1000).toFixed(1)}k` : videoSpend} spend, ROAS moyen ${videoRoas.toFixed(1)}x\n🖼️ Image : ${imageCreatives.length} créas, $${imageSpend >= 1000 ? `${(imageSpend / 1000).toFixed(1)}k` : imageSpend} spend, ROAS moyen ${imageRoas.toFixed(1)}x\n\n${videoRoas > imageRoas ? "Les vidéos surperforment les images en ROAS." : "Les images surperforment les vidéos en ROAS."}`;
  }

  // Default summary
  return `📈 Résumé de la période :\n\n• ${creatives.length} créas actives\n• Spend total : $${totalSpend >= 1000 ? `${(totalSpend / 1000).toFixed(1)}k` : Math.round(totalSpend)}\n• CTR moyen : ${avgCtr.toFixed(2)}%\n• CPA moyen : ${avgCpa > 0 ? `$${avgCpa.toFixed(0)}` : "N/A"}\n• ${winners.length} Winner(s) | ${fatigued.length} Fatigué(s) | ${losers.length} Loser(s)\n\nTop spend : "${topSpend?.name}" à $${topSpend?.spend >= 1000 ? `${(topSpend?.spend / 1000).toFixed(1)}k` : topSpend?.spend}`;
}

function AiPromptBar({
  creatives,
}: {
  creatives: ReturnType<typeof useCreativesContext>["creatives"];
}) {
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<AiAnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const QUICK_PROMPTS = [
    "Quelles créas à couper ?",
    "Opportunités de scale",
    "Analyser le top spend",
    "Comparaison formats",
  ];

  function handleSubmit(q: string) {
    if (!q.trim()) return;
    setIsAnalyzing(true);
    setResult(null);
    // Simulate a brief "thinking" delay for UX
    setTimeout(() => {
      const answer = analyzeCreatives(q, creatives);
      setResult({ question: q, answer });
      setIsAnalyzing(false);
    }, 600);
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-violet-600/20 flex items-center justify-center">
          <Sparkles className="w-4 h-4 text-violet-400" />
        </div>
        <h2 className="text-sm font-semibold text-white">Demandez-moi n&apos;importe quoi</h2>
      </div>

      {/* Quick prompts */}
      <div className="flex flex-wrap gap-2">
        {QUICK_PROMPTS.map((q) => (
          <button
            key={q}
            onClick={() => {
              setPrompt(q);
              handleSubmit(q);
            }}
            className="px-3 py-1.5 rounded-xl text-xs font-medium bg-gray-800 hover:bg-violet-600/20 border border-gray-700 hover:border-violet-500/40 text-gray-300 hover:text-violet-300 transition-colors"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Input row */}
      <div className="flex gap-2">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(prompt);
            }
          }}
          placeholder="Ask anything about your creatives..."
          rows={2}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-violet-500/60 resize-none"
        />
        <button
          onClick={() => handleSubmit(prompt)}
          disabled={!prompt.trim() || isAnalyzing}
          className="self-end px-3 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
        >
          <SendHorizonal className="w-4 h-4" />
        </button>
      </div>

      {/* Result */}
      {isAnalyzing && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <div className="w-3 h-3 rounded-full bg-violet-500 animate-pulse" />
          Analyse en cours…
        </div>
      )}

      {result && !isAnalyzing && (
        <div className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-4 space-y-2">
          <p className="text-xs text-gray-500 italic">&ldquo;{result.question}&rdquo;</p>
          <p className="text-sm text-gray-200 whitespace-pre-line leading-relaxed">{result.answer}</p>
        </div>
      )}
    </div>
  );
}

// ─── Top Créa de la semaine widget ────────────────────────────────────────────

function TopCreativeWidget({
  creatives,
  onPrompt,
}: {
  creatives: ReturnType<typeof useCreativesContext>["creatives"];
  onPrompt: (q: string) => void;
}) {
  const topCreative = useMemo(
    () => [...creatives].sort((a, b) => b.spend - a.spend)[0] ?? null,
    [creatives]
  );

  const STARTERS = ["Analyser cette créa", "Quelles créas à couper ?", "Opportunités de scale"];

  if (!topCreative) return null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
      <h2 className="text-sm font-semibold text-white">Top créa de la semaine</h2>

      <div className="flex gap-4">
        {/* Thumbnail */}
        <div className="w-28 h-36 rounded-xl overflow-hidden shrink-0 bg-gray-800 flex items-center justify-center">
          {topCreative.thumbnailUrl ? (
            <img
              src={topCreative.thumbnailUrl}
              alt={topCreative.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div
              className={`w-full h-full bg-gradient-to-br ${topCreative.thumbnailColor} flex items-center justify-center`}
            >
              <ImageIcon className="w-7 h-7 text-white/40" />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 space-y-3">
          <div>
            <p className="text-xs text-gray-500 truncate">{topCreative.name}</p>
            <p className="text-sm text-gray-300 mt-1 leading-relaxed">
              Cette créa a généré{" "}
              <span className="text-white font-semibold">
                ${topCreative.spend >= 1000
                  ? `${(topCreative.spend / 1000).toFixed(1)}k`
                  : topCreative.spend}
              </span>{" "}
              de spend
              {topCreative.cpa > 0 && (
                <>
                  {" "}avec un CPA de{" "}
                  <span className="text-white font-semibold">${topCreative.cpa.toFixed(0)}</span>
                </>
              )}
              .
            </p>
          </div>

          {/* Thought starters */}
          <div className="space-y-1.5">
            <p className="text-[10px] text-gray-600 uppercase tracking-wide">Thought starters</p>
            {STARTERS.map((s) => (
              <button
                key={s}
                onClick={() => onPrompt(s)}
                className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-lg bg-gray-800/60 hover:bg-violet-600/20 border border-gray-700/50 hover:border-violet-500/30 text-xs text-gray-300 hover:text-violet-300 transition-colors group"
              >
                <ChevronRight className="w-3 h-3 text-gray-600 group-hover:text-violet-400 shrink-0" />
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard home (logged in) ───────────────────────────────────────────────

function DashboardHome() {
  const { creatives, isLoading, dateRange } = useCreativesContext();
  const [metaAccountId, setMetaAccountId] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiResult, setAiResult] = useState<AiAnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  useEffect(() => {
    const raw = localStorage.getItem("impulse_meta_account");
    if (raw) {
      try {
        setMetaAccountId(JSON.parse(raw).accountId ?? null);
      } catch {
        // ignore parse errors
      }
    }
  }, []);

  const kpis = useMemo(() => {
    if (creatives.length === 0) {
      return { totalSpend: 0, avgCtr: 0, avgHookRate: 0, avgRoas: 0, avgCpa: 0, activeCount: 0 };
    }
    const totalSpend = creatives.reduce((s, c) => s + c.spend, 0);
    const avgCtr =
      creatives.reduce((s, c) => s + c.ctr, 0) / creatives.length;
    const videoCreatives = creatives.filter((c) => c.hookRate > 0);
    const avgHookRate =
      videoCreatives.length > 0
        ? videoCreatives.reduce((s, c) => s + c.hookRate, 0) / videoCreatives.length
        : 0;
    const avgRoas =
      creatives.reduce((s, c) => s + c.roas, 0) / creatives.length;
    const cpas = creatives.filter((c) => c.cpa > 0);
    const avgCpa = cpas.length > 0 ? cpas.reduce((s, c) => s + c.cpa, 0) / cpas.length : 0;
    const activeCount = creatives.filter((c) => c.status === "Active" || c.status === "Winner").length;
    return { totalSpend, avgCtr, avgHookRate, avgRoas, avgCpa, activeCount };
  }, [creatives]);

  const fmtSpend = (n: number) =>
    n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`;

  function handleThoughtStarter(q: string) {
    setAiPrompt(q);
    setIsAnalyzing(true);
    setAiResult(null);
    setTimeout(() => {
      const answer = analyzeCreatives(q, creatives);
      setAiResult({ question: q, answer });
      setIsAnalyzing(false);
    }, 600);
  }

  return (
    <div className="p-6 space-y-6">
      {/* Page Help */}
      <PageHelp
        title="Dashboard — Vue d'ensemble"
        description="Vue d'ensemble de tes performances Meta Ads. Compare cette semaine vs la semaine dernière, identifie les créas qui décollent ou fatiguent, et interroge l'assistant IA pour des insights instantanés."
        steps={[
          "Sélectionne une période avec le date picker en haut à droite pour filtrer les données.",
          "Consulte le bandeau Week over Week pour voir l'évolution de tes KPIs clés.",
          "Utilise l'assistant IA (\"Demandez-moi n'importe quoi\") pour obtenir des recommandations concrètes sur tes créas.",
        ]}
        tip="Commence par 'Quelles créas à couper ?' pour nettoyer ton compte des ads qui drainent ton budget sans résultats."
      />
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            This week at a glance
          </p>
        </div>
        <DateRangePicker />
      </div>

      {/* Date badge */}
      <p className="text-xs text-gray-600 -mt-2">
        {dateRange.since} — {dateRange.until}
      </p>

      {/* Week over Week trends banner */}
      {metaAccountId && (
        <WoWBanner accountId={metaAccountId} />
      )}

      {/* ── Cette semaine en un coup d'œil ─────────────────────────────────── */}
      <div>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">
          Cette semaine en un coup d&apos;œil
        </h2>
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-24 bg-gray-900 border border-gray-800 rounded-2xl animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-gradient-to-br from-violet-950/60 to-transparent border border-gray-800 rounded-2xl p-4 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500 uppercase tracking-wide inline-flex items-center gap-1">Total Spend <MetricInfoButton metricKey="spend" /></span>
                <DollarSign className="w-4 h-4 text-violet-400" />
              </div>
              <p className="text-2xl font-extrabold text-violet-400">{fmtSpend(kpis.totalSpend)}</p>
              <p className="text-xs text-gray-600">7 derniers jours</p>
            </div>
            <div className="bg-gradient-to-br from-blue-950/60 to-transparent border border-gray-800 rounded-2xl p-4 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500 uppercase tracking-wide inline-flex items-center gap-1">CPA moyen <MetricInfoButton metricKey="cpa" /></span>
                <TrendingUp className="w-4 h-4 text-blue-400" />
              </div>
              <p className="text-2xl font-extrabold text-blue-400">
                {kpis.avgCpa > 0 ? `$${kpis.avgCpa.toFixed(0)}` : "—"}
              </p>
              <p className="text-xs text-gray-600">Coût par acquisition</p>
            </div>
            <div className="bg-gradient-to-br from-emerald-950/60 to-transparent border border-gray-800 rounded-2xl p-4 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500 uppercase tracking-wide">Créas actives</span>
                <Users className="w-4 h-4 text-emerald-400" />
              </div>
              <p className="text-2xl font-extrabold text-emerald-400">{kpis.activeCount}</p>
              <p className="text-xs text-gray-600">Active + Winner</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Two-column: Top créa + AI prompt ───────────────────────────────── */}
      {!isLoading && creatives.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <TopCreativeWidget
            creatives={creatives}
            onPrompt={handleThoughtStarter}
          />

          {/* AI prompt panel */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-violet-600/20 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-violet-400" />
              </div>
              <h2 className="text-sm font-semibold text-white">Demandez-moi n&apos;importe quoi</h2>
            </div>

            <div className="flex flex-wrap gap-2">
              {["Quelles créas à couper ?", "Opportunités de scale", "Analyser le top spend"].map((q) => (
                <button
                  key={q}
                  onClick={() => handleThoughtStarter(q)}
                  className="px-3 py-1.5 rounded-xl text-xs font-medium bg-gray-800 hover:bg-violet-600/20 border border-gray-700 hover:border-violet-500/40 text-gray-300 hover:text-violet-300 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>

            <div className="flex gap-2">
              <textarea
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleThoughtStarter(aiPrompt);
                  }
                }}
                placeholder="Ask anything about your creatives..."
                rows={2}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-violet-500/60 resize-none"
              />
              <button
                onClick={() => handleThoughtStarter(aiPrompt)}
                disabled={!aiPrompt.trim() || isAnalyzing}
                className="self-end px-3 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
              >
                <SendHorizonal className="w-4 h-4" />
              </button>
            </div>

            {isAnalyzing && (
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <div className="w-3 h-3 rounded-full bg-violet-500 animate-pulse" />
                Analyse en cours…
              </div>
            )}

            {aiResult && !isAnalyzing && (
              <div className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-4 space-y-2">
                <p className="text-xs text-gray-500 italic">&ldquo;{aiResult.question}&rdquo;</p>
                <p className="text-sm text-gray-200 whitespace-pre-line leading-relaxed">{aiResult.answer}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* KPI cards */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-32 bg-gray-900 border border-gray-800 rounded-2xl animate-pulse"
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <KpiCard
            label="Total Spend"
            metricKey="spend"
            value={fmtSpend(kpis.totalSpend)}
            sub={`Across ${creatives.length} active creatives`}
            icon={DollarSign}
            gradient="from-violet-950/60 to-transparent"
            accentText="text-violet-400"
          />
          <KpiCard
            label="Avg CTR"
            metricKey="ctr"
            value={`${kpis.avgCtr.toFixed(2)}%`}
            sub="Click-through rate"
            icon={MousePointerClick}
            gradient="from-blue-950/60 to-transparent"
            accentText="text-blue-400"
          />
          <KpiCard
            label="Avg Hook Rate"
            metricKey="hookRate"
            value={kpis.avgHookRate > 0 ? `${kpis.avgHookRate.toFixed(1)}%` : "—"}
            sub="3-second video retention"
            icon={Zap}
            gradient="from-emerald-950/60 to-transparent"
            accentText="text-emerald-400"
          />
          <KpiCard
            label="Avg ROAS"
            metricKey="roas"
            value={`${kpis.avgRoas.toFixed(2)}x`}
            sub="Return on ad spend"
            icon={TrendingUp}
            gradient="from-orange-950/60 to-transparent"
            accentText="text-orange-400"
          />
        </div>
      )}

      {/* Quick links */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 pt-2">
        {[
          {
            href: "/creatives",
            label: "Creative Feed",
            desc: "Browse all creatives with metrics",
            color: "hover:border-violet-700/60",
          },
          {
            href: "/compare",
            label: "A/B Compare",
            desc: "Compare two creatives head-to-head",
            color: "hover:border-blue-700/60",
          },
          {
            href: "/comparaisons",
            label: "Comparaisons",
            desc: "Métriques agrégées par format, plateforme et statut",
            color: "hover:border-pink-700/60",
          },
          {
            href: "/fatigue",
            label: "Fatigue Detection",
            desc: "Creatives showing declining performance",
            color: "hover:border-orange-700/60",
          },
          {
            href: "/top-charts",
            label: "Top Charts",
            desc: "Ranked by ROAS, Spend, CTR",
            color: "hover:border-emerald-700/60",
          },
          {
            href: "/comparatif",
            label: "Comparatif",
            desc: "Performance by format: Image, Video, Carousel",
            color: "hover:border-pink-700/60",
          },
        ].map(({ href, label, desc, color }) => (
          <Link
            key={href}
            href={href}
            className={`block bg-gray-900 border border-gray-800 ${color} rounded-2xl p-5 transition-colors group`}
          >
            <p className="text-white font-semibold text-sm group-hover:text-violet-300 transition-colors">
              {label}
            </p>
            <p className="text-gray-500 text-xs mt-1 leading-relaxed">{desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ─── Landing page (logged out) ────────────────────────────────────────────────

function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-gray-100">
      {/* Nav */}
      <nav className="border-b border-gray-800/60 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-violet-600 flex items-center justify-center flex-shrink-0">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-white fill-current">
                <path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm13 0a5 5 0 110 10 5 5 0 010-10z" />
              </svg>
            </div>
            <span className="text-lg font-bold text-white tracking-tight">ImpulseMotion</span>
          </div>
          <Link
            href="/login"
            className="text-sm text-gray-400 hover:text-white transition-colors font-medium"
          >
            Se connecter →
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-24 pb-20 text-center">
        <div className="inline-flex items-center gap-2 bg-violet-950/60 border border-violet-800/50 rounded-full px-4 py-1.5 mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 inline-block" />
          <span className="text-violet-300 text-xs font-medium tracking-wide uppercase">
            Meta Ads &amp; TikTok Ads Analytics
          </span>
        </div>

        <h1 className="text-5xl sm:text-6xl font-extrabold text-white leading-tight tracking-tight mb-6 max-w-3xl mx-auto">
          Pourquoi cette publicité{" "}
          <span className="text-violet-400">fonctionne-t-elle</span> ou non&nbsp;?
        </h1>

        <p className="text-xl text-gray-400 max-w-2xl mx-auto mb-10 leading-relaxed">
          Analysez vos créatives Meta &amp; TikTok comme les meilleurs media buyers.
          Visuellement.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2.5 bg-[#1877F2] hover:bg-[#166ee0] text-white font-semibold px-6 py-3.5 rounded-xl transition-colors shadow-lg shadow-blue-900/30"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current flex-shrink-0">
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
            </svg>
            Connecter Meta Ads
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2.5 bg-gray-900 hover:bg-gray-800 text-white font-semibold px-6 py-3.5 rounded-xl transition-colors border border-gray-700"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current flex-shrink-0">
              <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.35 6.35 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.17 8.17 0 004.78 1.52V6.75a4.85 4.85 0 01-1.01-.06z" />
            </svg>
            Connecter TikTok Ads
          </Link>
        </div>
      </section>

      {/* Stats bar */}
      <section className="max-w-6xl mx-auto px-6 pb-20">
        <div className="grid grid-cols-3 divide-x divide-gray-800 border border-gray-800 rounded-2xl bg-gray-900/50">
          {[
            { label: "Hook Rate", desc: "Rétention dans les 3 premières secondes" },
            { label: "Thumbstop Ratio", desc: "Taux d'arrêt sur votre créative" },
            { label: "ROAS Visuel", desc: "Retour sur investissement par créative" },
          ].map((stat) => (
            <div key={stat.label} className="px-8 py-6 text-center">
              <p className="text-base font-semibold text-gray-200 mb-1">{stat.label}</p>
              <p className="text-xs text-gray-500">{stat.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <div className="text-center mb-14">
          <h2 className="text-3xl font-bold text-white mb-3">Tout ce dont vous avez besoin</h2>
          <p className="text-gray-400">Un dashboard pensé pour les media buyers exigeants.</p>
        </div>

        <div className="grid sm:grid-cols-3 gap-5">
          {[
            {
              emoji: "🎯",
              title: "Analyse Créative Visuelle",
              desc: "Voyez vos performances directement sur les visuels. Fini les tableurs Excel.",
            },
            {
              emoji: "📊",
              title: "Décomposition du Funnel",
              desc: "CPM → CTR → Taux de conversion. Identifiez exactement où ça coince.",
            },
            {
              emoji: "🔄",
              title: "Rapports Partageables",
              desc: "Envoyez un lien à votre monteur vidéo avec les perfs affichées sur chaque créative.",
            },
          ].map((f) => (
            <div
              key={f.title}
              className="bg-gray-900 border border-gray-800 rounded-2xl p-7 hover:border-gray-700 transition-colors"
            >
              <div className="text-3xl mb-4">{f.emoji}</div>
              <h3 className="text-white font-semibold text-lg mb-2">{f.title}</h3>
              <p className="text-gray-400 text-sm leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer CTA */}
      <section className="border-t border-gray-800/60">
        <div className="max-w-6xl mx-auto px-6 py-20 text-center">
          <h2 className="text-4xl font-extrabold text-white mb-4">
            Prêt à scaler vos créatives&nbsp;?
          </h2>
          <p className="text-gray-400 mb-8 text-lg">
            Connectez votre compte publicitaire en quelques secondes.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 bg-violet-600 hover:bg-violet-500 text-white font-semibold px-8 py-4 rounded-xl transition-colors shadow-lg shadow-violet-900/40 text-lg mb-5"
          >
            Connecter votre compte pub
            <svg viewBox="0 0 20 20" className="w-5 h-5 fill-current">
              <path
                fillRule="evenodd"
                d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </Link>
          <p className="text-gray-600 text-sm">
            Accès en lecture seule. Nous ne publions jamais à votre place.
          </p>
        </div>
      </section>
    </div>
  );
}

// ─── Root export ──────────────────────────────────────────────────────────────

export default function RootPage() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
        Loading…
      </div>
    );
  }

  if (session) {
    return <DashboardHome />;
  }

  return <LandingPage />;
}
