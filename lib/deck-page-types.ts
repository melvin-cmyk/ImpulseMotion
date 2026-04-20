/**
 * Shared types & constants for the /deck page.
 * Extracted from app/deck/page.tsx to keep the page orchestrator thin.
 */
import type React from "react";
import type { DeckData } from "@/lib/deck-data";

// ── Slide config used by buildSlides() ───────────────────────────────────────
export interface SlideConfig {
  id: string;
  label: string;
  section: number;
  /** true for dark-background slides (cover, section dividers) */
  dark?: boolean;
  render: (
    data: DeckData,
    slideNumber: number,
    editCallbacks?: {
      onEdit?: (field: string, slideIndex: number, newValue: string) => void;
      getOverride?: (slideIndex: number, field: string) => string | undefined;
    }
  ) => React.ReactNode;
}

// ── Dropped block (chat output dragged onto the canvas) ──────────────────────
export interface DroppedBlock {
  id: string;
  content: string;
  /** absolute index in the page slide list at drop time */
  slideIndex: number;
  /**
   * Slide group at drop time — lets the export resolve correctly when
   * the page slide count differs from the export slide count (e.g. when
   * the page filtered out the Google section but the export still adds it).
   */
  kind?: "standard" | "custom" | "ai";
  /** index within the kind group */
  localIdx?: number;
  /** % of canvas width */
  x: number;
  /** % of canvas height */
  y: number;
  /** % of canvas width */
  w: number;
  /** % of canvas height (auto if undefined) */
  h?: number;
  fontFamily?: string;
  textColor?: string;
  fontSize?: number;
}

// ── Inline override for a generated slide's text field ───────────────────────
export interface SlideOverride {
  slideIndex: number;
  field: string;
  value: string;
}

// ── Pagination config for list-style slides ──────────────────────────────────
export const TOP_CREATIVES_PER_SLIDE = 3;
export const CAMPAIGNS_PER_SLIDE = 8;
/**
 * Keep learnings/next-steps lists short enough that each card can breathe
 * inside a 16:9 slide. Above this count, buildSlides emits additional pages
 * to prevent any card from being clipped by the slide footer.
 */
export const BULLETS_PER_SLIDE = 5;

// ── Section labels / colors for the filmstrip groups ─────────────────────────
export const SECTION_LABELS = [
  "Intro",
  "Vue Globale",
  "Google Ads",
  "Meta Ads",
  "Next Steps & Budget",
  "Google Analytics",
];

export const SECTION_COLORS: Record<number, string> = {
  0: "#2CA6F9",
  1: "#2CA6F9",
  2: "#2CA6F9",
  3: "#7F5AFD",
  4: "#2CA6F9",
  5: "#34A853",
};

// ── Slide-kind resolver (pure) ───────────────────────────────────────────────
/**
 * Map an absolute page slide index to its kind ("standard"/"custom"/"ai")
 * and local index within that group.
 */
export function resolveSlideKind(
  absIdx: number,
  counts: { standard: number; custom: number }
): { kind: "standard" | "custom" | "ai"; localIdx: number } {
  if (absIdx < counts.standard) return { kind: "standard", localIdx: absIdx };
  if (absIdx < counts.standard + counts.custom)
    return { kind: "custom", localIdx: absIdx - counts.standard };
  return { kind: "ai", localIdx: absIdx - counts.standard - counts.custom };
}
