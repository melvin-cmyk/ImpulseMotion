"use client";

import { cn } from "@/lib/utils";
import { SlideShell } from "./slide-shell";
import type { SlideData, SlideImage, SlideTable, KPI, ChartData, SlideSeverity, LayoutBlock } from "@/types/deck";

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

// Editable text helper — click to edit any text in the slide
const editable = { contentEditable: true, suppressContentEditableWarning: true, style: { outline: "none", cursor: "text" } as React.CSSProperties, className: "focus:ring-1 focus:ring-blue-300 focus:bg-blue-50/20 rounded-sm" };

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
        {...editable}
        className={`font-semibold uppercase tracking-wider ${editable.className}`}
        style={{ ...editable.style, color: "#8A9BB5", fontSize: "max(1.4%, 11px)", letterSpacing: "0.05em" }}
      >
        {kpi.label}
      </span>
      <span
        {...editable}
        className={`font-extrabold leading-tight ${editable.className}`}
        style={{
          ...editable.style,
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
          <span {...editable} style={editable.style}>{kpi.delta}</span>
        </span>
      )}
    </div>
  );
}

// ── Insights List ─────────────────────────────────────────────────────────────

function InsightsList({ insights }: { insights: string[] }) {
  // Scale font down when there are many insights to prevent overflow
  const fontSize = insights.length > 4 ? "max(1.2%, 9px)" : "max(1.5%, 11px)";
  const padding = insights.length > 4 ? "px-2 py-1" : "px-3 py-1.5";
  return (
    <div className="mt-2 rounded-lg border overflow-hidden" style={{ borderColor: "#E8EDF3" }}>
      {insights.map((insight, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 ${padding}`}
          style={{ borderBottom: i < insights.length - 1 ? "1px solid #E8EDF3" : "none", background: i % 2 === 0 ? "#FAFBFD" : "#fff" }}
        >
          <span
            className="mt-0.5 flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
            style={{ background: colors.blueSignature, color: "#fff", fontSize: "8px", fontWeight: 700 }}
          >
            {i + 1}
          </span>
          <span {...editable} className={`leading-snug ${editable.className}`} style={{ ...editable.style, color: "#333", fontSize }}>
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
  const cols = Math.min(images.length, 3);
  return (
    <div
      className="grid gap-2 mt-2"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {images.map((img, i) => (
        <div
          key={i}
          className="flex flex-col rounded-lg overflow-hidden border"
          style={{ background: "#fff", borderColor: "#E8EDF3" }}
        >
          {/* Creative image — card style like MBR Top Performers */}
          <div
            className="relative w-full overflow-hidden"
            style={{ paddingBottom: cols >= 3 ? "90%" : "65%", background: "#F5F7FA" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.url.startsWith("http") ? `/api/deck/proxy-image?url=${encodeURIComponent(img.url)}` : img.url}
              alt={img.label ?? `Creative ${i + 1}`}
              className="absolute inset-0 w-full h-full object-contain"
              onError={(e) => {
                const target = e.currentTarget;
                target.style.display = "none";
                const fb = target.nextElementSibling as HTMLElement;
                if (fb) fb.style.display = "flex";
              }}
            />
            <div className="absolute inset-0 flex-col items-center justify-center gap-1 hidden" style={{ background: "#F5F7FA" }}>
              <span style={{ fontSize: "max(2%, 16px)" }}>🖼️</span>
            </div>
          </div>
          {/* Name + metrics underneath */}
          <div className="px-1.5 py-1 border-t" style={{ borderColor: "#E8EDF3" }}>
            {img.label && (
              <p className="font-semibold leading-tight truncate" style={{ color: colors.blueDeep, fontSize: "max(1.1%, 9px)" }}>
                {img.label}
              </p>
            )}
            {img.metrics && (
              <p className="mt-0.5 leading-snug" style={{ color: "#666", fontSize: "max(0.9%, 8px)" }}>
                {img.metrics}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Data Table (MBR style) ────────────────────────────────────────────────────

function DataTableBlock({ table }: { table: SlideTable }) {
  return (
    <div className="mt-2 rounded-lg border overflow-hidden" style={{ borderColor: "#E8EDF3" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {table.headers.map((h, i) => (
              <th
                key={i}
                contentEditable={true}
                suppressContentEditableWarning={true}
                style={{
                  padding: "5px 8px",
                  background: colors.blueDeep,
                  color: "#fff",
                  fontWeight: 600,
                  textAlign: i === 0 ? "left" : "right",
                  fontSize: "max(1.1%, 9px)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  whiteSpace: "nowrap",
                  outline: "none",
                  cursor: "text",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr
              key={ri}
              style={{
                background: row.highlight ? "#EFF6FF" : ri % 2 === 0 ? "#FAFBFD" : "#fff",
                fontWeight: row.isHeader ? 700 : 400,
              }}
            >
              {row.cells.map((cell, ci) => (
                <td
                  key={ci}
                  contentEditable={true}
                  suppressContentEditableWarning={true}
                  style={{
                    padding: "4px 8px",
                    textAlign: ci === 0 ? "left" : "right",
                    borderBottom: "1px solid #E8EDF3",
                    fontSize: "max(1%, 9px)",
                    color: cell.startsWith("+") ? colors.deltaPos : cell.startsWith("-") ? colors.deltaNeg : ci === 0 ? "#333" : colors.blueDeep,
                    fontWeight: cell.startsWith("+") || cell.startsWith("-") ? 600 : ci === 0 ? 500 : 600,
                    fontFamily: ci > 0 ? "'Raleway', sans-serif" : "inherit",
                    whiteSpace: "nowrap",
                    outline: "none",
                    cursor: "text",
                  }}
                  className="focus:ring-1 focus:ring-blue-300 focus:bg-blue-50/30 rounded-sm"
                >
                  {cell}
                </td>
              ))}
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
      className="mt-2 rounded-lg px-3 py-2 flex items-start gap-2"
      style={{
        background: "linear-gradient(135deg, #EFF6FF, #F0F0FF)",
        borderLeft: `4px solid ${colors.blueSignature}`,
      }}
    >
      <span className="flex-shrink-0" style={{ color: colors.blueSignature, fontSize: "max(1.8%, 13px)" }}>
        ➜
      </span>
      <span {...editable} className={`font-medium leading-snug ${editable.className}`} style={{ ...editable.style, color: colors.blueDeep, fontSize: "max(1.5%, 11px)" }}>
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
          <span {...editable} style={editable.style}>{title}</span>
        </h2>
        {subtitle && (
          <p
            className="mt-0.5"
            style={{ color: colors.caption, fontSize: "max(1.5%, 10px)" }}
          >
            <span {...editable} style={editable.style}>{subtitle}</span>
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
  custom: "Custom",
};

// ── Freeform block renderer ───────────────────────────────────────────────────

function BlockRenderer({ block }: { block: LayoutBlock }) {
  switch (block.kind) {
    case "heading": {
      const level = block.level ?? 2;
      const sizeMap: Record<number, string> = { 1: "max(3.2%, 22px)", 2: "max(2.4%, 18px)", 3: "max(1.9%, 15px)" };
      return (
        <div
          className="font-extrabold mb-2"
          style={{
            fontFamily: "'Raleway', 'Trebuchet MS', sans-serif",
            color: colors.blueSignature,
            fontSize: sizeMap[level],
            textAlign: block.align ?? "left",
          }}
        >
          {block.text}
        </div>
      );
    }
    case "paragraph":
      return (
        <p
          className="mb-2"
          style={{ fontSize: "max(1.5%, 12px)", color: "#1a1a1a", textAlign: block.align ?? "left", lineHeight: 1.5 }}
        >
          {block.text}
        </p>
      );
    case "kpis": {
      const cols = Math.min(block.columns ?? block.items.length, 4);
      return (
        <div
          className="grid gap-2 mb-2"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {block.items.map((kpi, i) => <KpiCard key={i} kpi={kpi} />)}
        </div>
      );
    }
    case "table":
      return <DataTableBlock table={{ headers: block.headers, rows: block.rows }} />;
    case "bullets": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          className={cn("mb-2 pl-5", block.ordered ? "list-decimal" : "list-disc")}
          style={{ fontSize: "max(1.5%, 12px)", color: "#1a1a1a", lineHeight: 1.6 }}
        >
          {block.items.map((it, i) => <li key={i} className="mb-1">{it}</li>)}
        </Tag>
      );
    }
    case "callout": {
      const toneMap = {
        info: { bg: colors.bgAlt, border: colors.blueSignature, icon: "ℹ️" },
        warning: { bg: colors.warningBg, border: colors.warningBorder, icon: "⚠️" },
        success: { bg: colors.okBg, border: colors.okBorder, icon: "✅" },
        alert: { bg: colors.alertBg, border: colors.alertBorder, icon: "🚨" },
      } as const;
      const tone = toneMap[block.tone ?? "info"];
      return (
        <div
          className="rounded-md border-l-4 px-3 py-2 mb-2"
          style={{ backgroundColor: tone.bg, borderLeftColor: tone.border, fontSize: "max(1.5%, 12px)" }}
        >
          <span className="mr-1">{tone.icon}</span>
          {block.text}
        </div>
      );
    }
    case "images": {
      const cols = Math.min(block.columns ?? block.items.length, 4);
      return (
        <div
          className="grid gap-2 mb-2"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {block.items.map((img, i) => (
            <div key={i} className="rounded overflow-hidden border flex flex-col" style={{ borderColor: "#E8EDF3" }}>
              <div className="aspect-[4/3] bg-gray-100 overflow-hidden">
                {img.url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/deck/proxy-image?url=${encodeURIComponent(img.url)}`}
                    alt={img.label ?? ""}
                    className="w-full h-full object-cover"
                  />
                )}
              </div>
              {(img.label || img.metrics) && (
                <div className="p-1.5" style={{ fontSize: "max(1.1%, 10px)" }}>
                  {img.label && <div className="font-semibold truncate">{img.label}</div>}
                  {img.metrics && <div style={{ color: colors.caption }}>{img.metrics}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      );
    }
    case "spacer": {
      const h = block.size === "lg" ? "h-4" : block.size === "md" ? "h-3" : "h-2";
      return <div className={h} aria-hidden />;
    }
    case "columns": {
      const ratioMap = { "1:1": "1fr 1fr", "1:2": "1fr 2fr", "2:1": "2fr 1fr" } as const;
      return (
        <div
          className="grid gap-3 mb-2"
          style={{ gridTemplateColumns: ratioMap[block.ratio ?? "1:1"] }}
        >
          <div className="min-w-0 flex flex-col">
            {block.left.map((b, i) => <BlockRenderer key={i} block={b} />)}
          </div>
          <div className="min-w-0 flex flex-col">
            {block.right.map((b, i) => <BlockRenderer key={i} block={b} />)}
          </div>
        </div>
      );
    }
  }
}

// ── Main DynamicSlide component ───────────────────────────────────────────────

export interface DynamicSlideProps {
  slide: SlideData;
  slideNumber?: number;
  className?: string;
}

export function DynamicSlide({ slide, slideNumber, className }: DynamicSlideProps) {
  const sev = slide.severity;
  const isAlert = sev === "alert" || slide.type === "alert";
  const isRecommendation = slide.type === "recommendation";

  // Accent colour: explicit slide.accent wins, then legacy per-type default
  const accent: "blue" | "violet" | undefined =
    slide.accent ?? (slide.type === "recommendation" ? "violet" : "blue");

  const hasBlocks = Array.isArray(slide.blocks) && slide.blocks.length > 0;

  // Severity container style — no colored backgrounds, just clean layout
  const severityContainerStyle: React.CSSProperties = {};

  // Prefix icon for title
  const titlePrefix = isAlert ? "⚠️ " : isRecommendation ? "💡 " : "";

  return (
    <SlideShell
      accent={accent}
      slideNumber={slideNumber}
      className={cn(className)}
      source={`${TYPE_LABELS[slide.type] ?? slide.type} · Impulse Analytics`}
    >
      <div className="relative flex flex-col h-full overflow-auto" style={severityContainerStyle}>
        <SlideHeader
          title={`${titlePrefix}${slide.title}`}
          subtitle={slide.subtitle}
          severity={slide.severity}
          slideNumber={slideNumber}
        />
        <Divider />

        {/* Freeform block composition — takes precedence over legacy fields */}
        {hasBlocks && (
          <div className="flex-1 min-h-0 flex flex-col">
            {(slide.blocks as LayoutBlock[]).map((block, i) => (
              <BlockRenderer key={i} block={block} />
            ))}
          </div>
        )}

        {/* Legacy structured fields — only when no blocks were supplied */}
        {!hasBlocks && (
          <>
            {slide.kpis && slide.kpis.length > 0 && (
              <div
                className="grid gap-2 mb-2"
                style={{ gridTemplateColumns: `repeat(${Math.min(slide.kpis.length, 4)}, 1fr)` }}
              >
                {slide.kpis.map((kpi, i) => <KpiCard key={i} kpi={kpi} />)}
              </div>
            )}
            {slide.chart && <ChartBlock chart={slide.chart} />}
            {slide.table && <DataTableBlock table={slide.table} />}
            {slide.images && slide.images.length > 0 && <ImageGallery images={slide.images} />}
            {slide.insights && slide.insights.length > 0 && (slide.kpis?.length || slide.chart || slide.images?.length) && (
              <SectionDivider label="Analyse" />
            )}
            {slide.insights && slide.insights.length > 0 && <InsightsList insights={slide.insights} />}
            {slide.recommendation && <RecommendationBox text={slide.recommendation} />}
          </>
        )}
      </div>
    </SlideShell>
  );
}
