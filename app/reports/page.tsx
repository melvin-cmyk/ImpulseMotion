"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FileText, Plus, Loader2, Bot, Clock, Users, BarChart3 } from "lucide-react";
import { Card, PageHeader, Pill } from "@/components/ui/surface";
import { NewReportForm, type ReportClient } from "@/components/reports/new-report-form";
import { PersonaPanel } from "@/components/reports/persona-panel";
import { ACL_CHANGED_EVENT } from "@/lib/acl-version";

interface ReportRow {
  id: string;
  title: string;
  periodSince: string;
  periodUntil: string;
  status: string;
  trigger: string;
  summary: string | null;
  error: string | null;
  nextStepsCount: number;
  nextStepsDone: number;
  dashboard: { id: string; name: string; reportFrequency: string | null };
  author: { name: string | null; email: string | null } | null;
  createdAt: string;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}
function fmtPeriod(s: string, u: string): string {
  const f = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${f(s)} → ${f(u)}`;
}

const STATUS: Record<string, { label: string; tone: "default" | "emerald" | "amber" | "red" | "blue" }> = {
  ready: { label: "Prêt", tone: "emerald" },
  generating: { label: "Génération…", tone: "blue" },
  failed: { label: "Échec", tone: "red" },
};

export default function ReportsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [clients, setClients] = useState<ReportClient[]>([]);
  const [filter, setFilter] = useState<string>(params.get("dashboardId") ?? "");
  const [showNew, setShowNew] = useState(params.get("new") === "1" || params.get("new") === "persona");
  // Rubrique of « Nouveau rapport » : a performance report, or the client's personas (HQ).
  const [newKind, setNewKind] = useState<"report" | "persona">(params.get("new") === "persona" ? "persona" : "report");
  const [personaClientId, setPersonaClientId] = useState<string>(params.get("dashboardId") ?? "");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([
        fetch(`/api/reports?limit=100${filter ? `&dashboardId=${filter}` : ""}`).then((x) => x.json()),
        fetch("/api/reports/clients").then((x) => x.json()),
      ]);
      setReports(r.reports ?? []);
      setClients(c.clients ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    }
  }, [filter]);

  useEffect(() => {
    // Deferred so the lint rule about synchronous setState in effects stays honest.
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  // A client added by an admin shows up without signing out and in again.
  useEffect(() => {
    const onChange = () => { void load(); };
    window.addEventListener(ACL_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(ACL_CHANGED_EVENT, onChange);
  }, [load]);

  const generating = reports?.some((r) => r.status === "generating");
  useEffect(() => {
    if (!generating) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [generating, load]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Rapports IA"
        subtitle="Un rapport par client et par période, rédigé par l'IA à partir des données Meta, Google et TikTok Ads : synthèse, analyse, next steps, export PDF."
        action={
          <button
            type="button"
            onClick={() => setShowNew((v) => !v)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold"
          >
            <Plus className="w-4 h-4" /> Nouveau rapport
          </button>
        }
      />

      {showNew && (
        <Card padded>
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <h2 className="text-sm font-semibold text-white">Nouveau rapport</h2>
            <div className="inline-flex rounded-lg border border-gray-800 bg-gray-950 p-0.5">
              {([
                { key: "report", label: "Rapport de performance", icon: BarChart3 },
                { key: "persona", label: "Persona", icon: Users },
              ] as const).map((k) => (
                <button
                  key={k.key}
                  type="button"
                  onClick={() => setNewKind(k.key)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${newKind === k.key ? "bg-violet-600 text-white" : "text-gray-400 hover:text-white"}`}
                >
                  <k.icon className="w-3.5 h-3.5" /> {k.label}
                </button>
              ))}
            </div>
            <span className="text-xs text-gray-500">
              {newKind === "report"
                ? "Synthèse, analyse et next steps sur une période, à partir des données Meta, Google et TikTok Ads."
                : "Les personas du client tels qu'HQ les documente : lecture, rédaction par l'IA à partir des avis clients, confirmation puis écriture dans HQ."}
            </span>
          </div>
          {clients.length === 0 ? (
            <p className="text-sm text-gray-500">Aucun client (dashboard) disponible. Créez d&apos;abord un dashboard client dans <Link href="/d" className="text-violet-400">Dashboards clients</Link>.</p>
          ) : newKind === "report" ? (
            <NewReportForm
              clients={clients}
              defaultClientId={filter || undefined}
              onCreated={(id) => router.push(`/reports/${id}`)}
              onCancel={() => setShowNew(false)}
            />
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-1">Client</label>
                <select
                  value={personaClientId || filter || clients[0]?.id || ""}
                  onChange={(e) => setPersonaClientId(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
                >
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              {(personaClientId || filter || clients[0]?.id) && (
                <PersonaPanel key={personaClientId || filter || clients[0].id} dashboardId={personaClientId || filter || clients[0].id} />
              )}
              <button type="button" onClick={() => setShowNew(false)} className="px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white">Fermer</button>
            </div>
          )}
        </Card>
      )}

      <div className="flex items-center gap-3">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
        >
          <option value="">Tous les clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {clients.some((c) => c.reportFrequency) && (
          <span className="text-xs text-gray-500 inline-flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" />
            {clients.filter((c) => c.reportFrequency).length} client{clients.filter((c) => c.reportFrequency).length > 1 ? "s" : ""} en rapport automatique
          </span>
        )}
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}

      {reports === null ? (
        <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement…</div>
      ) : reports.length === 0 ? (
        <Card padded className="text-center py-12">
          <FileText className="w-8 h-8 text-gray-700 mx-auto mb-3" />
          <p className="text-sm text-gray-400">Aucun rapport pour l&apos;instant.</p>
          <p className="text-xs text-gray-600 mt-1">Cliquez sur « Nouveau rapport » pour générer le premier.</p>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {reports.map((r) => {
            const st = STATUS[r.status] ?? { label: r.status, tone: "default" as const };
            return (
              <Link key={r.id} href={`/reports/${r.id}`} className="block">
                <Card padded interactive className="h-full">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[11px] uppercase tracking-wider text-violet-300 font-semibold truncate">{r.dashboard.name}</div>
                      <h3 className="text-sm font-semibold text-white mt-0.5 truncate">{r.title}</h3>
                      <div className="text-xs text-gray-500 mt-0.5">{fmtPeriod(r.periodSince, r.periodUntil)}</div>
                    </div>
                    <Pill tone={st.tone}>{r.status === "generating" ? <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />{st.label}</span> : st.label}</Pill>
                  </div>
                  {r.summary && <p className="text-xs text-gray-400 mt-3 line-clamp-3 leading-relaxed">{r.summary}</p>}
                  {r.error && r.status === "failed" && <p className="text-xs text-red-400 mt-3 line-clamp-2">{r.error}</p>}
                  <div className="flex items-center gap-3 mt-3 text-[11px] text-gray-600">
                    <span>{fmtDate(r.createdAt)}</span>
                    {r.trigger === "cron" ? <span className="inline-flex items-center gap-1"><Bot className="w-3 h-3" /> automatique</span> : r.author?.name ? <span>par {r.author.name}</span> : null}
                    {r.nextStepsCount > 0 && <span className="ml-auto tabular-nums">{r.nextStepsDone}/{r.nextStepsCount} actions faites</span>}
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
