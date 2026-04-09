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
  | "comparison";

export type SlideSeverity = "ok" | "warning" | "alert";

export interface SlideImage {
  url: string;
  label?: string;
  /** Optional metrics displayed below the image */
  metrics?: string;
}

export interface SlideData {
  id: string;
  type: SlideType;
  title: string;
  subtitle?: string;
  kpis?: KPI[];
  insights?: string[];
  chart?: ChartData;
  recommendation?: string;
  severity?: SlideSeverity;
  /** Creative/ad images to display (thumbnails from Meta Ads etc.) */
  images?: SlideImage[];
}
