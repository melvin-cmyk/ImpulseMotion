"use client";

/**
 * <CreativeAiAnalysis /> — on-demand AI analysis of the account's creatives.
 * Calls POST /api/creatives/analyze (relay-backed, cached 1 h server-side) and
 * renders the structured verdict. Thumbnails are resolved from the creatives
 * context by adId. Nothing is computed client-side: what the model did not
 * return is simply not shown.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, RefreshCw, Loader2, Trophy, Scissors, Lightbulb, Play, ListChecks, AlertCircle } from "lucide-react";
import { useCreativesContext } from "@/lib/creatives-context";
import { CreativeThumbnail } from "@/components/creative-thumbnail";
import { Section, Card, Pill } from "@/components/ui/surface";
import type { Creative } from "@/lib/creative-types";

interface Analysis {
  summary: string[];
  winners: { adId: string; name: string; why: string }[];
  losers: { adId: string; name: string; why: string; action: "cut" | "iterate" | "watch" }[];
  patterns: { title: string; evidence: string; impact: "positive" | "negative" }[];
  hooks: { hook: string; verdict: string }[];
  recommendations: { title: string; detail: string; priority: "high" | "medium" | "low" }[];
  analyzedCount: number;
  generatedAt: string;
}

interface Props {
  accountId: string | null;
  since: string;
  until: string;
}

const PHASES = [
  "Chargement des créas et de leurs métriques…",
  "Lecture des copies, hooks et landing pages…",
  "Recherche des patterns qui corrèlent avec la performance…",
  "Rédaction du plan de production…",
];

const ACTION_LABEL: Record<Analysis["losers"][number]["action"], { label: string; tone: "red" | "amber" | "blue" }> = {
  cut: { label: "Couper", tone: "red" },
  iterate: { label: "Itérer", tone: "amber" },
  watch: { label: "Surveiller", tone: "blue" },
};

const PRIORITY_LABEL: Record<Analysis["recommendations"][number]["priority"], { label: string; tone: "red" | "amber" | "default" }> = {
  high: { label: "Priorité haute", tone: "red" },
  medium: { label: "Priorité moyenne", tone: "amber" },
  low: { label: "Priorité basse", tone: "default" },
};

function AdCard({ creative, name, why, badge }: { creative?: Creative; name: string; why: string; badge?: React.ReactNode }) {
  return (
    <Card className="p-3 flex gap-3">
      <div className="w-14 h-14 rounded-lg overflow-hidden shrink-0 bg-gray-800">
        {creative ? (
          <CreativeThumbnail
            format={creative.format}
            thumbnailColor={creative.thumbnailColor}
            thumbnailUrl={creative.thumbnailUrl}
            videoUrl={creative.videoUrl}
            videoId={creative.videoId}
            className="w-14 h-14"
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-mono text-gray-200 truncate" title={name}>{creative?.name ?? name}</p>
          {badge}
        </div>
        {creative && (
          <p className="text-[10px] text-gray-500 mt-0.5">
            {creative.format} · {Math.round(creative.spend).toLocaleString("fr-FR")} dépensés · CTR {creative.ctr.toFixed(2)} %
            {creative.roas !== null && !creative.roasUnavailable && creative.roas > 0 ? ` · ROAS ${creative.roas.toFixed(2)}${creative.roasEstimated ? "*" : ""}` : ""}
          </p>
        )}
        <p className="text-[11px] text-gray-400 leading-relaxed mt-1">{why}</p>
      </div>
    </Card>
  );
}

export function CreativeAiAnalysis({ accountId, since, until }: Props) {
  const { creatives } = useCreativesContext();
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const byId = useMemo(() => new Map(creatives.map((c) => [c.id, c])), [creatives]);

  // Invalidate a previous result when the scope changes.
  useEffect(() => {
    setState("idle");
    setAnalysis(null);
    setError(null);
  }, [accountId, since, until]);

  useEffect(() => {
    if (state !== "loading") return;
    setPhase(0);
    const t = setInterval(() => setPhase((p) => Math.min(p + 1, PHASES.length - 1)), 40000);
    return () => clearInterval(t);
  }, [state]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(async (refresh: boolean) => {
    if (!accountId) return;
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setState("loading");
    setError(null);
    try {
      const res = await fetch("/api/creatives/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, since, until, refresh }),
        signal: ctl.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Erreur ${res.status}`);
      setAnalysis(data as Analysis);
      setState("done");
    } catch (err) {
      if (ctl.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Erreur inconnue");
      setState("error");
    }
  }, [accountId, since, until]);

  const action = (
    <div className="flex items-center gap-2">
      {state === "done" && (
        <button
          onClick={() => run(true)}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white px-2.5 py-1.5 rounded-lg border border-gray-800 hover:border-gray-700 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Actualiser
        </button>
      )}
      {state !== "loading" && state !== "done" && accountId && (
        <button
          onClick={() => run(false)}
          className="flex items-center gap-1.5 text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 px-3 py-1.5 rounded-lg transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5" /> Analyser les créas avec l&apos;IA
        </button>
      )}
    </div>
  );

  return (
    <Section title="Analyse IA des créas" icon={<Sparkles className="w-4 h-4 text-violet-400" />} action={action} bodyClassName="p-4">
      {!accountId && (
        <p className="text-xs text-gray-500">Connecte un compte Meta pour lancer l&apos;analyse IA.</p>
      )}

      {accountId && state === "idle" && (
        <p className="text-xs text-gray-500">
          L&apos;IA lit les métriques réelles, les copies, les hooks vidéo et les landing pages des créas les plus dépensières
          (jusqu&apos;à 40) sur la période {since} → {until}, puis en tire les gagnantes, les perdantes, les patterns et un plan de production.
          Aucun chiffre n&apos;est inventé : tout provient des données Meta chargées.
        </p>
      )}

      {state === "loading" && (
        <div className="flex items-center gap-3 py-4">
          <Loader2 className="w-4 h-4 text-violet-400 animate-spin shrink-0" />
          <div>
            <p className="text-sm text-gray-200">{PHASES[phase]}</p>
            <p className="text-[11px] text-gray-500 mt-0.5">Étape {phase + 1}/{PHASES.length} — compte 2 à 4 min, le résultat est ensuite gardé 1 h.</p>
          </div>
        </div>
      )}

      {state === "error" && (
        <div className="flex items-start gap-2 text-xs text-red-300 bg-red-900/15 border border-red-800/40 rounded-xl p-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {state === "done" && analysis && (
        <div className="space-y-5">
          {analysis.summary.length > 0 && (
            <ul className="space-y-1.5">
              {analysis.summary.map((s, i) => (
                <li key={i} className="text-sm text-gray-200 flex gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0 mt-2" />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {analysis.winners.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5"><Trophy className="w-3.5 h-3.5" /> Gagnantes</p>
                {analysis.winners.map((w) => (
                  <AdCard key={w.adId} creative={byId.get(w.adId)} name={w.name} why={w.why} />
                ))}
              </div>
            )}
            {analysis.losers.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-red-300 flex items-center gap-1.5"><Scissors className="w-3.5 h-3.5" /> Perdantes</p>
                {analysis.losers.map((l) => (
                  <AdCard
                    key={l.adId}
                    creative={byId.get(l.adId)}
                    name={l.name}
                    why={l.why}
                    badge={<Pill tone={ACTION_LABEL[l.action].tone} className="shrink-0">{ACTION_LABEL[l.action].label}</Pill>}
                  />
                ))}
              </div>
            )}
          </div>

          {analysis.patterns.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-200 flex items-center gap-1.5"><Lightbulb className="w-3.5 h-3.5 text-amber-300" /> Patterns</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {analysis.patterns.map((p, i) => (
                  <div
                    key={i}
                    className={`rounded-xl border p-3 ${p.impact === "positive" ? "border-emerald-900/50 bg-emerald-950/20" : "border-red-900/50 bg-red-950/20"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className={`text-xs font-semibold ${p.impact === "positive" ? "text-emerald-300" : "text-red-300"}`}>{p.title}</p>
                      <Pill tone={p.impact === "positive" ? "emerald" : "red"} className="shrink-0">{p.impact === "positive" ? "Positif" : "Négatif"}</Pill>
                    </div>
                    <p className="text-[11px] text-gray-400 leading-relaxed mt-1">{p.evidence}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {analysis.hooks.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-200 flex items-center gap-1.5"><Play className="w-3.5 h-3.5 text-pink-300" /> Hooks vidéo</p>
              <div className="divide-y divide-gray-800 border border-gray-800 rounded-xl">
                {analysis.hooks.map((h, i) => (
                  <div key={i} className="px-3 py-2.5">
                    <p className="text-xs font-medium text-gray-200">{h.hook}</p>
                    <p className="text-[11px] text-gray-400 leading-relaxed mt-0.5">{h.verdict}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {analysis.recommendations.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-200 flex items-center gap-1.5"><ListChecks className="w-3.5 h-3.5 text-violet-300" /> Plan de production</p>
              <div className="space-y-2">
                {analysis.recommendations.map((r, i) => (
                  <Card key={i} className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-semibold text-white">{r.title}</p>
                      <Pill tone={PRIORITY_LABEL[r.priority].tone} className="shrink-0">{PRIORITY_LABEL[r.priority].label}</Pill>
                    </div>
                    <p className="text-[11px] text-gray-400 leading-relaxed mt-1">{r.detail}</p>
                  </Card>
                ))}
              </div>
            </div>
          )}

          <p className="text-[10px] text-gray-600">
            Analyse générée le {new Date(analysis.generatedAt).toLocaleString("fr-FR")} sur {analysis.analyzedCount} créas (top dépense).
            * ROAS estimé (panier moyen).
          </p>
        </div>
      )}
    </Section>
  );
}
