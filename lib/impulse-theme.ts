/**
 * Impulse Analytics Design System — constants for slide rendering & PPTX export.
 */

// ── Colours ──────────────────────────────────────────────────────────────────
export const IA = {
  // Backgrounds
  bgWhite: "#FFFFFF",
  bgAlt: "#F2F9FE",
  bgRowAlt: "#F3F3F3",
  bgDark: "#0944A1",

  // Accents
  blue: "#2CA6F9",
  blueDeep: "#0070C0",
  blueDark: "#0944A1",
  violet: "#7F5AFD",
  violetAlt: "#4F6EFF",

  // Text
  textBlack: "#000000",
  textCaption: "#CCCCCC",
  textWhite: "#FFFFFF",

  // Deltas
  deltaPos: "#0B8043",
  deltaNeg: "#C53929",

  // Table
  tableHeader: "#0070C0",
  tableTotal: "#F2F9FE",
  tableTotalText: "#0944A1",
} as const

// ── Typography (for PPTX) ─────────────────────────────────────────────────
export const FONTS = {
  title: "Trebuchet MS",       // fallback for Raleway ExtraBold
  kpi: "Arial Black",          // fallback for Mulish Black
  body: "Calibri",             // fallback for Open Sans
} as const

// ── Sizes (points, for PPTX) ──────────────────────────────────────────────
export const SIZES = {
  titleMain: 26,
  subtitle: 15,
  kpi: 40,
  body: 11,
  caption: 8,
  tableHeader: 10,
  tableBody: 9,
} as const

// ── Layout (inches, 16:9) ─────────────────────────────────────────────────
export const LAYOUT = {
  width: 13.33,
  height: 7.5,
  marginX: 0.35,
  contentY: 1.0,
  footerY: 7.2,
  barWidth: 0.06, // 7px ≈ 0.06"
} as const

// ── Section colours ───────────────────────────────────────────────────────
export type SectionId = "global" | "google" | "meta" | "next"
export const SECTION_BAR: Record<SectionId, string> = {
  global: IA.blue,
  google: IA.blue,
  meta: IA.violet,
  next: IA.blue,
}
export const SECTION_LABELS: Record<SectionId, string> = {
  global: "Global Overview",
  google: "Focus Google Ads",
  meta: "Focus Meta Ads",
  next: "Next Steps & Budget",
}

// ── MBR Section structure ─────────────────────────────────────────────────
export interface MBRConfig {
  clientName: string
  periodLabel: string       // e.g. "Mars 2026"
  periodPrevLabel: string   // e.g. "Février 2026"
  month: string             // e.g. "2026-03"
  monthPrev: string         // e.g. "2026-02"
}
