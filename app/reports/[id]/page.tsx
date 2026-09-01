"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Printer, RefreshCw, MessageSquare, Trash2, ExternalLink, Bot } from "lucide-react";
import { Card, Pill } from "@/components/ui/surface";
import { KpiStrip, ReportMarkdown, NextStepsList, TopCreativesStrip } from "@/components/reports/report-view";
import { ReportChat, type ChatMessage } from "@/components/reports/report-chat";
import type { ReportData, ReportNextStep } from "@/lib/report-data";

interface FullReport {
  id: string;
  title: string;
  periodSince: string;
  periodUntil: string;
  compareSince: string | null;
  compareUntil: string | null;
  status: string;
  trigger: string;
  summary: string | null;
  error: string | null;
  contentMd: string;
  data: ReportData | null;
  nextSteps: ReportNextStep[];
  chat: ChatMessage[];
  dashboard: { id: string; name: string; metaAccountId: string | null; googleCustomerId: string | null; reportFrequency: string | null };
  author: { name: string | null; email: string | null } | null;
  createdAt: string;
}

function fmtPeriod(s: string, u: string): string {
  const f = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return `${f(s)} → ${f(u)}`;
}

export default function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [report, setReport] = useState<FullReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/reports/${id}`);
    if (!res.ok) { setError(res.status === 404 ? "Rapport introuvable" : `Erreur ${res.status}`); return; }
    const j = await res.json();
    setReport(j.report);
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const generating = report?.status === "generating" || regenerating;
  useEffect(() => {
    if (!generating) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [generating, load]);

  async function toggleStep(stepId: string, done: boolean) {
    if (!report) return;
    const next = report.nextSteps.map((s) => (s.id === stepId ? { ...s, done } : s));
    setReport({ ...report, nextSteps: next });
    await fetch(`/api/reports/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nextSteps: next }),
    });
  }

  async function regenerate() {
    if (!report || generating) return;
    if (!confirm("Régénérer ce rapport ? Le contenu actuel et les compléments seront remplacés.")) return;
    setRegenerating(true);
    setReport({ ...report, status: "generating" });
    try {
      const res = await fetch(`/api/reports/${id}/regenerate`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Erreur ${res.status}`);
      }
    } finally {
      setRegenerating(false);
      void load();
    }
  }

  async function remove() {
    if (!confirm("Supprimer définitivement ce rapport ?")) return;
    await fetch(`/api/reports/${id}`, { method: "DELETE" });
    router.push("/reports");
  }

  if (error) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Link href="/reports" className="text-sm text-violet-400 inline-flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Rapports</Link>
        <div className="mt-4 text-red-400 text-sm">{error}</div>
      </div>
    );
  }
  if (!report) {
    return <div className="p-6 flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement…</div>;
  }

  const btn = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border bg-gray-900 border-gray-800 text-gray-300 hover:text-white hover:border-gray-700 disabled:opacity-50 transition-colors";

  return (
    <div className={`p-6 max-w-5xl mx-auto space-y-6 ${showChat ? "sm:pr-[460px]" : ""}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Link href="/reports" className="text-sm text-gray-400 hover:text-white inline-flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Rapports</Link>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href={`/portfolio/${report.dashboard.id}`} className={btn}><ExternalLink className="w-3.5 h-3.5" /> Fiche client</Link>
          <button type="button" onClick={regenerate} disabled={generating} className={btn}><RefreshCw className={`w-3.5 h-3.5 ${generating ? "animate-spin" : ""}`} /> Régénérer</button>
          <Link href={`/reports/${report.id}/print`} className={btn} aria-disabled={report.status !== "ready"}><Printer className="w-3.5 h-3.5" /> Exporter PDF</Link>
          <button
            type="button"
            onClick={() => setShowChat((v) => !v)}
            disabled={report.status !== "ready"}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-50 ${showChat ? "bg-violet-600 border-violet-500 text-white" : "bg-gray-900 border-gray-800 text-gray-300 hover:text-white"}`}
          >
            <MessageSquare className="w-3.5 h-3.5" /> Chat IA
          </button>
          <button type="button" onClick={remove} className={`${btn} hover:border-red-900 hover:text-red-300`} title="Supprimer"><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      <header>
        <div className="text-[11px] uppercase tracking-wider text-violet-300 font-semibold">{report.dashboard.name}</div>
        <h1 className="text-2xl font-bold text-white mt-1">{report.title}</h1>
        <div className="flex items-center gap-3 mt-2 text-xs text-gray-500 flex-wrap">
          <span>{fmtPeriod(report.periodSince, report.periodUntil)}</span>
          {report.compareSince && report.compareUntil && <span>· comparé à {fmtPeriod(report.compareSince, report.compareUntil)}</span>}
          <span>· généré le {new Date(report.createdAt).toLocaleDateString("fr-FR")}</span>
          {report.trigger === "cron" && <span className="inline-flex items-center gap-1"><Bot className="w-3 h-3" /> automatique</span>}
          <Pill tone={report.status === "ready" ? "emerald" : report.status === "failed" ? "red" : "blue"}>
            {report.status === "ready" ? "Prêt" : report.status === "failed" ? "Échec" : "Génération…"}
          </Pill>
        </div>
      </header>

      {report.status === "generating" && (
        <Card padded className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-violet-400" />
          <div>
            <div className="text-sm text-white font-medium">L&apos;IA rédige le rapport…</div>
            <div className="text-xs text-gray-500">Collecte des données puis rédaction : 1 à 3 minutes. La page se met à jour automatiquement.</div>
          </div>
        </Card>
      )}
      {report.status === "failed" && (
        <Card padded className="border-red-900/40">
          <div className="text-sm text-red-300 font-medium">La génération a échoué</div>
          <div className="text-xs text-gray-400 mt-1 break-words">{report.error}</div>
          <button type="button" onClick={regenerate} className={`${btn} mt-3`}><RefreshCw className="w-3.5 h-3.5" /> Réessayer</button>
        </Card>
      )}

      {report.status === "ready" && (
        <>
          <KpiStrip data={report.data} />
          <TopCreativesStrip data={report.data} />
          {report.data?.warnings?.length ? (
            <div className="text-[11px] text-amber-300/80 bg-amber-500/5 border border-amber-900/30 rounded-lg px-3 py-2">
              Données partielles : {report.data.warnings.join(" · ")}
            </div>
          ) : null}
          <Card padded>
            <ReportMarkdown content={report.contentMd} />
          </Card>
          <section>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-base font-semibold text-white">Next steps</h2>
              <span className="text-xs text-gray-500 tabular-nums">{report.nextSteps.filter((s) => s.done).length}/{report.nextSteps.length} faits</span>
            </div>
            <NextStepsList steps={report.nextSteps} onToggle={toggleStep} />
          </section>
        </>
      )}

      {showChat && report.status === "ready" && (
        <ReportChat
          reportId={report.id}
          initial={report.chat}
          onClose={() => setShowChat(false)}
          onAppended={(md) => setReport((r) => (r ? { ...r, contentMd: md } : r))}
        />
      )}
    </div>
  );
}
