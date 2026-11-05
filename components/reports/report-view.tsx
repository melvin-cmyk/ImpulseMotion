"use client";

/**
 * Shared rendering of an AI client report: KPI strip from the frozen data
 * snapshot, the Markdown body, and the next-steps checklist.
 * `variant="print"` switches to a light, paper-oriented palette used by the
 * PDF export page; everything else renders in the app's dark theme.
 */

import ReactMarkdown from "react-markdown";
import { SAFE_MD_COMPONENTS } from "@/components/ai/safe-image";
import remarkGfm from "remark-gfm";
import type { ReportData, ReportKpi, ReportNextStep } from "@/lib/report-data";
import { fmtMetric, fmtMoney, fmtRoas } from "@/components/portfolio/format";
import { cn } from "@/lib/utils";

export type ReportVariant = "app" | "print";

const KPI_ORDER = ["spend", "revenue", "roas", "purchases", "cpa", "ctr", "cpc", "cr"];

/** Snapshots written before the currency was recorded show bare numbers, never a fake €. */
function fmtKpi(k: ReportKpi, value: number, currency: string | null): string {
  return fmtMetric(k.metric, value, k.currency ?? currency, { estimated: k.estimated, unavailable: k.unavailable });
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
              print ? "border border-neutral-300 bg-white" : "bg-ui-card border border-ui-line",
            )}
          >
            <div className={cn("text-[10px] font-medium", print ? "text-ui-muted" : "text-ui-muted")}>
              {k.label}
              {k.estimated && <span title="Revenu estimé via panier moyen"> *</span>}
            </div>
            <div className={cn("text-lg font-medium tabular-nums mt-0.5", k.unavailable ? "text-ui-muted" : print ? "text-ui-muted" : "text-ui-fg")}>
              {fmtKpi(k, k.value, data.currency)}
            </div>
            {!k.unavailable && k.deltaPct !== null && (
              <div
                className={cn(
                  "text-[11px] font-medium tabular-nums",
                  tone === "good" && (print ? "text-emerald-700" : "text-emerald-400"),
                  tone === "bad" && (print ? "text-red-700" : "text-red-400"),
                  tone === "neutral" && (print ? "text-ui-muted" : "text-ui-muted"),
                )}
              >
                {k.deltaPct > 0 ? "+" : ""}{k.deltaPct.toFixed(1)} %
                {k.previous !== null && (
                  <span className={cn("font-normal ml-1", print ? "text-ui-fg2" : "text-ui-muted")}>
                    vs {fmtKpi(k, k.previous, data.currency)}
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

const VIDEO_PLATFORM: Record<string, string> = { meta: "Meta Ads", google: "Google Ads", tiktok: "TikTok Ads" };
const n0 = (v: number) => Math.round(v).toLocaleString("fr-FR");

/** Video views per platform (accounts on a video-view objective); nothing when no platform counted views. */
export function VideoViewsTable({ data, variant = "app" }: { data: ReportData | null; variant?: ReportVariant }) {
  const rows = data?.video ?? [];
  if (!rows.length) return null;
  const print = variant === "print";
  const hasThruplay = rows.some((r) => r.thruplay !== null);
  const th = cn("text-left font-medium px-2 py-1.5 text-[10px] ", print ? "text-ui-muted" : "text-ui-muted");
  const td = cn("px-2 py-1.5 tabular-nums", print ? "text-ui-muted" : "text-ui-fg");
  return (
    <div className={cn("rounded-xl overflow-hidden", print ? "border border-neutral-300 bg-white" : "bg-ui-card border border-ui-line")}>
      <div className={cn("px-3 pt-2.5 text-[10px] font-medium", print ? "text-ui-muted" : "text-ui-muted")}>Vues vidéo</div>
      <table className="w-full text-xs mt-1">
        <thead>
          <tr>
            <th className={th}>Plateforme</th>
            <th className={th}>Vues</th>
            {hasThruplay && <th className={th}>ThruPlay</th>}
            <th className={th}>25 %</th>
            <th className={th}>50 %</th>
            <th className={th}>75 %</th>
            <th className={th}>100 %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.platform} className={print ? "border-t border-neutral-200" : "border-t border-ui-line"}>
              <td className={td}>
                {VIDEO_PLATFORM[r.platform] ?? r.platform}
                <span className={cn("ml-1", print ? "text-ui-muted" : "text-ui-muted")}>({r.viewsLabel})</span>
              </td>
              <td className={td}>
                {n0(r.views)}
                {r.viewsDeltaPct !== null && (
                  <span className={cn("ml-1 text-[10px]", r.viewsDeltaPct >= 0 ? (print ? "text-emerald-700" : "text-emerald-400") : (print ? "text-red-700" : "text-red-400"))}>
                    {r.viewsDeltaPct > 0 ? "+" : ""}{r.viewsDeltaPct.toFixed(1)} %
                  </span>
                )}
              </td>
              {hasThruplay && <td className={td}>{r.thruplay === null ? "—" : n0(r.thruplay)}</td>}
              <td className={td}>{n0(r.p25)}</td>
              <td className={td}>{n0(r.p50)}</td>
              <td className={td}>{n0(r.p75)}</td>
              <td className={td}>{n0(r.p100)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.some((r) => r.platform === "google") && (
        <div className={cn("px-3 pb-2 text-[10px]", print ? "text-ui-muted" : "text-ui-muted")}>Google Ads : quartiles = impressions × taux de visionnage.</div>
      )}
    </div>
  );
}

export function ReportMarkdown({ content, variant = "app" }: { content: string; variant?: ReportVariant }) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none",
        variant === "print"
          ? "prose-neutral prose-headings:text-ui-muted prose-h2:text-base prose-h2:mt-6 prose-h2:mb-2 prose-h2:pb-1 prose-h2:border-b prose-h2:border-neutral-300 prose-table:text-[11px] prose-th:text-ui-muted prose-td:py-1 prose-th:py-1 prose-p:text-ui-muted prose-li:text-ui-muted prose-strong:text-ui-muted"
          : "ui-prose prose-h2:text-base prose-h2:mt-8 prose-h2:mb-3 prose-h2:pb-1.5 prose-h2:border-b prose-h2:border-ui-line prose-h2:text-ui-accent-ink prose-table:text-xs prose-th:text-ui-fg2 prose-td:py-1 prose-th:py-1 prose-p:text-ui-fg2 prose-li:text-ui-fg2 prose-strong:text-ui-fg",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={SAFE_MD_COMPONENTS}>{content}</ReactMarkdown>
    </div>
  );
}

const PRIORITY_LABEL: Record<ReportNextStep["priority"], string> = { high: "Priorité haute", medium: "Priorité moyenne", low: "Priorité basse" };
const PLATFORM_LABEL: Record<string, string> = { meta: "Meta", google: "Google", tiktok: "TikTok", global: "Global", crm: "CRM" };

export function NextStepsList({
  steps,
  variant = "app",
  onToggle,
  pilotHref,
}: {
  steps: ReportNextStep[];
  variant?: ReportVariant;
  onToggle?: (id: string, done: boolean) => void;
  /** The /pilotage link that prepares this step on the client's account (staff, app view); null = no link. */
  pilotHref?: (step: ReportNextStep) => string | null;
}) {
  const print = variant === "print";
  if (!steps.length) {
    return <p className={cn("text-sm", print ? "text-ui-muted" : "text-ui-muted")}>Aucune action proposée.</p>;
  }
  return (
    <ol className="space-y-2">
      {steps.map((s, i) => (
        <li
          key={s.id}
          className={cn(
            "flex gap-3 rounded-xl px-3 py-2.5",
            print ? "border border-neutral-300 bg-white" : "bg-ui-card border border-ui-line",
            s.done && !print && "opacity-60",
          )}
        >
          {onToggle && !print ? (
            <button
              type="button"
              onClick={() => onToggle(s.id, !s.done)}
              aria-label={s.done ? "Marquer à faire" : "Marquer fait"}
              className={cn(
                "mt-0.5 h-5 w-5 shrink-0 rounded-md border flex items-center justify-center text-xs font-medium transition-colors",
                s.done ? "bg-emerald-600 border-emerald-500 text-white" : "border-ui-line-strong text-transparent hover:border-ui-accent",
              )}
            >
              ✓
            </button>
          ) : (
            <span className={cn("mt-0.5 h-5 w-5 shrink-0 rounded-md border text-[11px] font-medium flex items-center justify-center", print ? "border-neutral-400 text-ui-muted" : "border-ui-line-strong text-ui-fg2")}>
              {s.done ? "✓" : i + 1}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("text-sm font-medium", print ? "text-ui-muted" : "text-ui-fg", s.done && "line-through")}>{s.title}</span>
              <span
                className={cn(
                  "text-[10px] font-medium px-1.5 py-0.5 rounded",
                  s.priority === "high" && (print ? "bg-red-100 text-red-800" : "bg-red-500/15 text-red-300"),
                  s.priority === "medium" && (print ? "bg-amber-100 text-amber-800" : "bg-amber-500/15 text-amber-300"),
                  s.priority === "low" && (print ? "bg-neutral-200 text-ui-muted" : "bg-ui-raised text-ui-fg2"),
                )}
              >
                {PRIORITY_LABEL[s.priority]}
              </span>
              {s.platform && s.platform !== "global" && (
                <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded", print ? "bg-neutral-200 text-ui-muted" : "bg-ui-raised text-ui-fg2")}>
                  {PLATFORM_LABEL[s.platform]}
                </span>
              )}
            </div>
            {s.detail && <p className={cn("text-xs mt-1 leading-relaxed", print ? "text-ui-muted" : "text-ui-fg2")}>{s.detail}</p>}
            {!print && pilotHref && (() => {
              const href = pilotHref(s);
              if (!href) return null;
              return (
                <a href={href} className="inline-flex items-center gap-1 mt-1.5 text-xs text-ui-accent-ink hover:text-ui-fg">
                  {s.done && s.pilotActionId ? "Fait depuis le Pilotage · revoir →" : "Faire dans le Pilotage →"}
                </a>
              );
            })()}
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
        <div key={c.adId} className={cn("rounded-lg overflow-hidden", print ? "border border-neutral-300 bg-white" : "bg-ui-card border border-ui-line")}>
          <div className={cn("aspect-square w-full", print ? "bg-neutral-100" : "bg-ui-bg")}>
            {c.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/media/proxy-image?url=${encodeURIComponent(c.imageUrl)}&upgrade=1`} alt="" className="h-full w-full object-cover" />
            ) : null}
          </div>
          <div className="px-2 py-1.5">
            <div className={cn("text-[10px] truncate font-medium", print ? "text-ui-muted" : "text-ui-fg2")} title={c.name}>{c.name}</div>
            <div className={cn("text-[10px] tabular-nums", print ? "text-ui-muted" : "text-ui-muted")}>
              {fmtMoney(c.spend, data?.currency, { digits: 0 })} · ROAS {fmtRoas(c.roas, { estimated: c.estimated })}
              {c.hookRate !== null && ` · hook ${c.hookRate} %`}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
