"use client";

import { cn } from "@/lib/utils";
import { SlideShell } from "./slide-shell";
import type { SlideData, KPI, ChartData, SlideSeverity } from "@/types/deck";

// ── Design tokens (matches slides.tsx) ───────────────────────────────────────

const colors = {
  blueDeep: "#0944A1",
  blueSignature: "#2CA6F9",
  violet: "#7F5AFD",
  deltaPos: "#0B8043",
  deltaNeg: "#C53929",
  bgAlt: "#F2F9FE",
  caption: "#CCCCCC",
};

// ── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ kpi }: { kpi: KPI }) {
  const trendColor =
    kpi.trend === "up"
      ? colors.deltaPos
      : kpi.trend === "down"
      ? colors.deltaNeg
      : colors.caption;

  const trendArrow =
    kpi.trend === "up" ? "▲" : kpi.trend === "down" ? "▼" : "—";

  return (
    <div
      className="flex flex-col gap-[4%] rounded-md px-[6%] py-[5%]"
      style={{ background: colors.bgAlt, minWidth: 0 }}
    >
      <span
        className="text-[1.4%] font-semibold uppercase tracking-widest truncate"
        style={{ color: colors.caption }}
      >
        {kpi.label}
      </span>
      <span
        className="text-[3.5%] font-extrabold leading-none truncate"
        style={{
          fontFamily: "'Raleway', 'Trebuchet MS', sans-serif",
          color: colors.blueDeep,
        }}
      >
        {kpi.value}
      </span>
      {kpi.delta && (
        <span
          className="text-[1.4%] font-semibold flex items-center gap-[4%]"
          style={{ color: trendColor }}
        >
          <span>{trendArrow}</span>
          <span>{kpi.delta}</span>
        </span>
      )}
    </div>
  );
}

// ── Insights List ─────────────────────────────────────────────────────────────

function InsightsList({ insights }: { insights: string[] }) {
  return (
    <ul className="flex flex-col gap-[1.5%] mt-[2%]">
      {insights.map((insight, i) => (
        <li key={i} className="flex items-start gap-[1.5%]">
          <span
            className="text-[1.6%] mt-[0.3%] flex-shrink-0"
            style={{ color: colors.blueSignature }}
          >
            •
          </span>
          <span className="text-[1.6%] leading-snug" style={{ color: "#333" }}>
            {insight}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── Chart — simple bar visualization ─────────────────────────────────────────

function ChartBlock({ chart }: { chart: ChartData }) {
  // Extract numeric rows for a basic bar chart
  const entries = Object.entries(chart.data).filter(
    ([, v]) => typeof v === "number"
  ) as [string, number][];

  if (entries.length === 0) {
    return (
      <div
        className="text-[1.4%] italic mt-[2%]"
        style={{ color: colors.caption }}
      >
        Chart data unavailable
      </div>
    );
  }

  const max = Math.max(...entries.map(([, v]) => v));

  if (chart.type === "bar" || chart.type === "funnel") {
    return (
      <div className="mt-[2%] flex flex-col gap-[1%]">
        {entries.map(([label, value]) => {
          const pct = max > 0 ? (value / max) * 100 : 0;
          return (
            <div key={label} className="flex items-center gap-[2%]">
              <span
                className="text-[1.3%] text-right flex-shrink-0"
                style={{ width: "18%", color: "#555" }}
              >
                {label}
              </span>
              <div className="flex-1 h-[1.5vh] rounded-sm overflow-hidden bg-gray-100">
                <div
                  className="h-full rounded-sm transition-all"
                  style={{
                    width: `${pct}%`,
                    background: colors.blueSignature,
                  }}
                />
              </div>
              <span
                className="text-[1.3%] flex-shrink-0"
                style={{ width: "12%", color: "#333", textAlign: "right" }}
              >
                {value.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  // Fallback: simple data table
  return (
    <div className="mt-[2%] overflow-auto">
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "1.2%" }}>
        <tbody>
          {entries.map(([label, value]) => (
            <tr key={label}>
              <td
                style={{
                  padding: "2px 6px",
                  color: "#555",
                  borderBottom: "1px solid #eee",
                }}
              >
                {label}
              </td>
              <td
                style={{
                  padding: "2px 6px",
                  fontWeight: 600,
                  color: colors.blueDeep,
                  textAlign: "right",
                  borderBottom: "1px solid #eee",
                }}
              >
                {value.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Recommendation Box ────────────────────────────────────────────────────────

function RecommendationBox({ text }: { text: string }) {
  return (
    <div
      className="mt-[2%] rounded-md px-[3%] py-[2%] flex items-start gap-[2%]"
      style={{
        background: "#EFF6FF",
        borderLeft: `4px solid ${colors.blueSignature}`,
      }}
    >
      <span className="text-[1.8%] flex-shrink-0" style={{ color: colors.blueSignature }}>
        ➜
      </span>
      <span className="text-[1.5%] font-medium leading-snug" style={{ color: colors.blueDeep }}>
        {text}
      </span>
    </div>
  );
}

// ── Severity indicator ────────────────────────────────────────────────────────

function severityStyles(severity: SlideSeverity) {
  switch (severity) {
    case "alert":
      return {
        border: "2px solid #C53929",
        background: "#FFF5F5",
        badge: { bg: "#C53929", text: "ALERT" },
      };
    case "warning":
      return {
        border: "2px solid #F59E0B",
        background: "#FFFBEB",
        badge: { bg: "#F59E0B", text: "WARNING" },
      };
    case "ok":
      return {
        border: "2px solid #0B8043",
        background: "#F0FDF4",
        badge: { bg: "#0B8043", text: "OK" },
      };
  }
}

// ── Slide title area ─────────────────────────────────────────────────────────

function SlideHeader({
  title,
  subtitle,
  severity,
  slideNumber,
}: {
  title: string;
  subtitle?: string;
  severity?: SlideSeverity;
  slideNumber?: number;
}) {
  return (
    <div className="flex items-start justify-between mb-[2%]">
      <div>
        <h2
          className="text-[2.8%] font-extrabold leading-tight"
          style={{
            fontFamily: "'Raleway', 'Trebuchet MS', sans-serif",
            color: colors.blueDeep,
          }}
        >
          {title}
        </h2>
        {subtitle && (
          <p
            className="text-[1.5%] mt-[0.5%]"
            style={{ color: colors.caption }}
          >
            {subtitle}
          </p>
        )}
      </div>
      <div className="flex items-center gap-[2%] flex-shrink-0 ml-[2%]">
        {severity && severity !== "ok" && (
          <span
            className="text-[1.1%] font-bold uppercase tracking-wider px-[4%] py-[1%] rounded-full"
            style={{
              background: severityStyles(severity).badge.bg,
              color: "#fff",
            }}
          >
            {severityStyles(severity).badge.text}
          </span>
        )}
        {slideNumber != null && (
          <span className="text-[1.2%]" style={{ color: colors.caption }}>
            #{slideNumber}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Divider ───────────────────────────────────────────────────────────────────

function Divider() {
  return (
    <div
      className="w-full h-[1px] mb-[2%]"
      style={{ backgroundColor: colors.caption, opacity: 0.4 }}
    />
  );
}

// ── Type badge ────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  overview: "Overview",
  performance: "Performance",
  creative: "Creative",
  funnel: "Funnel",
  alert: "Alert",
  recommendation: "Recommendation",
  comparison: "Comparison",
};

// ── Main DynamicSlide component ───────────────────────────────────────────────

export interface DynamicSlideProps {
  slide: SlideData;
  slideNumber?: number;
  className?: string;
}

export function DynamicSlide({ slide, slideNumber, className }: DynamicSlideProps) {
  const hasSeverity = !!slide.severity;
  const sev = slide.severity;
  const sevStyle = sev ? severityStyles(sev) : null;

  // Accent colour: alert slides get a red tint via border override, others blue
  const accent: "blue" | "violet" | undefined =
    slide.type === "recommendation" ? "violet" : "blue";

  return (
    <SlideShell
      accent={accent}
      slideNumber={slideNumber}
      className={cn(
        className,
        hasSeverity && sev !== "ok" ? "ring-2" : "",
        sev === "alert" ? "ring-red-500" : sev === "warning" ? "ring-yellow-400" : ""
      )}
      source={`${TYPE_LABELS[slide.type] ?? slide.type} · Impulse Analytics`}
    >
      {/* Optional severity overlay tint */}
      {sevStyle && sev !== "ok" && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: sevStyle.background, opacity: 0.25 }}
        />
      )}

      <div className="relative flex flex-col h-full">
        <SlideHeader
          title={slide.title}
          subtitle={slide.subtitle}
          severity={slide.severity}
          slideNumber={slideNumber}
        />
        <Divider />

        {/* KPIs */}
        {slide.kpis && slide.kpis.length > 0 && (
          <div
            className="grid gap-[2%] mb-[2%]"
            style={{
              gridTemplateColumns: `repeat(${Math.min(slide.kpis.length, 4)}, 1fr)`,
            }}
          >
            {slide.kpis.map((kpi, i) => (
              <KpiCard key={i} kpi={kpi} />
            ))}
          </div>
        )}

        {/* Chart */}
        {slide.chart && <ChartBlock chart={slide.chart} />}

        {/* Insights */}
        {slide.insights && slide.insights.length > 0 && (
          <InsightsList insights={slide.insights} />
        )}

        {/* Recommendation */}
        {slide.recommendation && (
          <RecommendationBox text={slide.recommendation} />
        )}
      </div>
    </SlideShell>
  );
}
