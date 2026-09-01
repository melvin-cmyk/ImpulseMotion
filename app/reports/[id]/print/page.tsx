"use client";

/**
 * Printable (PDF) version of a report. Renders a light A4 document on top of
 * the app chrome; the browser's "Enregistrer en PDF" does the export — no
 * server-side PDF dependency. Print CSS lives in globals.css (.report-print-root).
 */

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { KpiStrip, ReportMarkdown, NextStepsList, TopCreativesStrip } from "@/components/reports/report-view";
import type { ReportData, ReportNextStep } from "@/lib/report-data";

interface FullReport {
  id: string;
  title: string;
  periodSince: string;
  periodUntil: string;
  compareSince: string | null;
  compareUntil: string | null;
  status: string;
  contentMd: string;
  data: ReportData | null;
  nextSteps: ReportNextStep[];
  dashboard: { id: string; name: string };
  createdAt: string;
}

function fmtPeriod(s: string, u: string): string {
  const f = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return `${f(s)} → ${f(u)}`;
}

export default function ReportPrintPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const [report, setReport] = useState<FullReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/reports/${id}`)
      .then(async (r) => { if (!r.ok) throw new Error(`Erreur ${r.status}`); return r.json(); })
      .then((j) => setReport(j.report))
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    if (report?.status === "ready" && params.get("auto") === "1") {
      const t = setTimeout(() => window.print(), 600);
      return () => clearTimeout(t);
    }
  }, [report, params]);

  return (
    <div className="report-print-root fixed inset-0 z-50 overflow-auto bg-neutral-200 text-neutral-900">
      <div className="print:hidden sticky top-0 z-10 bg-neutral-900 text-white px-4 h-11 flex items-center justify-between text-sm">
        <Link href={`/reports/${id}`} className="text-neutral-300 hover:text-white">← Retour au rapport</Link>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-400">Choisissez « Enregistrer en PDF » dans la boîte d&apos;impression</span>
          <button type="button" onClick={() => window.print()} className="px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 text-xs font-semibold">Imprimer / PDF</button>
        </div>
      </div>

      {error && <div className="p-8 text-red-700">{error}</div>}
      {!report && !error && <div className="p-8 text-neutral-600 text-sm">Chargement…</div>}

      {report && (
        <article className="report-print-page mx-auto my-6 print:my-0 bg-white shadow-lg print:shadow-none w-[210mm] min-h-[297mm] px-[16mm] py-[14mm] text-[12px] leading-relaxed">
          <header className="border-b-2 border-neutral-900 pb-3 mb-4 flex items-end justify-between gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-[0.15em] text-neutral-500 font-semibold">Rapport de performance · Impulse Analytics</div>
              <h1 className="text-[22px] font-bold leading-tight mt-1 text-neutral-900">{report.dashboard.name}</h1>
              <div className="text-neutral-600 mt-0.5">{fmtPeriod(report.periodSince, report.periodUntil)}</div>
              {report.compareSince && report.compareUntil && (
                <div className="text-[10px] text-neutral-500">Comparé à {fmtPeriod(report.compareSince, report.compareUntil)}</div>
              )}
            </div>
            <div className="text-right text-[10px] text-neutral-500">
              <div>Généré le {new Date(report.createdAt).toLocaleDateString("fr-FR")}</div>
              <div>Rédigé par l&apos;IA, validé par un consultant</div>
            </div>
          </header>

          {report.status !== "ready" ? (
            <p className="text-neutral-600">Ce rapport n&apos;est pas encore prêt.</p>
          ) : (
            <>
              <KpiStrip data={report.data} variant="print" />
              <div className="mt-3">
                <TopCreativesStrip data={report.data} variant="print" />
              </div>
              <div className="mt-2">
                <ReportMarkdown content={report.contentMd} variant="print" />
              </div>
              <section className="mt-6 break-inside-avoid">
                <h2 className="text-base font-bold border-b border-neutral-300 pb-1 mb-3">Next steps</h2>
                <NextStepsList steps={report.nextSteps} variant="print" />
              </section>
              {report.data?.kpis.some((k) => k.estimated) && (
                <p className="text-[10px] text-neutral-500 mt-6">* Revenu estimé à partir du panier moyen configuré (le compte ne remonte pas la valeur des conversions).</p>
              )}
            </>
          )}
        </article>
      )}
    </div>
  );
}
