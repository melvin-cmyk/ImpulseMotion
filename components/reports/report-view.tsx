"use client";

/**
 * Shared rendering of an AI client report: KPI strip from the frozen data
 * snapshot, the Markdown body, and the next-steps checklist.
 * `variant="print"` switches to a light, paper-oriented palette used by the
 * PDF export page; everything else renders in the app's dark theme.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReportData, ReportNextStep } from "@/lib/report-data";
import { cn } from "@/lib/utils";

export type ReportVariant = "app" | "print";

const KPI_ORDER = ["spend", "revenue", "roas", "purchases", "cpa", "ctr", "cpc", "cr"];

export function fmtKpi(metric: string, value: number): string {
  if (["spend", "revenue", "cpa", "cpc"].includes(metric)) {
    return `${value.toLocaleString("fr-FR", { maximumFractionDigits: metric === "cpc" ? 2 : 0 })} €`;
  }
  if (["ctr", "cr"].includes(metric)) return `${value.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %`;
  if (metric === "roas") return `${value.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}x`;
  return value.toLocaleString("fr-FR", { maximumFractionDigits: 0 });
}

/** Lower is better for costs. */
const INVERTED = new Set(["cpa", "cpc", "spend"]);

function deltaTone(metric: string, deltaPct: number | null): "good" | "bad" | "neutral" {
  if (deltaPct === null || Math.abs(deltaPct) < 0.5) return "neutral";
  if (metric === "spend") return "neutral";
  const up = deltaPct > 0;
  return INVERTED.has(metric) ? (up ? "bad" : "good") : up ? "good" : "bad";
}

export function KpiStrip({ data, variant = "app" }: { data: ReportData | null; variant?: ReportVariant }) {
  if (!data?.kpis?.length) return null;
  const kpis = KPI_ORDER.map((m) => data.kpis.find((k) => k.metric === m)).filter((k): k is ReportData["kpis"][number] => !!k);
  const print = variant === "print";
  return (
    <div className={cn("grid gap-2", print ? "grid-cols-4" : "grid-cols-2 md:grid-cols-4")}>
      {kpis.map((k) => {
        const tone = deltaTone(k.metric, k.deltaPct);
        return (
          <div
            key={k.metric}
            className={cn(
              "rounded-xl px-3 py-2.5",
              print ? "border border-neutral-300 bg-white" : "bg-gray-900 border border-gray-800",
            )}
          >
            <div className={cn("text-[10px] uppercase tracking-wider font-semibold", print ? "text-neutral-500" : "text-gray-500")}>
              {k.label}
              {k.estimated && <span title="Revenu estimé via panier moyen"> *</span>}
            </div>
            <div className={cn("text-lg font-bold tabular-nums mt-0.5", print ? "text-neutral-900" : "text-white")}>
              {fmtKpi(k.metric, k.value)}
            </div>
            {k.deltaPct !== null && (
              <div
                className={cn(
                  "text-[11px] font-semibold tabular-nums",
                  tone === "good" && (print ? "text-emerald-700" : "text-emerald-400"),
                  tone === "bad" && (print ? "text-red-700" : "text-red-400"),
                  tone === "neutral" && (print ? "text-neutral-500" : "text-gray-500"),
                )}
              >
                {k.deltaPct > 0 ? "+" : ""}{k.deltaPct.toFixed(1)} %
                {k.previous !== null && (
                  <span className={cn("font-normal ml-1", print ? "text-neutral-400" : "text-gray-600")}>
                    vs {fmtKpi(k.metric, k.previous)}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ReportMarkdown({ content, variant = "app" }: { content: string; variant?: ReportVariant }) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none",
        variant === "print"
          ? "prose-neutral prose-headings:text-neutral-900 prose-h2:text-base prose-h2:mt-6 prose-h2:mb-2 prose-h2:pb-1 prose-h2:border-b prose-h2:border-neutral-300 prose-table:text-[11px] prose-th:text-neutral-600 prose-td:py-1 prose-th:py-1 prose-p:text-neutral-800 prose-li:text-neutral-800 prose-strong:text-neutral-900"
          : "prose-invert prose-h2:text-base prose-h2:mt-8 prose-h2:mb-3 prose-h2:pb-1.5 prose-h2:border-b prose-h2:border-gray-800 prose-h2:text-violet-200 prose-table:text-xs prose-th:text-gray-400 prose-td:py-1 prose-th:py-1 prose-p:text-gray-300 prose-li:text-gray-300 prose-strong:text-white",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

const PRIORITY_LABEL: Record<ReportNextStep["priority"], string> = { high: "Priorité haute", medium: "Priorité moyenne", low: "Priorité basse" };
const PLATFORM_LABEL: Record<string, string> = { meta: "Meta", google: "Google", global: "Global" };

export function NextStepsList({
  steps,
  variant = "app",
  onToggle,
}: {
  steps: ReportNextStep[];
  variant?: ReportVariant;
  onToggle?: (id: string, done: boolean) => void;
}) {
  const print = variant === "print";
  if (!steps.length) {
    return <p className={cn("text-sm", print ? "text-neutral-500" : "text-gray-500")}>Aucune action proposée.</p>;
  }
  return (
    <ol className="space-y-2">
      {steps.map((s, i) => (
        <li
          key={s.id}
          className={cn(
            "flex gap-3 rounded-xl px-3 py-2.5",
            print ? "border border-neutral-300 bg-white" : "bg-gray-900 border border-gray-800",
            s.done && !print && "opacity-60",
          )}
        >
          {onToggle && !print ? (
            <button
              type="button"
              onClick={() => onToggle(s.id, !s.done)}
              aria-label={s.done ? "Marquer à faire" : "Marquer fait"}
              className={cn(
                "mt-0.5 h-5 w-5 shrink-0 rounded-md border flex items-center justify-center text-xs font-bold transition-colors",
                s.done ? "bg-emerald-600 border-emerald-500 text-white" : "border-gray-700 text-transparent hover:border-violet-500",
              )}
            >
              ✓
            </button>
          ) : (
            <span className={cn("mt-0.5 h-5 w-5 shrink-0 rounded-md border text-[11px] font-bold flex items-center justify-center", print ? "border-neutral-400 text-neutral-700" : "border-gray-700 text-gray-400")}>
              {s.done ? "✓" : i + 1}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("text-sm font-semibold", print ? "text-neutral-900" : "text-white", s.done && "line-through")}>{s.title}</span>
              <span
                className={cn(
                  "text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded",
                  s.priority === "high" && (print ? "bg-red-100 text-red-800" : "bg-red-500/15 text-red-300"),
                  s.priority === "medium" && (print ? "bg-amber-100 text-amber-800" : "bg-amber-500/15 text-amber-300"),
                  s.priority === "low" && (print ? "bg-neutral-200 text-neutral-700" : "bg-gray-800 text-gray-400"),
                )}
              >
                {PRIORITY_LABEL[s.priority]}
              </span>
              {s.platform && s.platform !== "global" && (
                <span className={cn("text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded", print ? "bg-neutral-200 text-neutral-700" : "bg-gray-800 text-gray-400")}>
                  {PLATFORM_LABEL[s.platform]}
                </span>
              )}
            </div>
            {s.detail && <p className={cn("text-xs mt-1 leading-relaxed", print ? "text-neutral-700" : "text-gray-400")}>{s.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function TopCreativesStrip({ data, variant = "app" }: { data: ReportData | null; variant?: ReportVariant }) {
  const creatives = (data?.creatives ?? []).slice(0, 6);
  if (!creatives.length) return null;
  const print = variant === "print";
  return (
    <div className={cn("grid gap-2", print ? "grid-cols-6" : "grid-cols-3 md:grid-cols-6")}>
      {creatives.map((c) => (
        <div key={c.adId} className={cn("rounded-lg overflow-hidden", print ? "border border-neutral-300 bg-white" : "bg-gray-900 border border-gray-800")}>
          <div className={cn("aspect-square w-full", print ? "bg-neutral-100" : "bg-gray-950")}>
            {c.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/media/proxy-image?url=${encodeURIComponent(c.imageUrl)}&upgrade=1`} alt="" className="h-full w-full object-cover" />
            ) : null}
          </div>
          <div className="px-2 py-1.5">
            <div className={cn("text-[10px] truncate font-medium", print ? "text-neutral-800" : "text-gray-300")} title={c.name}>{c.name}</div>
            <div className={cn("text-[10px] tabular-nums", print ? "text-neutral-500" : "text-gray-500")}>
              {c.spend.toLocaleString("fr-FR")} € · ROAS {c.roas}{c.estimated ? "*" : ""}
              {c.hookRate !== null && ` · hook ${c.hookRate} %`}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
