"use client";

import { cn } from "@/lib/utils";
import { SlideShell } from "./slide-shell";
import type { SlideData, SlideImage, KPI, ChartData, SlideSeverity } from "@/types/deck";

// ── Design tokens (matches slides.tsx) ───────────────────────────────────────

const colors = {
  blueDeep: "#0944A1",
  blueSignature: "#2CA6F9",
  violet: "#7F5AFD",
  deltaPos: "#0B8043",
  deltaNeg: "#C53929",
  bgAlt: "#F2F9FE",
  caption: "#CCCCCC",
  alertBg: "#FFF0F0",
  alertBorder: "#C53929",
  warningBg: "#FFFBEA",
  warningBorder: "#F9A825",
  okBg: "#F0FFF4",
  okBorder: "#0B8043",
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
      className="flex flex-col gap-1 rounded-lg px-3 py-2.5"
      style={{ background: colors.bgAlt, minWidth: 0 }}
    >
      <span
        className="font-semibold uppercase tracking-wider"
        style={{ color: colors.caption, fontSize: "max(1.4%, 10px)" }}
      >
        {kpi.label}
      </span>
      <span
        className="font-extrabold leading-tight"
        style={{
          fontFamily: "'Raleway', 'Trebuchet MS', sans-serif",
          color: colors.blueDeep,
          fontSize: "max(3.5%, 18px)",
        }}
      >
        {kpi.value}
      </span>
      {kpi.delta && (
        <span
          className="font-semibold flex items-center gap-1"
          style={{ color: trendColor, fontSize: "max(1.4%, 10px)" }}
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
    <ul className="flex flex-col gap-1 mt-2">
      {insights.map((insight, i) => (
        <li key={i} className="flex items-start gap-1.5">
          <span
            className="mt-0.5 flex-shrink-0"
            style={{ color: colors.blueSignature, fontSize: "max(1.6%, 11px)" }}
          >
            •
          </span>
          <span className="leading-snug" style={{ color: "#333", fontSize: "max(1.6%, 11px)" }}>
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
        className="italic mt-2"
        style={{ color: colors.caption, fontSize: "max(1.4%, 10px)" }}
      >
        Chart data unavailable
      </div>
    );
  }

  const max = Math.max(...entries.map(([, v]) => v));

  if (chart.type === "bar" || chart.type === "funnel") {
    return (
      <div className="mt-2 flex flex-col gap-1">
        {entries.map(([label, value]) => {
          const pct = max > 0 ? (value / max) * 100 : 0;
          return (
            <div key={label} className="flex items-center gap-2">
              <span
                className="text-right flex-shrink-0"
                style={{ width: "18%", color: "#555", fontSize: "max(1.3%, 10px)" }}
              >
                {label}
              </span>
              <div className="flex-1 h-4 rounded-sm overflow-hidden bg-gray-100">
                <div
                  className="h-full rounded-sm transition-all"
                  style={{
                    width: `${pct}%`,
                    background: colors.blueSignature,
                  }}
                />
              </div>
              <span
                className="flex-shrink-0"
                style={{ width: "12%", color: "#333", textAlign: "right", fontSize: "max(1.3%, 10px)" }}
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
    <div className="mt-2 overflow-auto">
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "max(1.2%, 10px)" }}>
        <tbody>
          {entries.map(([label, value]) => (
            <tr key={label}>
              <td
                style={{
                  padding: "4px 8px",
                  color: "#555",
                  borderBottom: "1px solid #eee",
                }}
              >
                {label}
              </td>
              <td
                style={{
                  padding: "4px 8px",
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

// ── Image Gallery (for creative/ad thumbnails) ──────────────────────────────

function ImageGallery({ images }: { images: SlideImage[] }) {
  const cols = Math.min(images.length, 3);
  return (
    <div
      className="grid gap-[2%] mt-[2%]"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {images.map((img, i) => (
        <div key={i} className="flex flex-col gap-[1%] rounded-md overflow-hidden" style={{ background: colors.bgAlt }}>
          <div className="relative w-full" style={{ paddingBottom: "100%" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.url.startsWith("http") ? `/api/deck/proxy-image?url=${encodeURIComponent(img.url)}` : img.url}
              alt={img.label ?? `Creative ${i + 1}`}
              className="absolute inset-0 w-full h-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          </div>
          {(img.label || img.metrics) && (
            <div className="px-2 py-1.5">
              {img.label && (
                <p className="font-semibold leading-tight truncate" style={{ color: colors.blueDeep, fontSize: "max(1.3%, 10px)" }}>
                  {img.label}
                </p>
              )}
              {img.metrics && (
                <p className="mt-0.5" style={{ color: "#555", fontSize: "max(1.1%, 9px)" }}>
                  {img.metrics}
                </p>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Recommendation Box ────────────────────────────────────────────────────────

function RecommendationBox({ text }: { text: string }) {
  return (
    <div
      className="mt-2 rounded-md px-3 py-2 flex items-start gap-2"
      style={{
        background: "#EFF6FF",
        borderLeft: `4px solid ${colors.blueSignature}`,
      }}
    >
      <span className="flex-shrink-0" style={{ color: colors.blueSignature, fontSize: "max(1.8%, 13px)" }}>
        ➜
      </span>
      <span className="font-medium leading-snug" style={{ color: colors.blueDeep, fontSize: "max(1.5%, 11px)" }}>
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
    <div className="flex items-start justify-between mb-2">
      <div className="min-w-0 flex-1">
        <h2
          className="font-extrabold leading-tight"
          style={{
            fontFamily: "'Raleway', 'Trebuchet MS', sans-serif",
            color: colors.blueDeep,
            fontSize: "max(2.8%, 16px)",
          }}
        >
          {title}
        </h2>
        {subtitle && (
          <p
            className="mt-0.5"
            style={{ color: colors.caption, fontSize: "max(1.5%, 10px)" }}
          >
            {subtitle}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
        {severity && severity !== "ok" && (
          <span
            className="font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
            style={{
              background: severityStyles(severity).badge.bg,
              color: "#fff",
              fontSize: "max(1.1%, 9px)",
            }}
          >
            {severityStyles(severity).badge.text}
          </span>
        )}
        {slideNumber != null && (
          <span style={{ color: colors.caption, fontSize: "max(1.2%, 9px)" }}>
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
      className="w-full h-[1px] mb-2"
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
  const isAlert = sev === "alert" || slide.type === "alert";
  const isWarning = sev === "warning";
  const isOk = sev === "ok";
  const isRecommendation = slide.type === "recommendation";

  // Accent colour: alert slides get a red tint via border override, others blue
  const accent: "blue" | "violet" | undefined =
    slide.type === "recommendation" ? "violet" : "blue";

  // Compute inline style overrides for severity-based background + left border
  const severityContainerStyle: React.CSSProperties = isAlert
    ? { background: colors.alertBg, borderLeft: `4px solid ${colors.alertBorder}` }
    : isWarning
    ? { background: colors.warningBg, borderLeft: `4px solid ${colors.warningBorder}` }
    : isOk
    ? { background: colors.okBg, borderLeft: `4px solid ${colors.okBorder}` }
    : {};

  // Prefix icon for title
  const titlePrefix = isAlert ? "⚠️ " : isRecommendation ? "💡 " : "";

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
      {sevStyle && sev !== "ok" && !isAlert && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: sevStyle.background, opacity: 0.25 }}
        />
      )}

      <div className="relative flex flex-col h-full" style={severityContainerStyle}>
        <SlideHeader
          title={`${titlePrefix}${slide.title}`}
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

        {/* Creative images */}
        {slide.images && slide.images.length > 0 && (
          <ImageGallery images={slide.images} />
        )}

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
