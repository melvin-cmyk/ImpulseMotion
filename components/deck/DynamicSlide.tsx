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
  alertBg: "#FFF8F8",
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
      className="flex flex-col gap-0.5 rounded-lg px-3 py-2 border"
      style={{ background: "#fff", borderColor: "#E8EDF3", minWidth: 0 }}
    >
      <span
        className="font-semibold uppercase tracking-wider"
        style={{ color: "#8A9BB5", fontSize: "max(1.4%, 11px)", letterSpacing: "0.05em" }}
      >
        {kpi.label}
      </span>
      <span
        className="font-extrabold leading-tight"
        style={{
          fontFamily: "'Raleway', 'Trebuchet MS', sans-serif",
          color: colors.blueDeep,
          fontSize: "max(3.8%, 20px)",
        }}
      >
        {kpi.value}
      </span>
      {kpi.delta && (
        <span
          className="font-semibold flex items-center gap-1 rounded-full px-1.5 py-0.5 w-fit"
          style={{
            color: trendColor,
            fontSize: "max(1.3%, 10px)",
            background: kpi.trend === "up" ? "#E8F5E9" : kpi.trend === "down" ? "#FFEBEE" : "#F5F5F5",
          }}
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
    <div className="mt-2 rounded-lg border overflow-hidden" style={{ borderColor: "#E8EDF3" }}>
      {insights.map((insight, i) => (
        <div
          key={i}
          className="flex items-start gap-2 px-3 py-1.5"
          style={{ borderBottom: i < insights.length - 1 ? "1px solid #E8EDF3" : "none", background: i % 2 === 0 ? "#FAFBFD" : "#fff" }}
        >
          <span
            className="mt-0.5 flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
            style={{ background: colors.blueSignature, color: "#fff", fontSize: "8px", fontWeight: 700 }}
          >
            {i + 1}
          </span>
          <span className="leading-snug" style={{ color: "#333", fontSize: "max(1.5%, 11px)" }}>
            {insight}
          </span>
        </div>
      ))}
    </div>
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
    const barColors = ["#2CA6F9", "#0944A1", "#7F5AFD", "#00C49F", "#FF8042", "#8884D8"];
    return (
      <div className="mt-2 flex flex-col gap-1.5 rounded-lg border p-2" style={{ borderColor: "#E8EDF3" }}>
        {entries.map(([label, value], idx) => {
          const pct = max > 0 ? (value / max) * 100 : 0;
          return (
            <div key={label} className="flex items-center gap-2">
              <span
                className="text-right flex-shrink-0 font-medium"
                style={{ width: "20%", color: "#555", fontSize: "max(1.3%, 10px)" }}
              >
                {label}
              </span>
              <div className="flex-1 h-5 rounded overflow-hidden" style={{ background: "#F0F4F8" }}>
                <div
                  className="h-full rounded transition-all"
                  style={{
                    width: `${Math.max(pct, 2)}%`,
                    background: `linear-gradient(90deg, ${barColors[idx % barColors.length]}CC, ${barColors[idx % barColors.length]})`,
                  }}
                />
              </div>
              <span
                className="flex-shrink-0 font-semibold tabular-nums"
                style={{ width: "14%", color: "#333", textAlign: "right", fontSize: "max(1.3%, 10px)" }}
              >
                {value.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  // Fallback: MBR-style data table (inspired by Impulse Analytics MBR decks)
  return (
    <div className="mt-2 overflow-auto rounded-lg border" style={{ borderColor: "#E8EDF3" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "max(1.2%, 10px)" }}>
        <thead>
          <tr>
            <th style={{ padding: "6px 10px", background: colors.blueDeep, color: "#fff", fontWeight: 600, textAlign: "left", fontSize: "max(1.1%, 9px)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Métrique
            </th>
            <th style={{ padding: "6px 10px", background: colors.blueDeep, color: "#fff", fontWeight: 600, textAlign: "right", fontSize: "max(1.1%, 9px)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Valeur
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([label, value], idx) => (
            <tr key={label} style={{ background: idx % 2 === 0 ? "#FAFBFD" : "#fff" }}>
              <td style={{ padding: "5px 10px", color: "#333", fontWeight: 500, borderBottom: "1px solid #E8EDF3" }}>
                {label}
              </td>
              <td style={{ padding: "5px 10px", fontWeight: 700, color: colors.blueDeep, textAlign: "right", borderBottom: "1px solid #E8EDF3", fontFamily: "'Raleway', sans-serif" }}>
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
  const single = images.length === 1;
  const cols = single ? 1 : Math.min(images.length, 3);
  return (
    <div
      className={single ? "flex mt-2" : "grid gap-2 mt-2"}
      style={single ? {} : { gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {images.map((img, i) => (
        <div
          key={i}
          className={cn(
            "flex rounded-lg overflow-hidden",
            single ? "gap-3 items-start" : "flex-col gap-1"
          )}
          style={{ background: colors.bgAlt }}
        >
          {/* Image container — constrained to not overflow the slide */}
          <div
            className={cn(
              "relative flex-shrink-0 overflow-hidden rounded-lg",
              single ? "w-[40%]" : "w-full"
            )}
            style={{ paddingBottom: single ? "30%" : "75%" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.url.startsWith("http") ? `/api/deck/proxy-image?url=${encodeURIComponent(img.url)}` : img.url}
              alt={img.label ?? `Creative ${i + 1}`}
              className="absolute inset-0 w-full h-full object-contain bg-gray-50"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          </div>
          {(img.label || img.metrics) && (
            <div className={single ? "flex-1 py-1" : "px-2 py-1.5"}>
              {img.label && (
                <p className="font-semibold leading-tight" style={{ color: colors.blueDeep, fontSize: "max(1.3%, 11px)" }}>
                  {img.label}
                </p>
              )}
              {img.metrics && (
                <p className="mt-1" style={{ color: "#555", fontSize: "max(1.1%, 10px)", lineHeight: 1.5 }}>
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
      className="mt-2 rounded-lg px-3 py-2 flex items-start gap-2"
      style={{
        background: "linear-gradient(135deg, #EFF6FF, #F0F0FF)",
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

// ── Section divider (MBR style "// OVERVIEW") ─────────────────────────────────

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 mt-3 mb-1">
      <span className="font-bold uppercase tracking-wider" style={{ color: colors.blueDeep, fontSize: "max(1.3%, 10px)" }}>
        // {label}
      </span>
      <div className="flex-1 h-[2px]" style={{ background: `linear-gradient(90deg, ${colors.blueSignature}, transparent)` }} />
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
        hasSeverity && sev !== "ok" && sev !== "alert" ? "ring-2" : hasSeverity && sev === "alert" ? "ring-1" : "",
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
            className="grid gap-2 mb-2"
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

        {/* Section divider before insights */}
        {slide.insights && slide.insights.length > 0 && (slide.kpis?.length || slide.chart || slide.images?.length) && (
          <SectionDivider label="Analyse" />
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
