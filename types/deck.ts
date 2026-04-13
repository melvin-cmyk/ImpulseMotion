/**
 * Shared types for the dynamic slide renderer.
 * These mirror the Slide interface produced by /api/deck/generate.
 */

export interface KPI {
  label: string;
  value: string;
  delta?: string;
  trend?: "up" | "down" | "flat";
}

export interface ChartData {
  type: "bar" | "line" | "pie" | "funnel";
  data: Record<string, unknown>;
}

export type SlideType =
  | "overview"
  | "performance"
  | "creative"
  | "funnel"
  | "alert"
  | "recommendation"
  | "comparison"
  | "custom";

export type SlideSeverity = "ok" | "warning" | "alert";

export interface SlideImage {
  url: string;
  label?: string;
  /** Optional metrics displayed below the image */
  metrics?: string;
}

export interface SlideTableRow {
  cells: string[];
  isHeader?: boolean;
  highlight?: boolean;
}

export interface SlideTable {
  headers: string[];
  rows: SlideTableRow[];
}

/**
 * Freeform layout blocks — let the AI compose slides from design-system
 * primitives instead of picking from a fixed template. Blocks render in
 * vertical order using the same typography tokens as the static slides.
 */
export type LayoutBlock =
  | { kind: "heading"; text: string; level?: 1 | 2 | 3; align?: "left" | "center" }
  | { kind: "paragraph"; text: string; align?: "left" | "center" }
  | { kind: "kpis"; items: KPI[]; columns?: number }
  | { kind: "table"; headers: string[]; rows: SlideTableRow[] }
  | { kind: "bullets"; items: string[]; ordered?: boolean }
  | { kind: "callout"; text: string; tone?: "info" | "warning" | "success" | "alert" }
  | { kind: "images"; items: SlideImage[]; columns?: number }
  | { kind: "spacer"; size?: "sm" | "md" | "lg" }
  | { kind: "columns"; left: LayoutBlock[]; right: LayoutBlock[]; ratio?: "1:1" | "1:2" | "2:1" };

export interface SlideData {
  id: string;
  type: SlideType;
  title: string;
  subtitle?: string;
  kpis?: KPI[];
  insights?: string[];
  chart?: ChartData;
  table?: SlideTable;
  recommendation?: string;
  severity?: SlideSeverity;
  /** Creative/ad images to display (thumbnails from Meta Ads etc.) */
  images?: SlideImage[];
  /** Freeform block list. When present, the renderer uses it instead of the */
  /** legacy kpis/table/images/insights/recommendation fields. */
  blocks?: LayoutBlock[];
  /** Optional accent color override for the slide shell */
  accent?: "blue" | "violet";
}
